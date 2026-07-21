import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { v7 as uuidv7 } from 'uuid';

import type { ThreadLaunchProfile } from '@telos/code-contracts/telos';
import { GitService } from './GitService.js';
import { ThreadStore } from './thread-store/ThreadStore.js';
import { WorkspaceSnapshotService } from './WorkspaceSnapshotService.js';

const exec = promisify(execFile);

async function fixture(run: (input: {
  git: GitService;
  store: ThreadStore;
  threadId: string;
  root: string;
  workspace: string;
  activities: Array<Record<string, unknown>>;
}) => Promise<void>): Promise<void> {
  const root = join(tmpdir(), `telos-git-${uuidv7()}`);
  const workspace = join(root, 'project');
  await mkdir(workspace, { recursive: true });
  const store = await ThreadStore.open({ databasePath: join(root, 'threads.db') });
  const project = store.createProject({ path: workspace });
  const profile: ThreadLaunchProfile = {
    projectId: project.id as ThreadLaunchProfile['projectId'],
    workspacePath: workspace,
    worktreePath: null,
    agentName: 'executor',
    resolvedAgentConfig: {},
    providerId: 'openai-codex',
    modelId: 'gpt-5.6-codex',
    reasoning: 'high',
  };
  const thread = store.createThread({ launchProfile: profile });
  const snapshots = new WorkspaceSnapshotService(store, join(root, 'snapshots'));
  const activities: Array<Record<string, unknown>> = [];
  const git = new GitService(store, snapshots, (event) => activities.push(event));
  try {
    await run({ git, store, threadId: thread.id, root, workspace, activities });
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
}

test('supports init, status, selective commit, refs, and worktrees with durable progress', async () => {
  await fixture(async ({ git, store, threadId, root, workspace, activities }) => {
    const initialized = await git.execute({ threadId, action: 'init' }) as { clean: boolean };
    assert.equal(initialized.clean, true);
    await exec('git', ['config', 'user.name', 'Telos Test'], { cwd: workspace });
    await exec('git', ['config', 'user.email', 'telos@example.test'], { cwd: workspace });
    await writeFile(join(workspace, 'hello.txt'), 'hello\n');

    const dirty = await git.execute({ threadId, action: 'status' }) as {
      clean: boolean;
      entries: Array<{ path: string; workingTree: string }>;
    };
    assert.equal(dirty.clean, false);
    assert.equal(dirty.entries[0]?.path, 'hello.txt');

    const committed = await git.execute({
      threadId,
      action: 'commit',
      arguments: { message: 'initial', paths: ['hello.txt'] },
    }) as { hash: string; status: { clean: boolean } };
    assert.match(committed.hash, /^[0-9a-f]{40}$/u);
    assert.equal(committed.status.clean, true);

    await git.execute({ threadId, action: 'create-ref', arguments: { name: 'feature/test' } });
    const refs = await git.execute({ threadId, action: 'list-refs' }) as {
      refs: Array<{ name: string }>;
    };
    assert.ok(refs.refs.some((ref) => ref.name === 'refs/heads/feature/test'));

    const worktreePath = join(root, 'feature-worktree');
    await git.execute({
      threadId,
      action: 'create-worktree',
      arguments: { path: worktreePath, branch: 'feature/worktree' },
    });
    const worktrees = await git.execute({ threadId, action: 'list-worktrees' }) as Array<{ path: string }>;
    assert.ok(worktrees.some((worktree) => worktree.path === worktreePath));
    await git.execute({
      threadId,
      action: 'remove-worktree',
      arguments: { path: worktreePath },
    });

    assert.ok(activities.some((event) => event.action === 'commit' && event.state === 'completed'));
    assert.ok(store.listCheckpoints({ threadId }).some((checkpoint) => checkpoint.name === 'Before Git commit'));
    assert.ok(store.listCheckpoints({ threadId }).some((checkpoint) => checkpoint.name === 'After Git commit'));
  });
});

test('returns precise diagnostics for non-repositories and invalid commit selection', async () => {
  await fixture(async ({ git, threadId, workspace }) => {
    await assert.rejects(git.execute({ threadId, action: 'status' }), /not a git repository/u);
    await git.execute({ threadId, action: 'init' });
    await exec('git', ['config', 'user.name', 'Telos Test'], { cwd: workspace });
    await exec('git', ['config', 'user.email', 'telos@example.test'], { cwd: workspace });
    await assert.rejects(
      git.execute({ threadId, action: 'commit', arguments: { message: 'empty' } }),
      /selected paths or all=true/u,
    );
  });
});
