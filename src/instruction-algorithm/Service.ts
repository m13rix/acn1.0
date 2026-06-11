import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, isAbsolute, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { parse as parseYaml } from 'yaml';
import type { LoadedAgent, Message, ProviderConfig } from '../types/index.js';
import type { Session } from '../core/Session.js';

const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const STORE_DIR = join(PROJECT_ROOT, 'data', 'instruction-algorithm');

export interface InstructionStepConfig {
  id: string;
  title?: string;
  breadcrumb?: string;
  instruction?: string;
  model?: string;
  provider?: string;
  next?: string;
}

export interface InstructionAlgorithmConfigFile {
  name?: string;
  description?: string;
  initialStep?: string;
  steps: InstructionStepConfig[];
}

export interface InstructionAlgorithmState {
  sessionId: string;
  agentName: string;
  algorithmName: string;
  currentStepId: string;
  completed: Array<{ stepId: string; breadcrumb: string; note?: string; completedAt: string }>;
  advanceCount: number;
  initialInstructionsInjected: boolean;
  updatedAt: string;
}

export interface InstructionStepView {
  enabled: boolean;
  state?: InstructionAlgorithmState;
  step?: InstructionStepConfig & { content: string };
  message: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

function normalizePath(baseDir: string, candidate: string): string {
  return isAbsolute(candidate)
    ? candidate
    : resolve(baseDir, candidate);
}

function statePath(sessionId: string): string {
  return join(STORE_DIR, `${sessionId}.json`);
}

function readJson<T>(filePath: string): T | null {
  if (!existsSync(filePath)) return null;
  return JSON.parse(readFileSync(filePath, 'utf8')) as T;
}

function writeJson(filePath: string, value: unknown): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf8');
}

function resolveConfigPath(agent: LoadedAgent): string | null {
  // If the session passed an explicit instruction algorithm config path via env
  // (set by AgentRunner/ToolExecutionEngine when overriding for subagents), use it.
  const envPath = process.env.TELOS_INSTRUCTION_ALGORITHM_CONFIG;
  if (envPath) {
    const resolved = normalizePath(agent.directory, envPath);
    if (existsSync(resolved)) return resolved;
    const projectResolved = normalizePath(PROJECT_ROOT, envPath);
    if (existsSync(projectResolved)) return projectResolved;
  }

  const cfg = agent.config.instructionAlgorithm;
  if (!cfg?.enabled) return null;
  const configuredPath = cfg.configPath || 'instruction_algorithm.yaml';
  const agentRelative = normalizePath(agent.directory, configuredPath);
  if (existsSync(agentRelative)) return agentRelative;
  const projectRelative = normalizePath(PROJECT_ROOT, configuredPath);
  return existsSync(projectRelative) ? projectRelative : agentRelative;
}

