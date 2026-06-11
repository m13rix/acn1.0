import { DEFAULT_MEMORY_CONFIG } from '../memory_system/types.js';
import { embedText } from '../memory_system/embeddings.js';
import type { LoadedAgent, Message } from '../types/index.js';
import type { Session } from '../core/Session.js';
import { mkdir, writeFile } from 'fs/promises';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

export type AdaptiveStepChannel = 'reasoning' | 'output' | 'observation';

export interface AdaptiveStepEmbeddings {
  reasoning?: number[];
  output?: number[];
  observation?: number[];
}

export interface AdaptiveProjectionSnapshot {
  fromStepIndex: number;
  alpha: number;
  vectors: AdaptiveStepEmbeddings;
}

export interface AdaptiveStepRecord {
  id: string;
  sessionId: string;
  agentName: string;
  index: number;
  createdAt: string;
  reasoning: string;
  output: string;
  observation: string;
  toolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }>;
  embeddingStatus: 'pending' | 'ready' | 'error';
  embeddingError?: string;
  embeddings: AdaptiveStepEmbeddings;
  projectionBeforeStep?: AdaptiveProjectionSnapshot;
}

export interface AdaptiveSessionRecord {
  id: string;
  agentName: string;
  startedAt: string;
  goal: string;
  embeddingModel: string;
  goalEmbeddingStatus: 'pending' | 'ready' | 'error';
  goalEmbedding?: number[];
  goalEmbeddingError?: string;
  steps: AdaptiveStepRecord[];
}

interface PendingStepInput {
  session: Session;
  messages: Message[];
  stepNumber?: number;
}

const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const STORE_DIR = join(PROJECT_ROOT, 'data', 'adaptive-step-context');
const DEFAULT_PRUNING_HEAT_THRESHOLD = 0.6;
const DEFAULT_SCORING = {
  current: 0,
  currentChannels: { reasoning: 1.35, output: 0.85, observation: 0.75 },
  goal: 0,
  projected: 1,
  projectedChannels: { reasoning: 2.1, output: 1.1, observation: 1 },
  projectionAlpha: 1.5,
  recency: 0,
  recencyRange: 6,
};
const CONTENT_ARG_KEYS = ['content', 'text', 'body', 'data', 'value'] as const;

function isEnabled(agent: LoadedAgent): boolean {
  return agent.config.adaptiveStepContext?.enabled === true
    || agent.config.adaptiveStepContext?.debug?.enabled === true;
}

function isPruningEnabled(agent: LoadedAgent): boolean {
  return isEnabled(agent) && agent.config.adaptiveStepContext?.pruning?.enabled === true;
}

function isDebugEnabled(agent: LoadedAgent): boolean {
  return agent.config.adaptiveStepContext?.debug?.enabled === true;
}

