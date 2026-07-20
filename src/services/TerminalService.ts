import { createRequire } from 'node:module';
import { isAbsolute, relative, resolve } from 'node:path';
import { lstat, realpath } from 'node:fs/promises';
import { v7 as uuidv7 } from 'uuid';

import { ThreadStore } from './thread-store/ThreadStore.js';
import type { HarnessThread, StoredTerminalSession } from './thread-store/types.js';
import { WorkspaceSnapshotService } from './WorkspaceSnapshotService.js';

const MAX_HISTORY_CHARS = 1_000_000;
const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 30;
const PERSIST_DELAY_MS = 100;
const CHECKPOINT_QUIET_MS = 2_000;

interface PtyProcess {
  pid: number;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
  onData(callback: (data: string) => void): { dispose(): void };
  onExit(callback: (event: { exitCode: number; signal?: number }) => void): { dispose(): void };
}

interface LiveTerminal {
  snapshot: StoredTerminalSession;
  process: PtyProcess;
  persistTimer?: ReturnType<typeof setTimeout>;
  checkpointTimer?: ReturnType<typeof setTimeout>;
  checkpointPending: Promise<void>;
  exitPromise: Promise<void>;
  resolveExit: () => void;
  dataSubscription?: { dispose(): void };
  exitSubscription?: { dispose(): void };
}

export type TerminalServiceEvent =
  | { type: 'snapshot'; terminal: StoredTerminalSession }
  | { type: 'output'; threadId: string; terminalId: string; sequence: number; data: string }
  | { type: 'cleared'; terminal: StoredTerminalSession }
  | { type: 'exited'; terminal: StoredTerminalSession }
  | { type: 'closed'; threadId: string; terminalId: string };

export interface TerminalOpenInput {
  threadId: string;
  terminalId?: string;
  cwd?: string;
  cols?: number;
  rows?: number;
  command?: string;
  keepOpen?: boolean;
}

const requireFromHere = createRequire(import.meta.url);

export class TerminalService {
  private readonly live = new Map<string, LiveTerminal>();
  private readonly subscribers = new Map<string, Set<(event: TerminalServiceEvent) => void>>();

  constructor(
    readonly store: ThreadStore,
    private readonly workspaceSnapshots?: WorkspaceSnapshotService,
  ) {
    this.store.markLiveTerminalsExited();
  }

  public list(threadId: string): StoredTerminalSession[] {
    this.requireThread(threadId);
    return this.store.listTerminalSessions(threadId);
  }

  public get(threadId: string, terminalId: string): StoredTerminalSession {
    const terminal = this.store.getTerminalSession(terminalId);
    if (!terminal || terminal.threadId !== threadId) {
      throw new Error(`Terminal not found in thread: ${terminalId}`);
    }
    return terminal;
  }

  public subscribe(threadId: string, subscriber: (event: TerminalServiceEvent) => void): () => void {
    this.requireThread(threadId);
    const current = this.subscribers.get(threadId) || new Set<(event: TerminalServiceEvent) => void>();
    current.add(subscriber);
    this.subscribers.set(threadId, current);
    return () => {
      current.delete(subscriber);
      if (current.size === 0) this.subscribers.delete(threadId);
    };
  }

  public async open(input: TerminalOpenInput): Promise<StoredTerminalSession> {
    const thread = this.requireThread(input.threadId);
    const terminalId = input.terminalId || uuidv7();
    const existing = this.store.getTerminalSession(terminalId);
    if (existing) throw new Error(`Terminal already exists: ${terminalId}`);
    const cwd = await this.resolveCwd(thread, input.cwd);
    const cols = clamp(input.cols, 20, 1_000, DEFAULT_COLS);
    const rows = clamp(input.rows, 5, 500, DEFAULT_ROWS);
    const command = input.command?.trim() || '';
    const process = this.spawn(cwd, cols, rows, command, input.keepOpen === true);
    const snapshot = this.store.saveTerminalSession({
      id: terminalId,
      threadId: thread.id,
      cwd,
      command,
      status: 'running',
      cols,
      rows,
      pid: process.pid,
      label: command || shellLabel(),
      hasRunningSubprocess: Boolean(command),
    });
    const exit = deferred();
    const terminal: LiveTerminal = {
      snapshot,
      process,
      checkpointPending: Promise.resolve(),
      exitPromise: exit.promise,
      resolveExit: exit.resolve,
    };
    this.live.set(terminalId, terminal);
    terminal.dataSubscription = process.onData((data) => this.onOutput(terminal, data));
    terminal.exitSubscription = process.onExit((event) => this.onExit(terminal, event));
    this.emit(thread.id, { type: 'snapshot', terminal: snapshot });
    return snapshot;
  }

