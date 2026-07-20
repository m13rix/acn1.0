import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { v7 as uuidv7 } from 'uuid';

import type { ReasoningEffort, ThreadLaunchProfile } from '@telos/code-contracts/telos';
import { Executor, type ExecutorCallbacks } from '../core/Executor.js';
import { loadAgentTools, resolveTextAgentRuntime } from '../core/SessionFactory.js';
import { Session, type SessionSnapshot } from '../core/Session.js';
import { AgentLoader } from '../loaders/AgentLoader.js';
import { ToolLoader } from '../loaders/ToolLoader.js';
import { LocalSandbox } from '../sandbox/LocalSandbox.js';
import type { AgentConfig, LoadedAgent } from '../types/index.js';
import { ThreadStore } from './thread-store/ThreadStore.js';
import type { HarnessThread, StoredInteraction, StoredThreadEvent, StoredTurn } from './thread-store/types.js';
import type { StoredAttachment } from './thread-store/types.js';
import { TerminalService } from './TerminalService.js';
import { GitService } from './GitService.js';
import { AttachmentService } from './AttachmentService.js';
import { WorkspaceSnapshotService } from './WorkspaceSnapshotService.js';
import { ProjectScriptService } from './ProjectScriptService.js';
import { PreviewService } from './PreviewService.js';

export interface ThreadExecutionCallbacks extends ExecutorCallbacks {
  onCheckpoint(snapshot: SessionSnapshot, reason: string): void | Promise<void>;
  onWorkspaceActivity?(state: string, detail: Record<string, unknown>): void;
  onServiceRequest?(
    type: string,
    payload: unknown,
    ephemeralPaths: string[],
  ): unknown | Promise<unknown>;
}

export interface ThreadExecutionResult {
  response: string;
  snapshot: SessionSnapshot;
}

export interface ThreadExecutionAdapter {
  execute(input: {
    thread: HarnessThread;
    turn: StoredTurn;
    previousSnapshot: SessionSnapshot | null;
    signal: AbortSignal;
    callbacks: ThreadExecutionCallbacks;
  }): Promise<ThreadExecutionResult>;
}

export interface EnqueuedTurn {
  turnId: string;
  completed: Promise<StoredTurn>;
}

interface TurnJob {
  thread: HarnessThread;
  turn: StoredTurn;
  resolve: (turn: StoredTurn) => void;
  reject: (error: Error) => void;
}

interface RunningTurn {
  threadId: string;
  turnId: string;
  workspaceKey: string;
  abortController: AbortController;
}

interface InteractionWaiter {
  threadId: string;
  resolve: (answer: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
}

interface ManagedChildJob {
  jobName: string;
  parentThreadId: string;
  childThreadId: string;
  agentName: string;
  status: 'running' | 'completed' | 'failed' | 'stopping' | 'stopped';
  startedAt: string;
  updatedAt: string;
  pendingMessages: number;
  promise: Promise<void>;
  finalMessage?: string;
  error?: string;
}

export type ThreadEventSubscriber = (event: StoredThreadEvent) => void;

export class ThreadService {
  private readonly executionAdapter: ThreadExecutionAdapter;
  private readonly workspaceQueues = new Map<string, TurnJob[]>();
  private readonly runningWorkspaces = new Set<string>();
  private readonly runningByThread = new Map<string, RunningTurn>();
  private readonly interactionWaiters = new Map<string, InteractionWaiter>();
  private readonly subscribers = new Map<string, Set<ThreadEventSubscriber>>();
  private readonly managedChildJobs = new Map<string, ManagedChildJob>();
  private readonly sharedChildrenByWorkspace = new Map<string, Set<Promise<void>>>();
  private readonly workspaceSnapshots: WorkspaceSnapshotService | undefined;
  readonly terminals: TerminalService;
  readonly git: GitService;
  readonly attachments: AttachmentService;
  readonly scripts: ProjectScriptService;
  readonly previews: PreviewService;

  constructor(
    readonly store: ThreadStore,
    options: {
      executionAdapter?: ThreadExecutionAdapter;
      workspaceSnapshots?: WorkspaceSnapshotService;
      terminalService?: TerminalService;
      attachmentService?: AttachmentService;
      attachmentStoragePath?: string;
    } = {},
  ) {
    this.workspaceSnapshots = options.workspaceSnapshots;
    this.terminals = options.terminalService || new TerminalService(store, options.workspaceSnapshots);
    this.attachments = options.attachmentService
      || new AttachmentService(store, options.attachmentStoragePath || resolve('data', 'telos-code', 'attachments'));
    this.scripts = new ProjectScriptService(store, this.terminals, (threadId, state, payload) => {
      this.emit(threadId, 'activity', {
        turnId: null,
        activityType: 'terminal',
        state,
        script: payload,
        final: true,
      });
    });
    this.previews = new PreviewService(store, (threadId, state, payload) => {
      this.emit(threadId, 'activity', {
        turnId: null,
        activityType: 'preview',
        state,
        preview: payload,
        final: true,
      });
    });
    this.git = new GitService(store, options.workspaceSnapshots, (event) => {
      this.emit(event.threadId, 'activity', {
        turnId: null,
        activityType: 'git',
        action: event.action,
        state: event.state,
        detail: event.detail,
        result: event.result,
        final: event.state === 'completed' || event.state === 'failed',
      });
    });
    this.executionAdapter = options.executionAdapter
      || new HarnessThreadExecutionAdapter(options.workspaceSnapshots);
  }

