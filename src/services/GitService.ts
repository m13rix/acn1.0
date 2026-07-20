import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

import { ThreadStore } from './thread-store/ThreadStore.js';
import type { HarnessThread } from './thread-store/types.js';
import { WorkspaceSnapshotService } from './WorkspaceSnapshotService.js';

export type GitAction =
  | 'status'
  | 'list-refs'
  | 'list-worktrees'
  | 'remotes'
  | 'init'
  | 'create-ref'
  | 'switch-ref'
  | 'create-worktree'
  | 'remove-worktree'
  | 'pull'
  | 'commit'
  | 'push'
  | 'publish'
  | 'create-pr';

export interface GitActionInput {
  threadId: string;
  action: GitAction;
  arguments?: Record<string, unknown>;
}

export interface GitStatusEntry {
  path: string;
  index: string;
  workingTree: string;
  originalPath?: string;
}

export interface GitStatusResult {
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  entries: GitStatusEntry[];
  clean: boolean;
}

type ProgressPublisher = (input: {
  threadId: string;
  action: GitAction;
  state: 'started' | 'progress' | 'completed' | 'failed';
  detail?: string;
  result?: unknown;
}) => void;

const WORKTREE_MUTATIONS = new Set<GitAction>(['switch-ref', 'pull', 'commit']);

export class GitService {
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(
    readonly store: ThreadStore,
    private readonly snapshots?: WorkspaceSnapshotService,
    private readonly publish?: ProgressPublisher,
  ) {}

  public execute(input: GitActionInput): Promise<unknown> {
    const thread = this.requireThread(input.threadId);
    const workspace = resolve(thread.launchProfile.worktreePath || thread.launchProfile.workspacePath);
    const previous = this.queues.get(workspace) || Promise.resolve();
    const next = previous.then(
      () => this.executeLocked(thread, input.action, input.arguments || {}),
      () => this.executeLocked(thread, input.action, input.arguments || {}),
    );
    this.queues.set(workspace, next);
    void next.finally(() => {
      if (this.queues.get(workspace) === next) this.queues.delete(workspace);
    }).catch(() => undefined);
    return next;
  }

  private async executeLocked(
    thread: HarnessThread,
    action: GitAction,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    const cwd = resolve(thread.launchProfile.worktreePath || thread.launchProfile.workspacePath);
    this.emit(thread.id, action, 'started');
    if (WORKTREE_MUTATIONS.has(action)) await this.checkpoint(thread, `Before Git ${action}`);
    try {
      const result = await this.runAction(cwd, action, args, (detail) => {
        this.emit(thread.id, action, 'progress', detail);
      });
      if (WORKTREE_MUTATIONS.has(action)) await this.checkpoint(thread, `After Git ${action}`);
      this.emit(thread.id, action, 'completed', undefined, result);
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (WORKTREE_MUTATIONS.has(action)) await this.checkpoint(thread, `After failed Git ${action}`).catch(() => undefined);
      this.emit(thread.id, action, 'failed', message);
      throw error;
    }
  }