function compactText(value: string, maxChars = 24000): string {
  const text = String(value || '').trim();
  if (text.length <= maxChars) return text;
  const head = Math.floor(maxChars * 0.72);
  const tail = Math.max(0, maxChars - head - 160);
  return `${text.slice(0, head)}\n\n[adaptive-step-context truncated ${text.length - head - tail} chars]\n\n${text.slice(text.length - tail)}`;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function cleanObservation(value: string): string {
  return String(value || '')
    .split(/\r?\n/)
    .filter(line => {
      const text = line.trim();
      if (!text) return true;
      if (text === '[Message] Module loaded successfully. sendVoice function is available.') return false;
      if (/^\[Heartbeat\] Initialized with \d+ binding\(s\) and \d+ sensor\(s\)\.$/.test(text)) return false;
      if (/^\[Heartbeat\] Loaded binding IDs:/.test(text)) return false;
      if (/^\[Notes Sensor\] Poll complete: \d+ note\(s\) scanned, 0 note\(s\) queued\/refreshed/.test(text)) return false;
      return true;
    })
    .join('\n')
    .trim();
}

function firstUserMessage(session: Session): string {
  return session.getMessages().find(message => message.role === 'user')?.content || '';
}

function addVectors(left?: number[], right?: number[]): number[] | undefined {
  if (!left || !right || left.length !== right.length) return undefined;
  return left.map((value, index) => value + right[index]!);
}

function subtractVectors(left?: number[], right?: number[]): number[] | undefined {
  if (!left || !right || left.length !== right.length) return undefined;
  return left.map((value, index) => value - right[index]!);
}

function scaleVector(vector: number[] | undefined, alpha: number): number[] | undefined {
  return vector?.map(value => value * alpha);
}

function projectChannel(current?: number[], previous?: number[], alpha = 1): number[] | undefined {
  const velocity = subtractVectors(current, previous);
  return addVectors(current, scaleVector(velocity, alpha));
}

function projectFromSteps(current?: AdaptiveStepRecord, previous?: AdaptiveStepRecord, alpha = 1): AdaptiveStepEmbeddings {
  return {
    reasoning: projectChannel(current?.embeddings.reasoning, previous?.embeddings.reasoning, alpha),
    output: projectChannel(current?.embeddings.output, previous?.embeddings.output, alpha),
    observation: projectChannel(current?.embeddings.observation, previous?.embeddings.observation, alpha),
  };
}

function dot(a?: number[], b?: number[]): number | null {
  if (!a || !b || a.length !== b.length || a.length === 0) return null;
  return a.reduce((sum, value, index) => sum + value * b[index]!, 0);
}

function cosine01(a?: number[], b?: number[]): number | null {
  const value = dot(a, b);
  if (value === null || !Number.isFinite(value)) return null;
  return Math.max(0, Math.min(1, (value + 1) / 2));
}

function avgVectors(vectors: Array<number[] | undefined>): number[] | undefined {
  const valid = vectors.filter((vector): vector is number[] => Array.isArray(vector) && vector.length > 0);
  if (valid.length === 0) return undefined;
  const len = valid[0]!.length;
  if (!valid.every(vector => vector.length === len)) return undefined;
  return valid[0]!.map((_, index) => valid.reduce((sum, vector) => sum + vector[index]! / valid.length, 0));
}

function stepCombined(step: AdaptiveStepRecord): number[] | undefined {
  return avgVectors([step.embeddings.reasoning, step.embeddings.output, step.embeddings.observation]);
}

function channelScore(step: AdaptiveStepRecord, target: AdaptiveStepEmbeddings, weights: Record<AdaptiveStepChannel, number>): number {
  let total = 0;
  let weightTotal = 0;
  for (const channel of ['reasoning', 'output', 'observation'] as AdaptiveStepChannel[]) {
    const weight = weights[channel] ?? 0;
    const score = cosine01(step.embeddings[channel], target[channel]);
    if (score !== null && weight > 0) {
      total += score * weight;
      weightTotal += weight;
    }
  }
  return weightTotal > 0 ? total / weightTotal : 0;
}

function firstWords(value: string, count = 5): string {
  return String(value || '').trim().split(/\s+/).filter(Boolean).slice(0, count).join(' ');
}

function summarizeForColdStep(value: string, stepNumber: number): string {
  const prefix = firstWords(value, 10);
  return `${prefix}${prefix ? '... ' : ''}<Summarized. To view in full use utils.context.view(${stepNumber})>`;
}

function summarizeObservation(value: string): string {
  const prefix = firstWords(value, 10);
  return `${prefix}${prefix ? '... ' : ''}<Summarized>`;
}

export class AdaptiveStepContextService {
  private static instance: AdaptiveStepContextService | null = null;
  private readonly sessions = new Map<string, AdaptiveSessionRecord>();
  private readonly embeddingPromises = new Set<Promise<void>>();

  static getInstance(): AdaptiveStepContextService {
    if (!this.instance) {
      this.instance = new AdaptiveStepContextService();
    }
    return this.instance;
  }

  async ensureForSession(session: Session): Promise<void> {
    if (!isEnabled(session.agent)) return;

    const record = this.getOrCreateSession(session);
    if (record.goal && !record.goalEmbedding && record.goalEmbeddingStatus === 'pending') {
      this.queueEmbedding(async () => {
        try {
          record.goalEmbedding = await embedText(record.goal, record.embeddingModel, undefined, 'adaptive.goal');
          record.goalEmbeddingStatus = 'ready';
        } catch (error) {
          record.goalEmbeddingStatus = 'error';
          record.goalEmbeddingError = error instanceof Error ? error.message : String(error);
        }
      });
    }

    if (isDebugEnabled(session.agent)) {
      const { ensureAdaptiveStepContextServer } = await import('./server.js');
      await ensureAdaptiveStepContextServer({
        port: session.agent.config.adaptiveStepContext?.debug?.port,
        openBrowser: session.agent.config.adaptiveStepContext?.debug?.openBrowser !== false,
        sessionId: session.id,
      });
    }
  }

  recordStep(input: PendingStepInput): void {
    const { session, messages, stepNumber } = input;
    if (!isEnabled(session.agent)) return;

    const sessionRecord = this.getOrCreateSession(session);
    const assistantMessages = messages.filter(message => message.role === 'assistant');
    const toolMessages = messages.filter(message => message.role === 'tool');
    const assistant = assistantMessages[assistantMessages.length - 1];
    const reasoning = compactText(assistantMessages.map(message => message.reasoning || '').filter(Boolean).join('\n\n'));
    const output = compactText([
      assistantMessages.map(message => message.content || '').filter(Boolean).join('\n\n'),
      assistantMessages.flatMap(message => message.toolCalls || []).length > 0
        ? `Tool calls:\n${safeJson(assistantMessages.flatMap(message => message.toolCalls || []))}`
        : '',
    ].filter(Boolean).join('\n\n'));
    const observation = compactText(cleanObservation(toolMessages.map(message => message.content || '').filter(Boolean).join('\n\n')));
    const toolCalls = assistantMessages.flatMap(message => message.toolCalls || []);

    if (!reasoning && !output && !observation && toolCalls.length === 0) {
      return;
    }

    const previous = sessionRecord.steps[sessionRecord.steps.length - 1];
    const beforePrevious = sessionRecord.steps[sessionRecord.steps.length - 2];
    const index = typeof stepNumber === 'number' ? stepNumber : sessionRecord.steps.length;
    const record: AdaptiveStepRecord = {
      id: `${session.id}:${index}:${Date.now().toString(36)}`,
      sessionId: session.id,
      agentName: session.agent.config.name,
      index,
      createdAt: new Date().toISOString(),
      reasoning,
      output,
      observation,
      toolCalls: toolCalls.map(toolCall => ({
        id: toolCall.id,
        name: toolCall.name,
        arguments: toolCall.arguments,
      })),
      embeddingStatus: 'pending',
      embeddings: {},
      projectionBeforeStep: previous
        ? {
          fromStepIndex: previous.index,
          alpha: 1,
          vectors: projectFromSteps(previous, beforePrevious, 1),
        }
        : undefined,
    };

    sessionRecord.steps.push(record);
    this.persistSession(sessionRecord);
    this.queueEmbedding(async () => {
      try {
        const tasks: Array<Promise<void>> = [];
        if (reasoning) {
          tasks.push(embedText(reasoning, sessionRecord.embeddingModel, undefined, 'adaptive.reasoning').then(vector => {
            record.embeddings.reasoning = vector;
          }));
        }
        if (output) {
          tasks.push(embedText(output, sessionRecord.embeddingModel, undefined, 'adaptive.output').then(vector => {
            record.embeddings.output = vector;
          }));
        }
        if (observation) {
          tasks.push(embedText(observation, sessionRecord.embeddingModel, undefined, 'adaptive.observation').then(vector => {
            record.embeddings.observation = vector;
          }));
        }
        await Promise.all(tasks);
        record.embeddingStatus = 'ready';
        this.persistSession(sessionRecord);
      } catch (error) {
        record.embeddingStatus = 'error';
        record.embeddingError = error instanceof Error ? error.message : String(error);
        this.persistSession(sessionRecord);
      }
    });
  }

  compactMessagesForPrompt(session: Session, messages: Message[]): Message[] {
    if (!isPruningEnabled(session.agent)) {
      return messages.map(message => this.cloneMessage(message));
    }

    const sessionRecord = this.sessions.get(session.id);
    if (!sessionRecord || sessionRecord.steps.length < 2) {
      return messages.map(message => this.cloneMessage(message));
    }

    const threshold = session.agent.config.adaptiveStepContext?.pruning?.heatThreshold ?? DEFAULT_PRUNING_HEAT_THRESHOLD;
    const heatByStep = this.scoreHeatByStep(sessionRecord);

    return messages.map(message => {
      if (message.content.includes('<ACTIVE_INSTRUCTION_ALGORITHM_STEP>')) {
        return this.cloneMessage(message);
      }
      const stepIndex = message.adaptiveStepIndex;
      if (typeof stepIndex !== 'number') return this.cloneMessage(message);
      const heat = heatByStep.get(stepIndex);
      if (heat === undefined || heat >= threshold) return this.cloneMessage(message);
      return this.compactColdMessage(message, stepIndex, heat);
    });
  }

  viewStep(sessionId: string, stepNumber: number): string {
    const session = this.sessions.get(sessionId);
    const step = session?.steps.find(item => item.index + 1 === stepNumber || item.index === stepNumber);
    if (!step) {
      return `Adaptive context step ${stepNumber} was not found in session ${sessionId}.`;
    }
    return this.formatStepForView(step);
  }

  listSessions(): AdaptiveSessionRecord[] {
    return Array.from(this.sessions.values()).map(session => this.cloneSession(session, false));
  }

  getSession(id: string): AdaptiveSessionRecord | null {
    const session = this.sessions.get(id);
    return session ? this.cloneSession(session, true) : null;
  }

  async waitForPendingEmbeddings(): Promise<void> {
    if (this.embeddingPromises.size === 0) {
      return;
    }
    await Promise.allSettled(Array.from(this.embeddingPromises));
  }

  private scoreHeatByStep(session: AdaptiveSessionRecord): Map<number, number> {
    const steps = session.steps;
    const currentTarget = [...steps].reverse().find(step => step.embeddingStatus === 'ready')?.embeddings || {};
    const projectedTarget = projectFromSteps(steps[steps.length - 1], steps[steps.length - 2], DEFAULT_SCORING.projectionAlpha);
    const maxWeight = DEFAULT_SCORING.current + DEFAULT_SCORING.projected + DEFAULT_SCORING.goal + DEFAULT_SCORING.recency || 1;
    const heatByStep = new Map<number, number>();

    steps.forEach((step, index) => {
      if (step.embeddingStatus !== 'ready') {
        return;
      }
      const current = channelScore(step, currentTarget, DEFAULT_SCORING.currentChannels);
      const projected = channelScore(step, projectedTarget, DEFAULT_SCORING.projectedChannels);
      const goalScore = cosine01(stepCombined(step), session.goalEmbedding) ?? 0;
      const weighted =
        current * DEFAULT_SCORING.current
        + projected * DEFAULT_SCORING.projected
        + goalScore * DEFAULT_SCORING.goal;
      heatByStep.set(step.index, Math.max(0, Math.min(1, weighted / maxWeight)));
    });

    return heatByStep;
  }

  private compactColdMessage(message: Message, stepIndex: number, heat: number): Message {
    const displayStepNumber = stepIndex + 1;
    if (message.role === 'assistant') {
      const toolCalls = message.toolCalls?.map(toolCall => ({
        ...toolCall,
        arguments: Object.fromEntries(Object.entries(toolCall.arguments || {}).map(([key, value]) => [
          key,
          CONTENT_ARG_KEYS.includes(key as typeof CONTENT_ARG_KEYS[number]) && typeof value === 'string'
            ? summarizeForColdStep(value, displayStepNumber)
            : value,
        ])),
      }));
      return {
        ...this.cloneMessage(message),
        reasoning: message.reasoning ? `<Summarized adaptive step ${displayStepNumber}; heat=${heat.toFixed(3)}. Use utils.context.view(${displayStepNumber}) for full reasoning.>` : undefined,
        toolCalls,
      };
    }

    if (message.role === 'tool') {
      return {
        ...this.cloneMessage(message),
        content: summarizeObservation(message.content),
      };
    }

    return this.cloneMessage(message);
  }

  private formatStepForView(step: AdaptiveStepRecord): string {
    return [
      `Adaptive step ${step.index}`,
      `createdAt: ${step.createdAt}`,
      '',
      'Reasoning:',
      step.reasoning || '(empty)',
      '',
      'Output:',
      step.output || '(empty)',
      '',
      'Observation:',
      step.observation || '(empty)',
    ].join('\n');
  }

  private getOrCreateSession(session: Session): AdaptiveSessionRecord {
    const existing = this.sessions.get(session.id);
    if (existing) return existing;

    const embeddingModel = session.agent.config.memory?.embeddingModel || DEFAULT_MEMORY_CONFIG.embeddingModel;
    const record: AdaptiveSessionRecord = {
      id: session.id,
      agentName: session.agent.config.name,
      startedAt: new Date().toISOString(),
      goal: firstUserMessage(session),
      embeddingModel,
      goalEmbeddingStatus: firstUserMessage(session) ? 'pending' : 'ready',
      steps: [],
    };
    this.sessions.set(session.id, record);
    return record;
  }

  private queueEmbedding(task: () => Promise<void>): void {
    const promise = task().finally(() => {
      this.embeddingPromises.delete(promise);
    });
    this.embeddingPromises.add(promise);
  }

  private persistSession(session: AdaptiveSessionRecord): void {
    const filePath = join(STORE_DIR, `${session.id}.json`);
    void mkdir(STORE_DIR, { recursive: true })
      .then(() => writeFile(filePath, JSON.stringify(this.cloneSession(session, false), null, 2), 'utf-8'))
      .catch(error => {
        console.warn('[AdaptiveStepContext] Failed to persist session:', error);
      });
  }

  private cloneMessage(message: Message): Message {
    return {
      ...message,
      toolCalls: message.toolCalls ? message.toolCalls.map(toolCall => ({
        ...toolCall,
        arguments: { ...toolCall.arguments },
      })) : undefined,
    };
  }

  private cloneSession(session: AdaptiveSessionRecord, includeVectors: boolean): AdaptiveSessionRecord {
    return {
      ...session,
      goalEmbedding: includeVectors ? session.goalEmbedding : undefined,
      steps: session.steps.map(step => ({
        ...step,
        embeddings: includeVectors ? { ...step.embeddings } : {},
        projectionBeforeStep: includeVectors && step.projectionBeforeStep
          ? {
            ...step.projectionBeforeStep,
            vectors: { ...step.projectionBeforeStep.vectors },
          }
          : step.projectionBeforeStep
            ? { ...step.projectionBeforeStep, vectors: {} }
            : undefined,
      })),
    };
  }
}

export function getAdaptiveStepContextService(): AdaptiveStepContextService {
  return AdaptiveStepContextService.getInstance();
}