  async createThread(input: {
    threadId?: string;
    projectId: string;
    worktreePath?: string | null;
    agentName: string;
    providerId: string;
    modelId: string;
    reasoning: ReasoningEffort;
    parentThreadId?: string | null;
    title?: string;
  }): Promise<HarnessThread> {
    const project = this.store.getProject(input.projectId);
    if (!project) throw new Error(`Project not found: ${input.projectId}`);
    const agentLoader = new AgentLoader();
    const sourceAgent = await agentLoader.loadByName(input.agentName);
    if (!sourceAgent) throw new Error(`Agent not found: ${input.agentName}`);
    if ((sourceAgent.config.modality || 'text') !== 'text') {
      throw new Error(`Voice-only agent cannot create a coding thread: ${input.agentName}`);
    }
    const config = structuredClone(sourceAgent.config);
    config.provider = input.providerId;
    config.model = input.modelId;
    config.reasoning = input.reasoning;
    config.preserveSession = true;
    config.modelSwitching = {
      ...(config.modelSwitching || {}),
      mode: 'whitelist',
      whitelist: [input.modelId],
    };
    const workspacePath = resolve(input.worktreePath || project.path);
    const launchProfile: ThreadLaunchProfile = {
      projectId: project.id as ThreadLaunchProfile['projectId'],
      workspacePath,
      worktreePath: input.worktreePath ? resolve(input.worktreePath) : null,
      agentName: sourceAgent.config.name,
      resolvedAgentConfig: config as unknown as ThreadLaunchProfile['resolvedAgentConfig'],
      providerId: input.providerId,
      modelId: input.modelId,
      reasoning: input.reasoning,
    };
    const thread = this.store.createThread({
      id: input.threadId,
      parentThreadId: input.parentThreadId,
      launchProfile,
      title: input.title,
    });
    if (this.workspaceSnapshots) {
      try {
        await this.createAutomaticCheckpoint(thread, null, 'Thread baseline');
      } catch (error) {
        this.store.deleteThread(thread.id);
        throw error;
      }
    }
    return thread;
  }

  subscribe(threadId: string, subscriber: ThreadEventSubscriber): () => void {
    const existing = this.subscribers.get(threadId) || new Set<ThreadEventSubscriber>();
    existing.add(subscriber);
    this.subscribers.set(threadId, existing);
    return () => {
      existing.delete(subscriber);
      if (existing.size === 0) this.subscribers.delete(threadId);
    };
  }

  async createUploadedAttachment(input: {
    threadId: string; bytes: Uint8Array; name: string; mimeType?: string; source?: string;
  }): Promise<StoredAttachment> {
    this.requireThread(input.threadId);
    const attachment = await this.attachments.createFromBytes(input);
    this.emit(input.threadId, 'attachment', {
      turnId: null, attachmentId: attachment.id, state: 'created', name: attachment.name,
      mimeType: attachment.mimeType, size: attachment.size, sha256: attachment.sha256,
      source: input.source || 'interface-upload', final: true,
    });
    return attachment;
  }

  enqueueTurn(input: {
    threadId: string;
    text: string;
    attachmentIds?: string[];
    turnId?: string;
  }): EnqueuedTurn {
    const thread = this.store.getThread(input.threadId);
    if (!thread) throw new Error(`Thread not found: ${input.threadId}`);
    if (thread.archivedAt) throw new Error(`Cannot send to archived thread: ${input.threadId}`);
    const turn = this.store.createTurn({
      id: input.turnId,
      threadId: thread.id,
      text: input.text,
      attachmentIds: input.attachmentIds,
      requestedEffort: thread.launchProfile.reasoning,
      effectiveEffort: effectiveEffort(thread.launchProfile.providerId, thread.launchProfile.reasoning),
    });
    this.emit(thread.id, 'message', {
      turnId: turn.id,
      role: 'user',
      text: input.text,
      attachmentIds: input.attachmentIds || [],
      final: true,
    });
    this.emit(thread.id, 'activity', {
      turnId: turn.id,
      activityType: 'turn',
      state: 'queued',
      final: true,
    });
    this.store.setThreadStatus(thread.id, 'queued');

    let resolveTurn!: (turn: StoredTurn) => void;
    let rejectTurn!: (error: Error) => void;
    const completed = new Promise<StoredTurn>((resolve, reject) => {
      resolveTurn = resolve;
      rejectTurn = reject;
    });
    const workspaceKey = this.workspaceKey(thread.launchProfile.worktreePath || thread.launchProfile.workspacePath);
    const queue = this.workspaceQueues.get(workspaceKey) || [];
    queue.push({ thread, turn, resolve: resolveTurn, reject: rejectTurn });
    this.workspaceQueues.set(workspaceKey, queue);
    void this.drainWorkspace(workspaceKey);
    return { turnId: turn.id, completed };
  }

  stop(threadId: string): boolean {
    const running = this.runningByThread.get(threadId);
    if (!running) return false;
    running.abortController.abort(new Error('Stopped by user'));
    return true;
  }

  stopAndSend(input: {
    threadId: string;
    text: string;
    attachmentIds?: string[];
  }): EnqueuedTurn {
    this.stop(input.threadId);
    return this.enqueueTurn(input);
  }

  isWorkspaceTurnActive(threadId: string): boolean {
    const thread = this.requireThread(threadId);
    return this.runningWorkspaces.has(this.workspaceKey(
      thread.launchProfile.worktreePath || thread.launchProfile.workspacePath,
    ));
  }

  async rewind(input: {
    threadId: string;
    checkpointId: string;
    files?: string[];
  }): Promise<unknown> {
    if (!this.workspaceSnapshots) throw new Error('Workspace checkpoints are unavailable.');
    if (this.runningByThread.has(input.threadId)) {
      throw new Error('Stop the active turn before rewinding this thread.');
    }
    const thread = this.store.getThread(input.threadId);
    if (!thread) throw new Error(`Thread not found: ${input.threadId}`);
    const checkpoint = this.store.getCheckpoint(input.checkpointId);
    if (!checkpoint || checkpoint.threadId !== thread.id) {
      throw new Error(`Checkpoint is not available to this thread: ${input.checkpointId}`);
    }
    const rollback = await this.workspaceSnapshots.rollback(input.checkpointId, {
      files: input.files,
      threadId: thread.id,
      turnId: checkpoint.turnId,
    });
    if (checkpoint.turnId) this.store.restoreExecutorSnapshot(thread.id, checkpoint.turnId);
    else this.store.clearExecutorSnapshot(thread.id);
    const selectedTurn = checkpoint.turnId ? this.store.getTurn(checkpoint.turnId) : null;
    const undoneTurnIds = this.store.listTurns(thread.id)
      .filter((turn) => !selectedTurn || turn.queuedAt > selectedTurn.queuedAt)
      .map((turn) => turn.id);
    this.emit(thread.id, 'activity', {
      turnId: checkpoint.turnId,
      activityType: 'checkpoint',
      state: 'rewound',
      checkpointId: checkpoint.id,
      activeContextTurnId: checkpoint.turnId,
      undoneTurnIds,
      safetyCheckpointId: rollback.safetyCheckpoint.id,
      files: input.files,
      final: true,
    });
    return {
      ...rollback,
      activeContextTurnId: checkpoint.turnId,
      undoneTurnIds,
    };
  }