function assertStepId(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${field} must be a non-empty string.`);
  }
  return value.trim();
}

export class InstructionAlgorithmService {
  private static instance: InstructionAlgorithmService | null = null;

  static getInstance(): InstructionAlgorithmService {
    if (!this.instance) {
      this.instance = new InstructionAlgorithmService();
    }
    return this.instance;
  }

  isEnabled(agent: LoadedAgent): boolean {
    return agent.config.instructionAlgorithm?.enabled === true;
  }

  loadAlgorithm(agent: LoadedAgent): { config: InstructionAlgorithmConfigFile; configPath: string } | null {
    const configPath = resolveConfigPath(agent);
    if (!configPath) return null;
    if (!existsSync(configPath)) {
      throw new Error(`Instruction algorithm config not found: ${configPath}`);
    }

    const raw = parseYaml(readFileSync(configPath, 'utf8')) as InstructionAlgorithmConfigFile;
    if (!raw || !Array.isArray(raw.steps) || raw.steps.length === 0) {
      throw new Error(`Instruction algorithm config must define at least one step: ${configPath}`);
    }

    const seen = new Set<string>();
    for (const step of raw.steps) {
      step.id = assertStepId(step.id, 'step.id');
      if (seen.has(step.id)) {
        throw new Error(`Duplicate instruction algorithm step id "${step.id}" in ${configPath}`);
      }
      seen.add(step.id);
    }

    const initialStep = raw.initialStep || raw.steps[0]?.id;
    if (!initialStep || !seen.has(initialStep)) {
      throw new Error(`Instruction algorithm initialStep "${initialStep}" does not exist in ${configPath}`);
    }

    return {
      config: {
        ...raw,
        initialStep,
        name: raw.name || agent.config.name,
      },
      configPath,
    };
  }

  getState(sessionId: string): InstructionAlgorithmState | null {
    return readJson<InstructionAlgorithmState>(statePath(sessionId));
  }

  ensureState(session: Session): InstructionAlgorithmState | null {
    const loaded = this.loadAlgorithm(session.agent);
    if (!loaded) return null;

    const existing = this.getState(session.id);
    if (existing && existing.agentName === session.agent.config.name) {
      return existing;
    }

    const state: InstructionAlgorithmState = {
      sessionId: session.id,
      agentName: session.agent.config.name,
      algorithmName: loaded.config.name || session.agent.config.name,
      currentStepId: loaded.config.initialStep!,
      completed: [],
      advanceCount: 0,
      initialInstructionsInjected: false,
      updatedAt: nowIso(),
    };
    writeJson(statePath(session.id), state);
    return state;
  }

  getCurrentStep(agent: LoadedAgent, sessionId: string): (InstructionStepConfig & { content: string }) | null {
    const loaded = this.loadAlgorithm(agent);
    if (!loaded) return null;
    const state = this.getState(sessionId);
    const currentStepId = state?.currentStepId || loaded.config.initialStep!;
    const step = loaded.config.steps.find(item => item.id === currentStepId);
    if (!step) {
      throw new Error(`Current instruction algorithm step "${currentStepId}" does not exist.`);
    }
    return this.hydrateStep(step, dirname(loaded.configPath));
  }

  decorateInitialUserMessage(session: Session, userMessage: string): string {
    const state = this.ensureState(session);
    if (!state || state.initialInstructionsInjected) {
      return userMessage;
    }

    const step = this.getCurrentStep(session.agent, session.id);
    if (!step) return userMessage;

    state.initialInstructionsInjected = true;
    state.updatedAt = nowIso();
    writeJson(statePath(session.id), state);

    return `${userMessage.trim()}\n\n${this.formatActiveStepBlock(step, state, 'initial-user-message')}`;
  }

  getActiveModelOverride(session: Session): Partial<ProviderConfig> | null {
    const step = this.getCurrentStep(session.agent, session.id);
    if (!step?.model) return null;
    return { model: step.model };
  }

  compactRetiredInstructionBlocks(session: Session, messages: Message[]): Message[] {
    const state = this.getState(session.id);
    if (!state) {
      return messages;
    }

    return messages.map(message => {
      if (!message.content.includes('<ACTIVE_INSTRUCTION_ALGORITHM_STEP>')) {
        return message;
      }

      return {
        ...message,
        content: message.content.replace(
          /<ACTIVE_INSTRUCTION_ALGORITHM_STEP>[\s\S]*?<\/ACTIVE_INSTRUCTION_ALGORITHM_STEP>/g,
          (block) => this.compactInstructionBlock(block, state)
        ),
      };
    });
  }

  current(agent: LoadedAgent, sessionId: string): InstructionStepView {
    const loaded = this.loadAlgorithm(agent);
    if (!loaded) {
      return { enabled: false, message: 'Instruction algorithm is disabled for this agent.' };
    }
    const state = this.getState(sessionId) || {
      sessionId,
      agentName: agent.config.name,
      algorithmName: loaded.config.name || agent.config.name,
      currentStepId: loaded.config.initialStep!,
      completed: [],
      advanceCount: 0,
      initialInstructionsInjected: false,
      updatedAt: nowIso(),
    };

    writeJson(statePath(sessionId), state);
    const step = this.getCurrentStep(agent, sessionId);
    return {
      enabled: true,
      state,
      step: step || undefined,
      message: step ? this.formatActiveStepBlock(step, state, 'tool-result') : 'No current step.',
    };
  }

  next(agent: LoadedAgent, sessionId: string, input: { note?: string; step?: string } = {}): InstructionStepView {
    const loaded = this.loadAlgorithm(agent);
    if (!loaded) {
      return { enabled: false, message: 'Instruction algorithm is disabled for this agent.' };
    }

    const state = this.current(agent, sessionId).state!;
    const current = loaded.config.steps.find(item => item.id === state.currentStepId);
    if (!current) {
      throw new Error(`Current instruction algorithm step "${state.currentStepId}" does not exist.`);
    }

    const nextStepId = input.step || current.next || this.nextLinearStepId(loaded.config, current.id);
    if (!nextStepId) {
      state.completed.push({
        stepId: current.id,
        breadcrumb: current.breadcrumb || current.title || current.id,
        note: input.note,
        completedAt: nowIso(),
      });
      state.updatedAt = nowIso();
      writeJson(statePath(sessionId), state);
      return {
        enabled: true,
        state,
        message: 'Instruction algorithm is already at the final step; no next step exists.',
      };
    }

    const next = loaded.config.steps.find(item => item.id === nextStepId);
    if (!next) {
      throw new Error(`Next instruction algorithm step "${nextStepId}" does not exist.`);
    }

    state.completed.push({
      stepId: current.id,
      breadcrumb: current.breadcrumb || current.title || current.id,
      note: input.note,
      completedAt: nowIso(),
    });
    state.currentStepId = next.id;
    state.advanceCount += 1;
    state.updatedAt = nowIso();
    writeJson(statePath(sessionId), state);

    const hydrated = this.hydrateStep(next, dirname(loaded.configPath));
    return {
      enabled: true,
      state,
      step: hydrated,
      message: this.formatActiveStepBlock(hydrated, state, 'tool-result'),
    };
  }

  set(agent: LoadedAgent, sessionId: string, stepId: string, note?: string): InstructionStepView {
    const loaded = this.loadAlgorithm(agent);
    if (!loaded) {
      return { enabled: false, message: 'Instruction algorithm is disabled for this agent.' };
    }
    const step = loaded.config.steps.find(item => item.id === stepId);
    if (!step) {
      throw new Error(`Instruction algorithm step "${stepId}" does not exist.`);
    }
    const state = this.current(agent, sessionId).state!;
    state.completed.push({
      stepId: state.currentStepId,
      breadcrumb: `manual jump to ${stepId}`,
      note,
      completedAt: nowIso(),
    });
    state.currentStepId = step.id;
    state.advanceCount += 1;
    state.updatedAt = nowIso();
    writeJson(statePath(sessionId), state);
    const hydrated = this.hydrateStep(step, dirname(loaded.configPath));
    return {
      enabled: true,
      state,
      step: hydrated,
      message: this.formatActiveStepBlock(hydrated, state, 'tool-result'),
    };
  }

  private hydrateStep(step: InstructionStepConfig, configDir: string): InstructionStepConfig & { content: string } {
    const instructionPath = step.instruction ? normalizePath(configDir, step.instruction) : null;
    const content = instructionPath
      ? readFileSync(instructionPath, 'utf8').trim()
      : '';
    return { ...step, content };
  }

  private nextLinearStepId(config: InstructionAlgorithmConfigFile, currentStepId: string): string | null {
    const index = config.steps.findIndex(item => item.id === currentStepId);
    if (index < 0) return null;
    return config.steps[index + 1]?.id || null;
  }

  private formatBreadcrumbBlock(state: InstructionAlgorithmState): string {
    const completed = state.completed.length > 0
      ? state.completed.map(item => `- ${item.breadcrumb}${item.note ? ` (${item.note})` : ''}`).join('\n')
      : '- none yet';

    return [
      '<INSTRUCTION_ALGORITHM_STATE>',
      `Algorithm: ${state.algorithmName}`,
      `Current step: ${state.currentStepId}`,
      'Completed step breadcrumbs:',
      completed,
      'Rule: completed-step instructions are retired; use their breadcrumbs and saved artifacts only.',
      '</INSTRUCTION_ALGORITHM_STATE>',
    ].join('\n');
  }

  private formatActiveStepBlock(
    step: InstructionStepConfig & { content: string },
    state: InstructionAlgorithmState,
    source: string
  ): string {
    return [
      '<ACTIVE_INSTRUCTION_ALGORITHM_STEP>',
      `Source: ${source}`,
      `Algorithm: ${state.algorithmName}`,
      `Step: ${step.id}${step.title ? ` - ${step.title}` : ''}`,
      step.breadcrumb ? `Breadcrumb after completion: ${step.breadcrumb}` : '',
      step.model ? `Preferred model for this step: ${step.model}` : '',
      '',
      step.content || '(No additional step instructions.)',
      '',
      'When this step is honestly complete, call `await instruction.next({ note: "short completion note" })` inside action. The instruction tool will emit the next active step into the action observation.',
      '</ACTIVE_INSTRUCTION_ALGORITHM_STEP>',
    ].filter(Boolean).join('\n');
  }

  private compactInstructionBlock(block: string, state: InstructionAlgorithmState): string {
    const match = block.match(/^Step:\s*([^\s-]+)/m);
    const stepId = match?.[1]?.trim();
    if (stepId && stepId === state.currentStepId) {
      return block;
    }

    const completed = stepId
      ? [...state.completed].reverse().find(item => item.stepId === stepId)
      : undefined;
    const breadcrumb = completed?.breadcrumb || (stepId ? `completed instruction step ${stepId}` : 'retired instruction step');
    const note = completed?.note ? ` Note: ${completed.note}` : '';
    return `<RETIRED_INSTRUCTION_ALGORITHM_STEP>${breadcrumb}.${note}</RETIRED_INSTRUCTION_ALGORITHM_STEP>`;
  }

}

export function getInstructionAlgorithmService(): InstructionAlgorithmService {
  return InstructionAlgorithmService.getInstance();
}
