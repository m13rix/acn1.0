import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { v7 as uuidv7 } from 'uuid';

import type { ThreadLaunchProfile } from '@telos/code-contracts/telos';
import { TerminalService } from './TerminalService.js';
import { WorkspaceSnapshotService } from './WorkspaceSnapshotService.js';
import { ThreadStore } from './thread-store/ThreadStore.js';

async function fixture(
  run: (terminals: TerminalService, store: ThreadStore, threadId: string, directory: string) => Promise<void>,
  workspaceSnapshots?: WorkspaceSnapshotService,
): Promise<void> {
  const directory = join(tmpdir(), `telos-terminal-${uuidv7()}`);
  await mkdir(directory, { recursive: true });
  const store = await ThreadStore.open({ databasePath: join(directory, 'threads.db') });
  const project = store.createProject({ path: directory });
  const profile: ThreadLaunchProfile = {
    projectId: project.id as ThreadLaunchProfile['projectId'],
    workspacePath: directory,
    worktreePath: null,
    agentName: 'executor',
    resolvedAgentConfig: { preserveSession: true },
    providerId: 'openai-codex',
    modelId: 'gpt-5.6-codex',
    reasoning: 'high',
  };
  const thread = store.createThread({ launchProfile: profile });
  const terminals = new TerminalService(store, workspaceSnapshots);
  try {
    await run(terminals, store, thread.id, directory);
  } finally {
    await terminals.close();
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
}

test('runs commands through a durable visible terminal and persists the result', async () => {
  await fixture(async (terminals, store, threadId) => {
    const result = await terminals.run({
      threadId,
      command: process.platform === 'win32' ? 'Write-Output terminal-ok' : "printf 'terminal-ok\\n'",
      timeoutMs: 10_000,
    });
    assert.equal(result.success, true);
    assert.match(result.output, /terminal-ok/u);
    assert.equal(result.code, 0);
    const persisted = store.getTerminalSession(result.terminalId);
    assert.equal(persisted?.status, 'exited');
    assert.match(persisted?.history || '', /terminal-ok/u);
  });
});

test('does not snapshot the workspace for a finite read-only terminal command', async () => {
  let snapshots = 0;
  const workspaceSnapshots = {
    snapshot: async () => {
      snapshots += 1;
      return {};
    },
  } as unknown as WorkspaceSnapshotService;
  await fixture(async (terminals, _store, threadId, directory) => {
    await writeFile(join(directory, 'DESIGN.md'), '# Design\n', 'utf8');
    const result = await terminals.run({
      threadId,
      command: process.platform === 'win32' ? 'type DESIGN.md' : 'cat DESIGN.md',
      timeoutMs: 10_000,
    });
    assert.equal(result.success, true);
    assert.match(result.stdout, /Design/u);
  }, workspaceSnapshots);
  assert.equal(snapshots, 0);
});

test('supports attach, resize, clear, restart, close, and rejects cwd escape', async () => {
  await fixture(async (terminals, store, threadId, directory) => {
    const terminal = await terminals.open({ threadId, terminalId: uuidv7(), cols: 90, rows: 24 });
    assert.equal((await terminals.attach({ threadId, terminalId: terminal.id })).status, 'running');
    const resized = await terminals.resize({ threadId, terminalId: terminal.id, cols: 110, rows: 40 });
    assert.equal(resized.cols, 110);
    assert.equal(resized.rows, 40);
    const cleared = terminals.clear(threadId, terminal.id);
    assert.equal(cleared.history, '');
    await terminals.closeTerminal({ threadId, terminalId: terminal.id });
    assert.equal(store.getTerminalSession(terminal.id)?.status, 'exited');
    const restarted = await terminals.restart({ threadId, terminalId: terminal.id });
    assert.equal(restarted.status, 'running');
    await terminals.closeTerminal({ threadId, terminalId: terminal.id, deleteHistory: true });
    assert.equal(store.getTerminalSession(terminal.id), null);
    await assert.rejects(
      terminals.open({ threadId, cwd: join(directory, '..') }),
      /escapes the workspace/u,
    );
  });
});

test('marks previously live terminal records exited on harness restart', async () => {
  await fixture(async (_terminals, store, threadId, directory) => {
    const terminalId = uuidv7();
    store.saveTerminalSession({
      id: terminalId,
      threadId,
      cwd: directory,
      status: 'running',
      cols: 120,
      rows: 30,
      pid: 123,
    });
    new TerminalService(store);
    const restored = store.getTerminalSession(terminalId);
    assert.equal(restored?.status, 'exited');
    assert.equal(restored?.pid, null);
    assert.match(restored?.history || '', /Harness restarted/u);
  });
});