  answerInteraction(input: {
    interactionId: string;
    answers: Record<string, unknown>;
  }): { accepted: boolean; interaction: StoredInteraction } {
    const result = this.store.answerInteraction(input.interactionId, input.answers);
    if (!result.accepted) return result;
    this.emit(result.interaction.threadId, 'interaction', {
      interactionId: result.interaction.id,
      turnId: result.interaction.turnId,
      state: 'answered',
      answers: input.answers,
      final: true,
    });
    const waiter = this.interactionWaiters.get(input.interactionId);
    if (waiter) {
      if (waiter.timer) clearTimeout(waiter.timer);
      this.interactionWaiters.delete(input.interactionId);
      waiter.resolve(input.answers);
    }
    const thread = this.store.getThread(result.interaction.threadId);
    if (thread?.status === 'waiting-input') this.store.setThreadStatus(thread.id, 'running');
    return result;
  }

  async listFiles(threadId: string, requestedPath = ''): Promise<{
    path: string;
    entries: Array<{ name: string; path: string; kind: 'file' | 'directory' | 'symlink'; size: number }>;
  }> {
    const thread = this.requireThread(threadId);
    const { target, relativePath } = await this.resolveWorkspaceTarget(thread, requestedPath, false);
    const info = await lstat(target);
    if (!info.isDirectory()) throw new Error(`Not a directory: ${requestedPath}`);
    const entries = await readdir(target, { withFileTypes: true });
    const values = await Promise.all(entries.map(async (entry) => {
      const absolute = resolve(target, entry.name);
      const entryInfo = await lstat(absolute);
      const path = normalizeRelative(relative(this.workspacePath(thread), absolute));
      return {
        name: entry.name,
        path,
        kind: entry.isSymbolicLink() ? 'symlink' as const
          : entry.isDirectory() ? 'directory' as const : 'file' as const,
        size: entryInfo.isFile() ? entryInfo.size : 0,
      };
    }));
    values.sort((left, right) => {
      if (left.kind === 'directory' && right.kind !== 'directory') return -1;
      if (left.kind !== 'directory' && right.kind === 'directory') return 1;
      return left.name.localeCompare(right.name);
    });
    return { path: relativePath, entries: values };
  }

  async readFile(threadId: string, requestedPath: string): Promise<{
    path: string;
    contentBase64: string;
    revision: string;
    size: number;
  }> {
    const thread = this.requireThread(threadId);
    const { target, relativePath } = await this.resolveWorkspaceTarget(thread, requestedPath, false);
    const info = await lstat(target);
    if (!info.isFile()) throw new Error(`Not a regular file: ${requestedPath}`);
    if (info.size > 20 * 1024 * 1024) throw new Error('Files larger than 20 MiB require direct transfer.');
    const bytes = await readFile(target);
    return {
      path: relativePath,
      contentBase64: bytes.toString('base64'),
      revision: sha256(bytes),
      size: bytes.length,
    };
  }

