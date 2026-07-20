import { resolve } from 'node:path';
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
import type { HarnessThread, StoredThreadEvent, StoredTurn } from './thread-store/types.js';
import { WorkspaceSnapshotService } from './WorkspaceSnapshotService.js';

export interface ThreadExecutionCallbacks extends ExecutorCallbacks {
  onCheckpoint(snapshot: SessionSnapshot, reason: string): void | Promise<void>;
  onWorkspaceActivity?(state: string, detail: Record<string, unknown>): void;
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

export type ThreadEventSubscriber = (event: StoredThreadEvent) => void;

export class ThreadService {
  private readonly executionAdapter: ThreadExecutionAdapter;
  private readonly workspaceQueues = new Map<string, TurnJob[]>();
  private readonly runningWorkspaces = new Set<string>();
  private readonly runningByThread = new Map<string, RunningTurn>();
  private readonly subscribers = new Map<string, Set<ThreadEventSubscriber>>();
  private readonly workspaceSnapshots: WorkspaceSnapshotService | undefined;

  constructor(
    readonly store: ThreadStore,
    options: {
      executionAdapter?: ThreadExecutionAdapter;
      workspaceSnapshots?: WorkspaceSnapshotService;
    } = {},
  ) {
    this.workspaceSnapshots = options.workspaceSnapshots;
    this.executionAdapter = options.executionAdapter
      || new HarnessThreadExecutionAdapter(options.workspaceSnapshots);
  }

  async createThread(input: {
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
