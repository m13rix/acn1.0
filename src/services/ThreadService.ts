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
import type { HarnessThread, StoredInteraction, StoredThreadEvent, StoredTurn } from './thread-store/types.js';
import { WorkspaceSnapshotService } from './WorkspaceSnapshotService.js';

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

export type ThreadEventSubscriber = (event: StoredThreadEvent) => void;

export class ThreadService {
  private readonly executionAdapter: ThreadExecutionAdapter;
  private readonly workspaceQueues = new Map<string, TurnJob[]>();
  private readonly runningWorkspaces = new Set<string>();
  private readonly runningByThread = new Map<string, RunningTurn>();
  private readonly interactionWaiters = new Map<string, InteractionWaiter>();
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
          onServiceRequest: (type, payload) =>
            this.handleExecutionServiceRequest(job, abortController.signal, type, payload),
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
  ): unknown | Promise<unknown> {
    const body = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {};
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
    if (type === 'interaction.create' || type === 'message.publish') {
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