  async writeFile(input: {
    threadId: string;
    path: string;
    contentBase64: string;
    expectedRevision?: string;
  }): Promise<{ path: string; revision: string; size: number }> {
    const thread = this.requireThread(input.threadId);
    if (this.runningByThread.has(thread.id)) {
      throw new Error('File edits are disabled while this thread is running.');
    }
    const { target, relativePath } = await this.resolveWorkspaceTarget(thread, input.path, true);
    const existing = await readFile(target).catch((error) => {
      if (isNodeError(error, 'ENOENT')) return null;
      throw error;
    });
    const currentRevision = existing ? sha256(existing) : null;
    if (existing && !input.expectedRevision) {
      throw new Error('File already exists; an expected revision is required to replace it.');
    }
    if (input.expectedRevision && currentRevision !== input.expectedRevision) {
      throw new Error('File save conflict: the harness file changed after it was opened.');
    }
    const bytes = decodeBase64(input.contentBase64);
    await this.createAutomaticCheckpoint(thread, null, `Before file edit: ${relativePath}`);
    await mkdir(dirname(target), { recursive: true });
    const temporary = `${target}.telos-${uuidv7()}.tmp`;
    try {
      await writeFile(temporary, bytes, { flag: 'wx' });
      await rename(temporary, target);
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
    await this.createAutomaticCheckpoint(thread, null, `After file edit: ${relativePath}`);
    const revision = sha256(bytes);
    this.emit(thread.id, 'activity', {
      turnId: null,
      activityType: 'tool',
      state: 'file-written',
      path: relativePath,
      revision,
      size: bytes.length,
      final: true,
    });
    return { path: relativePath, revision, size: bytes.length };
  }

  private async drainWorkspace(workspaceKey: string): Promise<void> {
    if (this.runningWorkspaces.has(workspaceKey)) return;
    this.runningWorkspaces.add(workspaceKey);
    try {
      const queue = this.workspaceQueues.get(workspaceKey);
      while (queue?.length) {
        const job = queue.shift()!;
        try {
          const completed = await this.executeJob(workspaceKey, job);
          job.resolve(completed);
          const sharedChildren = this.sharedChildrenByWorkspace.get(workspaceKey);
          if (sharedChildren?.size) await Promise.allSettled([...sharedChildren]);
        } catch (error) {
          job.reject(error instanceof Error ? error : new Error(String(error)));
        }
      }
      this.workspaceQueues.delete(workspaceKey);
    } finally {
      this.runningWorkspaces.delete(workspaceKey);
    }
  }

  private async executeJob(workspaceKey: string, job: TurnJob): Promise<StoredTurn> {
    const abortController = new AbortController();
    this.runningByThread.set(job.thread.id, {
      threadId: job.thread.id,
      turnId: job.turn.id,
      workspaceKey,
      abortController,
    });
    this.store.updateTurn(job.turn.id, 'running');
    this.store.setThreadStatus(job.thread.id, 'running');
    this.emit(job.thread.id, 'activity', {
      turnId: job.turn.id,
      activityType: 'turn',
      state: 'running',
      final: true,
    });

    let accumulatedText = '';
    let emittedFinalText = false;
    const reasoning = new DeltaBatcher((delta) =>
      this.emit(job.thread.id, 'activity', {
        turnId: job.turn.id,
        activityType: 'reasoning',
        state: 'delta',
        delta,
        final: false,
      }),
    );
    const text = new DeltaBatcher((delta) =>
      this.emit(job.thread.id, 'message.delta', {
        turnId: job.turn.id,
        role: 'assistant',
        delta,
        final: false,
      }),
    );
    const previous = this.store.getExecutorSnapshot(job.thread.id);

    try {
      await this.createAutomaticCheckpoint(job.thread, job.turn.id, 'Before turn');
      const result = await this.executionAdapter.execute({
        thread: job.thread,
        turn: job.turn,
        previousSnapshot: (previous?.snapshot as SessionSnapshot | undefined) || null,
        signal: abortController.signal,
        callbacks: {
          onReasoningDelta: (delta) => reasoning.push(delta),
          onReasoningDone: (fullReasoning) => {
            reasoning.flush();
            this.emit(job.thread.id, 'activity', {
              turnId: job.turn.id,
              activityType: 'reasoning',
              state: 'completed',
              text: fullReasoning,
              final: true,
            });
          },
          onTextDelta: (delta, accumulated) => {
            accumulatedText = accumulated;
            text.push(delta);
          },
          onTextDone: (fullText) => {
            accumulatedText = fullText;
            text.flush();
            emittedFinalText = true;
            this.emit(job.thread.id, 'message', {
              turnId: job.turn.id,
              role: 'assistant',
              text: fullText,
              final: true,
            });
          },
          onAction: (code) => this.emitToolActivity(job, 'action', code),
          onCli: (command) => this.emitToolActivity(job, 'terminal', command),
          onFile: (filename) => this.emitToolActivity(job, 'file', filename),
          onObservation: (output) => this.emitToolActivity(job, 'observation', output),
          onModelSelected: (model, provider, reason) =>
            this.emit(job.thread.id, 'activity', {
              turnId: job.turn.id,
              activityType: 'turn',
              state: 'model-selected',
              model,
              provider,
              reason,
              final: true,
            }),
          onError: () => undefined,
          onCheckpoint: async (snapshot, reason) => {
            this.store.saveExecutorSnapshot(job.thread.id, snapshot, job.turn.id);
            this.emit(job.thread.id, 'activity', {
              turnId: job.turn.id,
              activityType: 'checkpoint',
              state: reason,
              final: true,
            });
          },
          onWorkspaceActivity: (state, detail) => {
            this.emit(job.thread.id, 'activity', {
              turnId: job.turn.id,
              activityType: 'checkpoint',
              state,
              ...detail,
              final: true,
            });
          },
          onServiceRequest: (type, payload, ephemeralPaths) =>
            this.handleExecutionServiceRequest(job, abortController.signal, type, payload, ephemeralPaths),
        },
      });
      reasoning.flush();
      text.flush();
      if (!emittedFinalText && result.response) {
        accumulatedText = result.response;
        this.emit(job.thread.id, 'message', {
          turnId: job.turn.id,
          role: 'assistant',
          text: result.response,
          final: true,
        });
      }
      this.store.saveExecutorSnapshot(job.thread.id, result.snapshot, job.turn.id);
      await this.createAutomaticCheckpoint(job.thread, job.turn.id, 'After completed turn');
      const completed = this.store.updateTurn(job.turn.id, 'completed');
      this.store.setThreadStatus(job.thread.id, 'idle', job.turn.id);
      this.emit(job.thread.id, 'activity', {
        turnId: job.turn.id,
        activityType: 'turn',
        state: 'completed',
        final: true,
      });
      return completed;
    } catch (error) {
      reasoning.flush();
      text.flush();
      const stopped = abortController.signal.aborted;
      if (accumulatedText && !emittedFinalText) {
        this.emit(job.thread.id, 'message', {
          turnId: job.turn.id,
          role: 'assistant',
          text: accumulatedText,
          partial: true,
          final: true,
        });
      }
      const message = error instanceof Error ? error.message : String(error);
      await this.createAutomaticCheckpoint(
        job.thread,
        job.turn.id,
        stopped ? 'After stopped turn' : 'After failed turn',
      ).catch((checkpointError) => {
        this.emit(job.thread.id, 'activity', {
          turnId: job.turn.id,
          activityType: 'checkpoint',
          state: 'failed',
          error: checkpointError instanceof Error ? checkpointError.message : String(checkpointError),
          final: true,
        });
      });
      const completed = this.store.updateTurn(job.turn.id, stopped ? 'stopped' : 'failed', {
        error: stopped ? null : message,
      });
      this.store.setThreadStatus(job.thread.id, stopped ? 'stopped' : 'failed', job.turn.id);
      this.emit(job.thread.id, 'activity', {
        turnId: job.turn.id,
        activityType: 'turn',
        state: stopped ? 'stopped' : 'failed',
        error: stopped ? undefined : message,
        final: true,
      });
      return completed;
    } finally {
      reasoning.dispose();
      text.dispose();
      this.runningByThread.delete(job.thread.id);
    }
  }

  private emitToolActivity(job: TurnJob, tool: string, detail: string): void {
    this.emit(job.thread.id, 'activity', {
      turnId: job.turn.id,
      activityType: 'tool',
      state: 'observed',
      tool,
      detail,
      final: true,
    });
  }

  private handleExecutionServiceRequest(
    job: TurnJob,
    signal: AbortSignal,
    type: string,
    payload: unknown,
    ephemeralPaths: string[] = [],
  ): unknown | Promise<unknown> {
    const body = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {};
    if (type.startsWith('terminal.')) {
      return this.handleTerminalServiceRequest(job, type, body);
    }
    if (type.startsWith('agents.')) {
      return this.handleAgentServiceRequest(job, signal, type, body);
    }
    if (type === 'message.publish') {
      const text = typeof body.text === 'string' ? body.text.trim() : '';
      if (!text) throw new Error('message.publish requires non-empty text.');
      this.emit(job.thread.id, 'message', {
        turnId: job.turn.id,
        role: 'assistant',
        text,
        source: 'message-tool',
        final: true,
      });
      return { published: true };
    }
    if (type === 'attachment.publish' || type === 'voice.publish') {
      return this.publishExecutionAttachments(job, type, body, ephemeralPaths);
    }
    if (type !== 'interaction.create') {
      throw new Error(`Unsupported thread service request: ${type}`);
    }
    const request = body.request && typeof body.request === 'object'
      ? body.request as Record<string, unknown>
      : null;
    if (!request) throw new Error('interaction.create requires a structured request.');
    const timeoutMs = typeof body.timeoutMs === 'number' && Number.isFinite(body.timeoutMs)
      ? Math.max(1_000, Math.min(body.timeoutMs, 24 * 60 * 60 * 1_000))
      : undefined;
    const expiresAt = timeoutMs ? new Date(Date.now() + timeoutMs).toISOString() : null;
    const interaction = this.store.createInteraction({
      threadId: job.thread.id,
      turnId: job.turn.id,
      request,
      expiresAt,
    });
    this.store.setThreadStatus(job.thread.id, 'waiting-input');
    this.emit(job.thread.id, 'interaction', {
      interactionId: interaction.id,
      turnId: job.turn.id,
      state: 'requested',
      request,
      expiresAt,
      final: true,
    });
    return new Promise<Record<string, unknown>>((resolveAnswer, rejectAnswer) => {
      const waiter: InteractionWaiter = {
        threadId: job.thread.id,
        resolve: resolveAnswer,
        reject: rejectAnswer,
      };
      if (timeoutMs) {
        waiter.timer = setTimeout(() => {
          this.interactionWaiters.delete(interaction.id);
          this.store.expireInteraction(interaction.id);
          this.emit(job.thread.id, 'interaction', {
            interactionId: interaction.id,
            turnId: job.turn.id,
            state: 'expired',
            final: true,
          });
          rejectAnswer(new Error('message.ask expired before an interface answered.'));
        }, timeoutMs);
        waiter.timer.unref?.();
      }
      const onAbort = () => {
        if (waiter.timer) clearTimeout(waiter.timer);
        this.interactionWaiters.delete(interaction.id);
        this.store.expireInteraction(interaction.id);
        this.emit(job.thread.id, 'interaction', {
          interactionId: interaction.id,
          turnId: job.turn.id,
          state: 'expired',
          final: true,
        });
        rejectAnswer(new Error('message.ask was cancelled with its turn.'));
      };
      signal.addEventListener('abort', onAbort, { once: true });
      const originalResolve = waiter.resolve;
      waiter.resolve = (answer) => {
        signal.removeEventListener('abort', onAbort);
        originalResolve(answer);
      };
      this.interactionWaiters.set(interaction.id, waiter);
    });
  }

  private async handleAgentServiceRequest(
    parentJob: TurnJob,
    signal: AbortSignal,
    type: string,
    body: Record<string, unknown>,
  ): Promise<unknown> {
    const jobName = typeof body.jobName === 'string' ? body.jobName : '';
    if (!jobName) throw new Error(`${type} requires jobName.`);
    if (type === 'agents.run' || type === 'agents.start') {
      const existing = this.managedChildJobs.get(jobName);
      if (existing) return type === 'agents.run' ? this.childResult(existing) : this.childSummary(existing);
      const agentName = typeof body.agentName === 'string' ? body.agentName : '';
      const input = typeof body.input === 'string' ? body.input : '';
      if (!agentName || !input) throw new Error(`${type} requires agentName and input.`);
      const managed = await this.startManagedChild(parentJob, signal, { jobName, agentName, input });
      if (type === 'agents.start') return this.childSummary(managed);
      await managed.promise;
      return this.childResult(managed);
    }
    const managed = this.managedChildJobs.get(jobName);
    if (!managed) throw new Error(`agents job "${jobName}" does not exist.`);
    if (type === 'agents.status') return this.childSummary(managed);
    if (type === 'agents.result') {
      if (managed.status === 'running' || managed.status === 'stopping') {
        throw new Error(`agents job "${jobName}" is still ${managed.status}`);
      }
      return this.childResult(managed);
    }
    if (type === 'agents.trace') {
      const tail = typeof body.tail === 'number' ? Math.max(1, Math.floor(body.tail)) : undefined;
      const trace = this.store.replayEvents(managed.childThreadId, 0, 1_000).map((event) => {
        const payload = event.payload as Record<string, unknown>;
        const text = typeof payload.text === 'string' ? payload.text
          : typeof payload.delta === 'string' ? payload.delta
          : `${String(payload.activityType || event.type)}: ${String(payload.state || '')}`;
        return `[${event.type}] ${text}`;
      });
      return { trace: (tail ? trace.slice(-tail) : trace).join('\n') || '(no trace yet)' };
    }
    if (type === 'agents.send') {
      const input = typeof body.input === 'string' ? body.input.trim() : '';
      if (!input) throw new Error('agents.send requires input.');
      managed.pendingMessages += 1;
      managed.status = 'running';
      managed.updatedAt = new Date().toISOString();
      const followup = this.enqueueSharedChildTurn(
        this.requireThread(managed.childThreadId), input, managed.parentThreadId);
      managed.promise = this.finishManagedChild(managed, followup);
      this.trackSharedChild(managed.childThreadId, managed.promise);
      return { message: `Queued message for agent job "${jobName}".` };
    }
    if (type === 'agents.stop') {
      managed.status = 'stopping';
      managed.updatedAt = new Date().toISOString();
      const stopping = this.stop(managed.childThreadId);
      return { message: stopping ? `Stopping agent job "${jobName}".`
        : `Agent job "${jobName}" is ${managed.status}.` };
    }
    throw new Error(`Unsupported thread service request: ${type}`);
  }

  private async startManagedChild(
    parentJob: TurnJob,
    signal: AbortSignal,
    input: { jobName: string; agentName: string; input: string },
  ): Promise<ManagedChildJob> {
    const loaded = await new AgentLoader().loadByName(input.agentName);
    if (!loaded) throw new Error(`Agent not found: ${input.agentName}`);
    const providerId = String(loaded.config.provider || '');
    const modelId = String(loaded.config.model || '');
    if (!providerId || !modelId) throw new Error(`Agent ${input.agentName} has no executable provider/model.`);
    const reasoning = normalizeReasoningEffort(loaded.config.reasoning);
    const child = await this.createThread({
      projectId: parentJob.thread.projectId,
      worktreePath: parentJob.thread.launchProfile.worktreePath,
      agentName: input.agentName,
      providerId,
      modelId,
      reasoning,
      parentThreadId: parentJob.thread.id,
      title: input.input.trim().slice(0, 80) || input.agentName,
    });
    const now = new Date().toISOString();
    const managed: ManagedChildJob = {
      jobName: input.jobName, parentThreadId: parentJob.thread.id, childThreadId: child.id,
      agentName: input.agentName, status: 'running', startedAt: now, updatedAt: now,
      pendingMessages: 0, promise: Promise.resolve(),
    };
    this.managedChildJobs.set(input.jobName, managed);
    this.emit(parentJob.thread.id, 'activity', {
      turnId: parentJob.turn.id, activityType: 'child-thread', state: 'created',
      childThreadId: child.id, jobName: input.jobName, agentName: input.agentName,
      providerId, modelId, reasoning, final: true,
    });
    const completed = this.enqueueSharedChildTurn(child, input.input, parentJob.thread.id);
    managed.promise = this.finishManagedChild(managed, completed);
    this.trackSharedChild(child.id, managed.promise);
    signal.addEventListener('abort', () => this.stop(child.id), { once: true });
    return managed;
  }

  private enqueueSharedChildTurn(
    thread: HarnessThread,
    text: string,
    parentThreadId: string,
  ): Promise<StoredTurn> {
    const turn = this.store.createTurn({
      threadId: thread.id, text, requestedEffort: thread.launchProfile.reasoning,
      effectiveEffort: effectiveEffort(thread.launchProfile.providerId, thread.launchProfile.reasoning),
    });
    this.emit(thread.id, 'message', { turnId: turn.id, role: 'user', text, attachmentIds: [], final: true });
    this.emit(thread.id, 'activity', { turnId: turn.id, activityType: 'turn', state: 'queued', final: true });
    this.store.setThreadStatus(thread.id, 'queued');
    return new Promise<StoredTurn>((resolveTurn, rejectTurn) => {
      const workspaceKey = this.workspaceKey(thread.launchProfile.worktreePath || thread.launchProfile.workspacePath);
      void this.executeJob(workspaceKey, { thread, turn, resolve: resolveTurn, reject: rejectTurn })
        .then(resolveTurn, rejectTurn);
    });
  }

  private async finishManagedChild(managed: ManagedChildJob, completed: Promise<StoredTurn>): Promise<void> {
    try {
      const turn = await completed;
      managed.status = turn.status === 'completed' ? 'completed' : turn.status === 'stopped' ? 'stopped' : 'failed';
      managed.error = turn.error || undefined;
      managed.finalMessage = this.latestAssistantMessage(managed.childThreadId, turn.id);
      managed.pendingMessages = Math.max(0, managed.pendingMessages - 1);
      managed.updatedAt = new Date().toISOString();
      this.emit(managed.parentThreadId, 'activity', {
        turnId: null, activityType: 'child-thread', state: managed.status,
        childThreadId: managed.childThreadId, jobName: managed.jobName,
        result: managed.finalMessage, error: managed.error, final: true,
      });
    } catch (error) {
      managed.status = 'failed';
      managed.error = error instanceof Error ? error.message : String(error);
      managed.updatedAt = new Date().toISOString();
    }
  }

  private childSummary(job: ManagedChildJob): Record<string, unknown> {
    return { jobName: job.jobName, childThreadId: job.childThreadId, agentName: job.agentName,
      status: job.status, startedAt: job.startedAt, updatedAt: job.updatedAt,
      pendingMessages: job.pendingMessages, ...(job.error ? { error: job.error } : {}) };
  }

  private childResult(job: ManagedChildJob): Record<string, unknown> {
    return { jobName: job.jobName, childThreadId: job.childThreadId,
      finalMessage: job.finalMessage || job.error || '', changedFiles: [] };
  }

  private latestAssistantMessage(threadId: string, turnId: string): string {
    const event = this.store.replayEvents(threadId, 0, 1_000).reverse().find((candidate) => {
      const payload = candidate.payload as Record<string, unknown>;
      return candidate.type === 'message' && payload.turnId === turnId && payload.role === 'assistant';
    });
    if (!event) return '';
    const payload = event.payload as Record<string, unknown>;
    return typeof payload.text === 'string' ? payload.text : '';
  }

  private trackSharedChild(childThreadId: string, promise: Promise<void>): void {
    const child = this.requireThread(childThreadId);
    const key = this.workspaceKey(child.launchProfile.worktreePath || child.launchProfile.workspacePath);
    const active = this.sharedChildrenByWorkspace.get(key) || new Set<Promise<void>>();
    active.add(promise);
    this.sharedChildrenByWorkspace.set(key, active);
    void promise.finally(() => {
      active.delete(promise);
      if (!active.size) this.sharedChildrenByWorkspace.delete(key);
    });
  }

  private async publishExecutionAttachments(
    job: TurnJob,
    type: 'attachment.publish' | 'voice.publish',
    body: Record<string, unknown>,
    ephemeralPaths: string[],
  ): Promise<{ attachments: StoredAttachment[] }> {
    const requested = type === 'voice.publish' ? [body.path] : Array.isArray(body.paths) ? body.paths : [];
    const paths = requested.filter((value): value is string => typeof value === 'string' && !!value.trim());
    if (!paths.length) throw new Error(`${type} requires at least one file path.`);
    const workspace = this.workspacePath(job.thread);
    const allowedEphemeral = new Set(ephemeralPaths.map((value) => resolve(value)));
    const created: StoredAttachment[] = [];
    for (const requestedPath of paths) {
      const absolute = resolve(workspace, requestedPath);
      const relativePath = relative(workspace, absolute);
      if (type !== 'voice.publish'
        && (relativePath.startsWith('..') || isAbsolute(relativePath))
        && !allowedEphemeral.has(absolute)) {
        throw new Error(`Attachment source escapes the thread workspace: ${requestedPath}`);
      }
      const attachment = await this.attachments.createFromFile({
        threadId: job.thread.id,
        sourcePath: absolute,
        name: type === 'voice.publish' && typeof body.name === 'string' ? body.name : undefined,
        mimeType: type === 'voice.publish' ? 'audio/ogg' : undefined,
      });
      created.push(attachment);
      this.emit(job.thread.id, 'attachment', {
        turnId: job.turn.id, attachmentId: attachment.id, state: 'created', name: attachment.name,
        mimeType: attachment.mimeType, size: attachment.size, sha256: attachment.sha256,
        source: type === 'voice.publish' ? 'tts' : 'message-tool',
        text: type === 'voice.publish' && typeof body.text === 'string' ? body.text : undefined,
        final: true,
      });
    }
    return { attachments: created };
  }

  private async handleTerminalServiceRequest(
    job: TurnJob,
    type: string,
    body: Record<string, unknown>,
  ): Promise<unknown> {
    const options = body.options && typeof body.options === 'object'
      ? body.options as Record<string, unknown>
      : {};
    const name = typeof body.name === 'string' ? body.name : '';
    const terminalId = name ? this.agentTerminalId(job.thread.id, name) : '';
    if (type === 'terminal.run') {
      return this.terminals.run({
        threadId: job.thread.id,
        command: String(body.command || ''),
        cwd: typeof options.cwd === 'string' ? options.cwd : undefined,
        timeoutMs: typeof options.timeoutMs === 'number' ? options.timeoutMs : undefined,
      });
    }
    if (type === 'terminal.start') {
      const terminal = await this.terminals.open({
        threadId: job.thread.id,
        terminalId,
        command: String(body.command || ''),
        cwd: typeof options.cwd === 'string' ? options.cwd : undefined,
        cols: typeof options.cols === 'number' ? options.cols : undefined,
        rows: typeof options.rows === 'number' ? options.rows : undefined,
        keepOpen: true,
      });
      return { terminalId: terminal.id };
    }
    if (!name && type !== 'terminal.list' && type !== 'terminal.stopAll') {
      throw new Error(`${type} requires a terminal name.`);
    }
    if (type === 'terminal.read') {
      const terminal = this.terminals.get(job.thread.id, terminalId);
      const tail = typeof options.tail === 'number' ? Math.max(1, Math.floor(options.tail)) : undefined;
      const output = tail
        ? terminal.history.split(/\r?\n/u).slice(-tail).join('\n')
        : terminal.history;
      return { output: output || '(no output yet)' };
    }
    if (type === 'terminal.send') {
      await this.terminals.write({
        threadId: job.thread.id,
        terminalId,
        data: String(body.text || ''),
      });
      return undefined;
    }
    if (type === 'terminal.stop') {
      await this.terminals.closeTerminal({ threadId: job.thread.id, terminalId });
      return undefined;
    }
    if (type === 'terminal.stopAll') {
      const ids = this.terminals.list(job.thread.id)
        .filter((terminal) => terminal.id.startsWith(`${job.thread.id}:agent:`))
        .map((terminal) => terminal.id);
      for (const id of ids) await this.terminals.closeTerminal({ threadId: job.thread.id, terminalId: id });
      return undefined;
    }
    if (type === 'terminal.list') {
      return this.terminals.list(job.thread.id)
        .filter((terminal) => terminal.id.startsWith(`${job.thread.id}:agent:`))
        .map((terminal) => ({
          name: terminal.id.slice(`${job.thread.id}:agent:`.length),
          command: terminal.command,
          startedAt: terminal.createdAt,
          running: terminal.status === 'running',
          pid: terminal.pid || undefined,
          exitCode: terminal.exitCode ?? undefined,
        }));
    }
    throw new Error(`Unsupported terminal service request: ${type}`);
  }

  private agentTerminalId(threadId: string, name: string): string {
    if (!/^[A-Za-z0-9_.-]+$/u.test(name)) throw new Error(`Invalid terminal name: ${name}`);
    return `${threadId}:agent:${name}`;
  }

  private async createAutomaticCheckpoint(
    thread: HarnessThread,
    turnId: string | null,
    name: string,
  ): Promise<void> {
    if (!this.workspaceSnapshots) return;
    const checkpoint = await this.workspaceSnapshots.snapshot({
      workspacePath: thread.launchProfile.worktreePath || thread.launchProfile.workspacePath,
      threadId: thread.id,
      turnId,
      name,
    });
    this.emit(thread.id, 'activity', {
      turnId,
      activityType: 'checkpoint',
      state: 'created',
      checkpointId: checkpoint.id,
      name,
      final: true,
    });
  }

  private emit(threadId: string, type: string, payload: Record<string, unknown>): StoredThreadEvent {
    const event = this.store.appendEvent(threadId, type, payload);
    for (const subscriber of this.subscribers.get(threadId) || []) subscriber(event);
    return event;
  }

  private requireThread(threadId: string): HarnessThread {
    const thread = this.store.getThread(threadId);
    if (!thread) throw new Error(`Thread not found: ${threadId}`);
    return thread;
  }

  private workspacePath(thread: HarnessThread): string {
    return resolve(thread.launchProfile.worktreePath || thread.launchProfile.workspacePath);
  }

  private async resolveWorkspaceTarget(
    thread: HarnessThread,
    requestedPath: string,
    allowMissing: boolean,
  ): Promise<{ target: string; relativePath: string }> {
    const root = this.workspacePath(thread);
    const target = resolve(root, requestedPath || '.');
    const lexical = relative(root, target);
    if (lexical.startsWith('..') || isAbsolute(lexical)) {
      throw new Error(`Path escapes the thread workspace: ${requestedPath}`);
    }
    const rootReal = await realpath(root);
    let checkPath = allowMissing ? dirname(target) : target;
    let checkReal: string;
    for (;;) {
      try {
        checkReal = await realpath(checkPath);
        break;
      } catch (error) {
        if (!allowMissing || !isNodeError(error, 'ENOENT') || checkPath === root) throw error;
        const parent = dirname(checkPath);
        if (parent === checkPath) throw error;
        checkPath = parent;
      }
    }
    const physical = relative(rootReal, checkReal);
    if (physical.startsWith('..') || isAbsolute(physical)) {
      throw new Error(`Path resolves outside the thread workspace: ${requestedPath}`);
    }
    return { target, relativePath: normalizeRelative(lexical) };
  }

  private workspaceKey(path: string): string {
    const normalized = resolve(path);
    return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
  }
}

export class HarnessThreadExecutionAdapter implements ThreadExecutionAdapter {
  constructor(
    private readonly workspaceSnapshots?: WorkspaceSnapshotService,
    private readonly agentLoader = new AgentLoader(),
    private readonly toolLoader = new ToolLoader(),
  ) {}