  private async runAction(
    cwd: string,
    action: GitAction,
    args: Record<string, unknown>,
    progress: (detail: string) => void,
  ): Promise<unknown> {
    if (action === 'status') return this.status(cwd);
    if (action === 'list-refs') return this.listRefs(cwd);
    if (action === 'list-worktrees') return this.listWorktrees(cwd);
    if (action === 'remotes') return this.remotes(cwd);
    if (action === 'init') {
      await runProcess('git', ['init'], cwd, progress);
      return this.status(cwd);
    }
    if (action === 'create-ref') {
      const name = requiredString(args.name, 'create-ref.name');
      const startPoint = optionalString(args.startPoint);
      await runProcess('git', ['branch', name, ...(startPoint ? [startPoint] : [])], cwd, progress);
      return this.listRefs(cwd);
    }
    if (action === 'switch-ref') {
      const ref = requiredString(args.ref, 'switch-ref.ref');
      await runProcess('git', ['switch', ref], cwd, progress);
      return this.status(cwd);
    }
    if (action === 'create-worktree') {
      const path = resolve(requiredString(args.path, 'create-worktree.path'));
      const branch = optionalString(args.branch);
      const startPoint = optionalString(args.startPoint);
      const command = ['worktree', 'add'];
      if (branch) command.push('-b', branch);
      command.push(path);
      if (startPoint) command.push(startPoint);
      await runProcess('git', command, cwd, progress);
      return { path, worktrees: await this.listWorktrees(cwd) };
    }
    if (action === 'remove-worktree') {
      const path = resolve(requiredString(args.path, 'remove-worktree.path'));
      await runProcess('git', ['worktree', 'remove', ...(args.force === true ? ['--force'] : []), path], cwd, progress);
      return { path, worktrees: await this.listWorktrees(cwd) };
    }
    if (action === 'pull') {
      const command = ['pull'];
      if (args.rebase === true) command.push('--rebase');
      const remote = optionalString(args.remote);
      const branch = optionalString(args.branch);
      if (remote) command.push(remote);
      if (branch) command.push(branch);
      await runProcess('git', command, cwd, progress);
      return this.status(cwd);
    }
    if (action === 'commit') {
      const message = requiredString(args.message, 'commit.message');
      const paths = stringArray(args.paths);
      if (args.all === true) await runProcess('git', ['add', '-A'], cwd, progress);
      else {
        if (!paths.length) throw new Error('commit requires selected paths or all=true.');
        await runProcess('git', ['add', '--', ...paths], cwd, progress);
      }
      const committed = await runProcess('git', ['commit', '-m', message], cwd, progress);
      const hash = (await runProcess('git', ['rev-parse', 'HEAD'], cwd)).stdout.trim();
      return { hash, output: committed.stdout.trim(), status: await this.status(cwd) };
    }
    if (action === 'push') {
      const remote = optionalString(args.remote) || 'origin';
      const branch = optionalString(args.branch)
        || (await runProcess('git', ['branch', '--show-current'], cwd)).stdout.trim();
      if (!branch) throw new Error('Cannot push a detached HEAD without an explicit branch.');
      await runProcess(
        'git',
        ['push', ...(args.setUpstream === false ? [] : ['--set-upstream']), remote, branch],
        cwd,
        progress,
      );
      return { remote, branch };
    }
    if (action === 'publish') {
      await assertCli('gh', cwd, 'GitHub CLI is required to publish a repository.');
      const name = requiredString(args.name, 'publish.name');
      const visibility = args.visibility === 'public' ? '--public' : '--private';
      const output = await runProcess(
        'gh',
        ['repo', 'create', name, '--source', cwd, '--remote', optionalString(args.remote) || 'origin', visibility, '--push'],
        cwd,
        progress,
      );
      return { output: output.stdout.trim() };
    }
    if (action === 'create-pr') {
      await assertCli('gh', cwd, 'GitHub CLI is required to create a pull request.');
      const command = ['pr', 'create', '--title', requiredString(args.title, 'create-pr.title')];
      const body = optionalString(args.body);
      const base = optionalString(args.base);
      const head = optionalString(args.head);
      if (body) command.push('--body', body);
      if (base) command.push('--base', base);
      if (head) command.push('--head', head);
      if (args.draft === true) command.push('--draft');
      const output = await runProcess('gh', command, cwd, progress);
      return { url: lastNonEmptyLine(output.stdout) };
    }
    throw new Error(`Unsupported Git action: ${action}`);
  }

  private async status(cwd: string): Promise<GitStatusResult> {
    const output = await runProcess('git', ['status', '--porcelain=v1', '-z', '--branch'], cwd);
    return parseStatus(output.stdout);
  }

  private async listRefs(cwd: string): Promise<unknown> {
    const current = (await runProcess('git', ['branch', '--show-current'], cwd)).stdout.trim();
    const output = await runProcess(
      'git',
      ['for-each-ref', '--format=%(refname)\t%(objectname:short)\t%(upstream:short)', 'refs/heads', 'refs/remotes'],
      cwd,
    );
    return {
      current: current || null,
      refs: output.stdout.split(/\r?\n/u).filter(Boolean).map((line) => {
        const [name, hash, upstream] = line.split('\t');
        return { name, hash, upstream: upstream || null, remote: name?.startsWith('refs/remotes/') || false };
      }),
    };
  }

  private async listWorktrees(cwd: string): Promise<unknown[]> {
    const output = await runProcess('git', ['worktree', 'list', '--porcelain'], cwd);
    const records: Array<Record<string, unknown>> = [];
    let current: Record<string, unknown> | null = null;
    for (const line of output.stdout.split(/\r?\n/u)) {
      if (line.startsWith('worktree ')) {
        current = { path: resolve(line.slice('worktree '.length)) };
        records.push(current);
      } else if (current && line.startsWith('HEAD ')) current.head = line.slice(5);
      else if (current && line.startsWith('branch ')) current.branch = line.slice(7);
      else if (current && line === 'detached') current.detached = true;
      else if (current && line === 'locked') current.locked = true;
    }
    return records;
  }