  public async attach(input: {
    threadId: string;
    terminalId: string;
    cols?: number;
    rows?: number;
    restartIfNotRunning?: boolean;
  }): Promise<StoredTerminalSession> {
    let terminal = this.get(input.threadId, input.terminalId);
    if (this.live.has(input.terminalId)) {
      if (input.cols || input.rows) {
        terminal = await this.resize({
          threadId: input.threadId,
          terminalId: input.terminalId,
          cols: input.cols || terminal.cols,
          rows: input.rows || terminal.rows,
        });
      }
      return terminal;
    }
    if (input.restartIfNotRunning) {
      return this.restart(input);
    }
    return terminal;
  }

  public async write(input: { threadId: string; terminalId: string; data: string }): Promise<void> {
    if (!input.data) return;
    const terminal = this.requireLive(input.threadId, input.terminalId);
    if (!terminal.snapshot.hasRunningSubprocess) {
      terminal.checkpointPending = terminal.checkpointPending.then(() => this.checkpoint(
        terminal.snapshot,
        'Before terminal input',
      ));
    }
    terminal.snapshot = this.store.saveTerminalSession({
      ...terminal.snapshot,
      hasRunningSubprocess: true,
      label: terminal.snapshot.command || 'Terminal activity',
    });
    terminal.process.write(input.data);
    this.scheduleQuietCheckpoint(terminal);
  }

  public async resize(input: {
    threadId: string;
    terminalId: string;
    cols: number;
    rows: number;
  }): Promise<StoredTerminalSession> {
    const terminal = this.requireLive(input.threadId, input.terminalId);
    const cols = clamp(input.cols, 20, 1_000, terminal.snapshot.cols);
    const rows = clamp(input.rows, 5, 500, terminal.snapshot.rows);
    terminal.process.resize(cols, rows);
    terminal.snapshot = this.store.saveTerminalSession({ ...terminal.snapshot, cols, rows });
    return terminal.snapshot;
  }

  public clear(threadId: string, terminalId: string): StoredTerminalSession {
    const persisted = this.get(threadId, terminalId);
    const live = this.live.get(terminalId);
    const next = this.store.saveTerminalSession({ ...persisted, history: '', sequence: persisted.sequence + 1 });
    if (live) live.snapshot = next;
    this.emit(threadId, { type: 'cleared', terminal: next });
    return next;
  }

  public async restart(input: {
    threadId: string;
    terminalId: string;
    cols?: number;
    rows?: number;
  }): Promise<StoredTerminalSession> {
    const previous = this.get(input.threadId, input.terminalId);
    await this.stopLive(input.threadId, input.terminalId, false);
    const cols = clamp(input.cols, 20, 1_000, previous.cols);
    const rows = clamp(input.rows, 5, 500, previous.rows);
    const process = this.spawn(previous.cwd, cols, rows, previous.command, Boolean(previous.command));
    const snapshot = this.store.saveTerminalSession({
      ...previous,
      status: 'running',
      history: `${previous.history}\n[Terminal restarted.]\n`,
      cols,
      rows,
      pid: process.pid,
      exitCode: null,
      exitSignal: null,
      sequence: previous.sequence + 1,
      hasRunningSubprocess: Boolean(previous.command),
    });
    const exit = deferred();
    const terminal: LiveTerminal = {
      snapshot,
      process,
      checkpointPending: Promise.resolve(),
      exitPromise: exit.promise,
      resolveExit: exit.resolve,
    };
    this.live.set(previous.id, terminal);
    terminal.dataSubscription = process.onData((data) => this.onOutput(terminal, data));
    terminal.exitSubscription = process.onExit((event) => this.onExit(terminal, event));
    this.emit(previous.threadId, { type: 'snapshot', terminal: snapshot });
    return snapshot;
  }

  public async closeTerminal(input: {
    threadId: string;
    terminalId?: string;
    deleteHistory?: boolean;
  }): Promise<void> {
    const ids = input.terminalId
      ? [input.terminalId]
      : this.store.listTerminalSessions(input.threadId).map((terminal) => terminal.id);
    for (const id of ids) {
      this.get(input.threadId, id);
      await this.stopLive(input.threadId, id, true);
      if (input.deleteHistory) this.store.deleteTerminalSession(id);
      this.emit(input.threadId, { type: 'closed', threadId: input.threadId, terminalId: id });
    }
  }