  async execute(input: {
    thread: HarnessThread;
    turn: StoredTurn;
    previousSnapshot: SessionSnapshot | null;
    signal: AbortSignal;
    callbacks: ThreadExecutionCallbacks;
  }): Promise<ThreadExecutionResult> {
    const source = await this.agentLoader.loadByName(input.thread.launchProfile.agentName);
    if (!source) throw new Error(`Agent not found: ${input.thread.launchProfile.agentName}`);
    const agent = this.resolveAgent(source, input.thread.launchProfile);
    const runtime = resolveTextAgentRuntime(agent);
    const tools = await loadAgentTools(agent, this.toolLoader, ['message']);
    const workspacePath = input.thread.launchProfile.worktreePath
      || input.thread.launchProfile.workspacePath;
    const sandbox = new LocalSandbox({
      existingPath: workspacePath,
      serviceHandler: (request) => this.handleServiceRequest(request, input),
    });
    const session = new Session({
      agent,
      provider: runtime.provider,
      syntax: runtime.syntax,
      loop: runtime.loop,
      tools,
      sandbox,
    });
    await session.initialize();
    try {
      if (input.previousSnapshot) session.applySnapshot(input.previousSnapshot);
      const callbacks: ExecutorCallbacks = {
        ...input.callbacks,
        onTextDone: (fullText) => {
          session.recordVisibleAssistantOutput(fullText);
          input.callbacks.onTextDone?.(fullText);
        },
      };
      const executor = new Executor(session, {
        stream: true,
        callbacks,
        requireFinish: agent.config.requireFinish,
        signal: input.signal,
        onCheckpoint: (snapshot, metadata) => input.callbacks.onCheckpoint(snapshot, metadata.reason),
      });
      const response = await executor.execute(input.turn.inputText);
      return { response, snapshot: session.exportSnapshot() };
    } finally {
      await session.cleanup();
    }
  }