  private async remotes(cwd: string): Promise<unknown[]> {
    const output = await runProcess('git', ['remote', '-v'], cwd);
    const rows = output.stdout.split(/\r?\n/u).filter(Boolean).map((line) => {
      const match = /^(\S+)\s+(\S+)\s+\((fetch|push)\)$/u.exec(line);
      return match ? { name: match[1], url: match[2], kind: match[3] } : null;
    }).filter((row): row is NonNullable<typeof row> => row !== null);
    return rows;
  }

  private async checkpoint(thread: HarnessThread, name: string): Promise<void> {
    if (!this.snapshots) return;
    await this.snapshots.snapshot({
      workspacePath: thread.launchProfile.worktreePath || thread.launchProfile.workspacePath,
      threadId: thread.id,
      name,
    });
  }

  private requireThread(threadId: string): HarnessThread {
    const thread = this.store.getThread(threadId);
    if (!thread) throw new Error(`Thread not found: ${threadId}`);
    return thread;
  }

  private emit(
    threadId: string,
    action: GitAction,
    state: 'started' | 'progress' | 'completed' | 'failed',
    detail?: string,
    result?: unknown,
  ): void {
    this.publish?.({ threadId, action, state, detail, result });
  }
}

async function runProcess(
  file: string,
  args: string[],
  cwd: string,
  progress?: (detail: string) => void,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolveRun, rejectRun) => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const child = spawn(file, args, {
      cwd,
      shell: false,
      windowsHide: true,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      rejectRun(new Error(`${file} ${args[0] || ''} timed out.`));
    }, 5 * 60 * 1_000);
    timer.unref?.();
    child.stdout?.on('data', (chunk) => {
      const text = chunk.toString();
      stdout.push(text);
      progress?.(text.trim());
    });
    child.stderr?.on('data', (chunk) => {
      const text = chunk.toString();
      stderr.push(text);
      progress?.(text.trim());
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      rejectRun(new Error(`Unable to start ${file}: ${error.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const out = stdout.join('');
      const err = stderr.join('');
      if (code === 0) resolveRun({ stdout: out, stderr: err });
      else rejectRun(new Error((err || out || `${file} exited with code ${code}`).trim()));
    });
  });
}

async function assertCli(file: string, cwd: string, diagnostic: string): Promise<void> {
  try {
    await runProcess(file, ['--version'], cwd);
  } catch (error) {
    throw new Error(`${diagnostic} ${error instanceof Error ? error.message : String(error)}`);
  }
}

function parseStatus(raw: string): GitStatusResult {
  const records = raw.split('\0').filter(Boolean);
  const header = records.shift() || '';
  const branchMatch = /^## (?:No commits yet on )?([^.]\S*|HEAD)(?:\.\.\.([^ \[]+))?(?: \[([^\]]+)\])?/u.exec(header);
  let ahead = 0;
  let behind = 0;
  for (const part of branchMatch?.[3]?.split(', ') || []) {
    const match = /^(ahead|behind) (\d+)$/u.exec(part);
    if (match?.[1] === 'ahead') ahead = Number(match[2]);
    if (match?.[1] === 'behind') behind = Number(match[2]);
  }
  const entries: GitStatusEntry[] = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]!;
    const status = record.slice(0, 2);
    const path = record.slice(3);
    const entry: GitStatusEntry = { path, index: status[0] || ' ', workingTree: status[1] || ' ' };
    if (status.includes('R') || status.includes('C')) entry.originalPath = records[++index];
    entries.push(entry);
  }
  return {
    branch: branchMatch?.[1] && branchMatch[1] !== 'HEAD' ? branchMatch[1] : null,
    upstream: branchMatch?.[2] || null,
    ahead,
    behind,
    entries,
    clean: entries.length === 0,
  };
}

function requiredString(value: unknown, name: string): string {
  const result = optionalString(value);
  if (!result) throw new Error(`${name} must be a non-empty string.`);
  return result;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.length > 0)
    : [];
}

function lastNonEmptyLine(value: string): string | null {
  return value.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean).at(-1) || null;
}