  public async run(input: {
    threadId: string;
    command: string;
    cwd?: string;
    timeoutMs?: number;
  }): Promise<{ success: boolean; code: number | null; output: string; stdout: string; stderr: string; timedOut: boolean; terminalId: string }> {
    if (!input.command.trim()) throw new Error('terminal.run requires a non-empty command.');
    const terminal = await this.open({
      threadId: input.threadId,
      cwd: input.cwd,
      command: input.command,
      keepOpen: false,
    });
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeoutMs = clamp(input.timeoutMs, 1, 24 * 60 * 60 * 1_000, 60_000);
    try {
      const completed = await Promise.race([
        this.waitForExit(input.threadId, terminal.id),
        new Promise<StoredTerminalSession>((_resolve, reject) => {
          timer = setTimeout(() => {
            timedOut = true;
            void this.stopLive(input.threadId, terminal.id, true);
            reject(new Error(`Terminal command timed out after ${timeoutMs} ms.`));
          }, timeoutMs);
          timer.unref?.();
        }),
      ]).catch(() => this.get(input.threadId, terminal.id));
      const output = completed.history.trim() || '(no output)';
      return {
        success: !timedOut && completed.exitCode === 0,
        code: completed.exitCode,
        output,
        stdout: output,
        stderr: '',
        timedOut,
        terminalId: terminal.id,
      };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  public async close(): Promise<void> {
    const sessions = [...this.live.values()];
    await Promise.all(sessions.map((terminal) => this.stopLive(
      terminal.snapshot.threadId,
      terminal.snapshot.id,
      true,
    )));
  }

  private spawn(cwd: string, cols: number, rows: number, command: string, keepOpen: boolean): PtyProcess {
    const pty = requireNodePty();
    const shell = shellCommand(command, keepOpen);
    return pty.spawn(shell.file, shell.args, {
      name: process.platform === 'win32' ? 'xterm-256color' : 'xterm-color',
      cols,
      rows,
      cwd,
      env: process.env,
    }) as PtyProcess;
  }

  private onOutput(terminal: LiveTerminal, data: string): void {
    const history = trimHistory(terminal.snapshot.history + data);
    terminal.snapshot = {
      ...terminal.snapshot,
      history,
      sequence: terminal.snapshot.sequence + 1,
      updatedAt: new Date().toISOString(),
    };
    this.emit(terminal.snapshot.threadId, {
      type: 'output',
      threadId: terminal.snapshot.threadId,
      terminalId: terminal.snapshot.id,
      sequence: terminal.snapshot.sequence,
      data,
    });
    if (!terminal.persistTimer) {
      terminal.persistTimer = setTimeout(() => this.persistLive(terminal), PERSIST_DELAY_MS);
      terminal.persistTimer.unref?.();
    }
  }

  private onExit(terminal: LiveTerminal, event: { exitCode: number; signal?: number }): void {
    if (this.live.get(terminal.snapshot.id) !== terminal) return;
    if (terminal.persistTimer) clearTimeout(terminal.persistTimer);
    if (terminal.checkpointTimer) clearTimeout(terminal.checkpointTimer);
    terminal.snapshot = this.store.saveTerminalSession({
      ...terminal.snapshot,
      status: 'exited',
      pid: null,
      exitCode: event.exitCode,
      exitSignal: event.signal ?? null,
      history: trimHistory(`${terminal.snapshot.history}\n[Terminal exited with code ${event.exitCode}.]\n`),
      sequence: terminal.snapshot.sequence + 1,
      hasRunningSubprocess: false,
    });
    try {
      terminal.process.kill();
    } catch {
      // The native PTY may already have released every process handle.
    }
    void terminal.checkpointPending
      .then(() => this.checkpoint(terminal.snapshot, 'After terminal activity'))
      .catch(() => undefined);
    this.emit(terminal.snapshot.threadId, { type: 'exited', terminal: terminal.snapshot });
    const cleanupTimer = setTimeout(() => {
      if (this.live.get(terminal.snapshot.id) === terminal) this.live.delete(terminal.snapshot.id);
      terminal.dataSubscription?.dispose();
      terminal.exitSubscription?.dispose();
      terminal.resolveExit();
    }, 250);
    cleanupTimer.unref?.();
  }

  private persistLive(terminal: LiveTerminal): void {
    terminal.persistTimer = undefined;
    if (this.live.get(terminal.snapshot.id) !== terminal) return;
    terminal.snapshot = this.store.saveTerminalSession(terminal.snapshot);
  }

  private scheduleQuietCheckpoint(terminal: LiveTerminal): void {
    if (terminal.checkpointTimer) clearTimeout(terminal.checkpointTimer);
    terminal.checkpointTimer = setTimeout(() => {
      terminal.checkpointTimer = undefined;
      terminal.checkpointPending = terminal.checkpointPending
        .then(() => this.checkpoint(terminal.snapshot, 'After terminal activity'))
        .then(() => {
          if (this.live.get(terminal.snapshot.id) !== terminal) return;
          terminal.snapshot = this.store.saveTerminalSession({
            ...terminal.snapshot,
            hasRunningSubprocess: false,
            label: terminal.snapshot.command || shellLabel(),
          });
        });
    }, CHECKPOINT_QUIET_MS);
    terminal.checkpointTimer.unref?.();
  }

  private async checkpoint(terminal: StoredTerminalSession, name: string): Promise<void> {
    if (!this.workspaceSnapshots) return;
    await this.workspaceSnapshots.snapshot({
      workspacePath: this.requireThread(terminal.threadId).launchProfile.worktreePath
        || this.requireThread(terminal.threadId).launchProfile.workspacePath,
      threadId: terminal.threadId,
      name,
    });
  }

  private async waitForExit(threadId: string, terminalId: string): Promise<StoredTerminalSession> {
    for (;;) {
      const terminal = this.get(threadId, terminalId);
      if (terminal.status === 'exited' || terminal.status === 'error') return terminal;
      await new Promise<void>((resolveWait) => {
        const timer = setTimeout(resolveWait, 20);
        timer.unref?.();
      });
    }
  }

  private async stopLive(threadId: string, terminalId: string, persist: boolean): Promise<void> {
    const terminal = this.live.get(terminalId);
    if (!terminal) return;
    if (terminal.snapshot.threadId !== threadId) throw new Error(`Terminal is owned by another thread: ${terminalId}`);
    if (terminal.snapshot.status === 'exited' || terminal.snapshot.status === 'error') {
      await terminal.exitPromise;
      return;
    }
    if (terminal.persistTimer) clearTimeout(terminal.persistTimer);
    if (terminal.checkpointTimer) clearTimeout(terminal.checkpointTimer);
    try {
      terminal.process.kill();
    } catch {
      // The PTY may already have exited between lookup and cancellation.
    }
    await Promise.race([
      terminal.exitPromise,
      new Promise<void>((resolveWait) => setTimeout(resolveWait, 2_000)),
    ]);
    if (this.live.get(terminalId) === terminal) {
      this.live.delete(terminalId);
      terminal.dataSubscription?.dispose();
      terminal.exitSubscription?.dispose();
      terminal.resolveExit();
    }
    if (persist && this.store.getTerminalSession(terminalId)?.status === 'running') {
      terminal.snapshot = this.store.saveTerminalSession({
        ...terminal.snapshot,
        status: 'exited',
        pid: null,
        hasRunningSubprocess: false,
      });
    }
  }

  private requireLive(threadId: string, terminalId: string): LiveTerminal {
    const terminal = this.live.get(terminalId);
    if (!terminal || terminal.snapshot.threadId !== threadId || terminal.snapshot.status !== 'running') {
      throw new Error(`Terminal is not running: ${terminalId}`);
    }
    return terminal;
  }

  private requireThread(threadId: string): HarnessThread {
    const thread = this.store.getThread(threadId);
    if (!thread) throw new Error(`Thread not found: ${threadId}`);
    return thread;
  }

  private async resolveCwd(thread: HarnessThread, requested?: string): Promise<string> {
    const root = resolve(thread.launchProfile.worktreePath || thread.launchProfile.workspacePath);
    const target = requested
      ? resolve(root, requested)
      : root;
    const lexical = relative(root, target);
    if (lexical.startsWith('..') || isAbsolute(lexical)) throw new Error(`Terminal cwd escapes the workspace: ${requested}`);
    const rootReal = await realpath(root);
    const targetReal = await realpath(target);
    const physical = relative(rootReal, targetReal);
    if (physical.startsWith('..') || isAbsolute(physical)) throw new Error(`Terminal cwd resolves outside the workspace: ${requested}`);
    if (!(await lstat(targetReal)).isDirectory()) throw new Error(`Terminal cwd is not a directory: ${requested}`);
    return targetReal;
  }

  private emit(threadId: string, event: TerminalServiceEvent): void {
    for (const subscriber of this.subscribers.get(threadId) || []) subscriber(event);
  }
}

function requireNodePty(): { spawn(file: string, args: string[], options: Record<string, unknown>): unknown } {
  try {
    return requireFromHere('node-pty');
  } catch (error) {
    throw new Error(`Terminal service requires node-pty: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function shellCommand(command: string, keepOpen: boolean): { file: string; args: string[] } {
  if (process.platform === 'win32') {
    const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass'];
    if (command) {
      if (keepOpen) args.push('-NoExit');
      args.push('-Command', command);
    }
    return { file: 'powershell.exe', args };
  }
  if (!command) return { file: process.env.SHELL || '/bin/sh', args: ['-l'] };
  return { file: process.env.SHELL || '/bin/sh', args: [keepOpen ? '-ilc' : '-lc', command] };
}

function shellLabel(): string {
  return process.platform === 'win32' ? 'PowerShell' : 'Shell';
}

function clamp(value: number | undefined, minimum: number, maximum: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.floor(value!)));
}

function trimHistory(history: string): string {
  return history.length <= MAX_HISTORY_CHARS ? history : history.slice(history.length - MAX_HISTORY_CHARS);
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