  private async handleServiceRequest(
    request: { type: string; payload: unknown; ephemeralPaths: string[] },
    input: {
      thread: HarnessThread;
      turn: StoredTurn;
      callbacks: ThreadExecutionCallbacks;
    },
  ): Promise<unknown> {
    const { type, payload } = request;
    if (type === 'interaction.create' || type === 'message.publish'
      || type === 'attachment.publish' || type === 'voice.publish'
      || type.startsWith('agents.') || type.startsWith('terminal.')) {
      if (!input.callbacks.onServiceRequest) throw new Error(`Unsupported harness service request: ${type}`);
      return input.callbacks.onServiceRequest(type, payload, request.ephemeralPaths);
    }
    if (!this.workspaceSnapshots || !type.startsWith('code.')) {
      throw new Error(`Unsupported harness service request: ${type}`);
    }
    const body = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {};
    const workspacePath = input.thread.launchProfile.worktreePath
      || input.thread.launchProfile.workspacePath;
    if (type === 'code.snapshot') {
      const checkpoint = await this.workspaceSnapshots.snapshot({
        workspacePath,
        threadId: input.thread.id,
        turnId: input.turn.id,
        name: typeof body.name === 'string' ? body.name : undefined,
        ignorePatterns: request.ephemeralPaths,
      });
      input.callbacks.onWorkspaceActivity?.('created', { checkpointId: checkpoint.id, source: 'agent' });
      return checkpoint;
    }
    if (type === 'code.listSnapshots') {
      return this.workspaceSnapshots.listSnapshots({ threadId: input.thread.id });
    }
    const snapshotId = typeof body.snapshotId === 'string' ? body.snapshotId : '';
    if (!snapshotId) throw new Error(`${type} requires snapshotId.`);
    const checkpoint = this.workspaceSnapshots
      .listSnapshots({ workspacePath })
      .find((candidate) => candidate.id === snapshotId);
    if (!checkpoint || (checkpoint.threadId !== null && checkpoint.threadId !== input.thread.id)) {
      throw new Error(`Checkpoint is not available to this thread: ${snapshotId}`);
    }
    const files = Array.isArray(body.files)
      ? body.files.filter((file): file is string => typeof file === 'string')
      : undefined;
    if (type === 'code.diff') {
      return this.workspaceSnapshots.diff(snapshotId, {
        files,
        ignorePatterns: request.ephemeralPaths,
      });
    }
    if (type === 'code.rollback') {
      const result = await this.workspaceSnapshots.rollback(snapshotId, {
        files,
        threadId: input.thread.id,
        turnId: input.turn.id,
        ignorePatterns: request.ephemeralPaths,
      });
      input.callbacks.onWorkspaceActivity?.('restored', {
        checkpointId: snapshotId,
        safetyCheckpointId: result.safetyCheckpoint.id,
        source: 'agent',
      });
      return result;
    }
    if (type === 'code.deleteSnapshot') {
      await this.workspaceSnapshots.deleteSnapshot(snapshotId);
      input.callbacks.onWorkspaceActivity?.('deleted', { checkpointId: snapshotId, source: 'agent' });
      return undefined;
    }
    throw new Error(`Unsupported harness service request: ${type}`);
  }

  private resolveAgent(source: LoadedAgent, profile: ThreadLaunchProfile): LoadedAgent {
    const snapshot = profile.resolvedAgentConfig as unknown as AgentConfig;
    const config: AgentConfig = {
      ...structuredClone(source.config),
      ...structuredClone(snapshot),
      provider: profile.providerId,
      model: profile.modelId,
      reasoning: profile.reasoning,
      preserveSession: true,
      modelSwitching: {
        ...(snapshot.modelSwitching || source.config.modelSwitching || {}),
        mode: 'whitelist',
        whitelist: [profile.modelId],
      },
    };
    return { ...source, config };
  }
}

function effectiveEffort(providerId: string, requested: ReasoningEffort): ReasoningEffort {
  if (requested !== 'xhigh') return requested;
  return providerId.toLowerCase() === 'openai-codex' ? 'xhigh' : 'high';
}

function normalizeReasoningEffort(value: unknown): ReasoningEffort {
  return value === 'off' || value === 'low' || value === 'medium' || value === 'high' || value === 'xhigh'
    ? value
    : 'high';
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function normalizeRelative(path: string): string {
  return path === '' ? '' : path.split('\\').join('/');
}

function decodeBase64(value: string): Buffer {
  if (typeof value !== 'string') throw new Error('File content is not valid base64.');
  const normalized = value.replace(/\s+/gu, '').replace(/=+$/u, '');
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64').replace(/=+$/u, '') !== normalized) {
    throw new Error('File content is not valid base64.');
  }
  return bytes;
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === code;
}

class DeltaBatcher {
  private chunks: string[] = [];
  private size = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly publish: (delta: string) => void) {}

  push(delta: string): void {
    if (!delta) return;
    this.chunks.push(delta);
    this.size += Buffer.byteLength(delta);
    if (this.size >= 16 * 1024) {
      this.flush();
      return;
    }
    if (!this.timer) {
      this.timer = setTimeout(() => this.flush(), 50);
      this.timer.unref?.();
    }
  }

  flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.chunks.length === 0) return;
    const delta = this.chunks.join('');
    this.chunks = [];
    this.size = 0;
    this.publish(delta);
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
