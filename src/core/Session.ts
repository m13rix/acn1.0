/**
 * Session Manager
 *
 * Manages agent session state including:
 * - Conversation history
 * - Sandbox lifecycle
 * - Configuration
 */

import type { Message, LoadedAgent, LoadedTool, Provider, ProviderToolCall, SyntaxType, LoopType } from '../types/index.js';
import { createSandbox, type ISandbox } from '../sandbox/index.js';
import { PromptBuilder } from './PromptBuilder.js';
import { getMemoryRuntime } from '../memory_system/index.js';
import { startModTextureServerIfNeeded, stopModTextureServerIfNeeded } from './ModTextureServerSidecar.js';
import { getEffectiveMemoryCategories } from './memoryToolDocs.js';
import type { QueryPhraseWeightingMode } from '../memory_system/types.js';
import { getAdaptiveStepContextService } from '../adaptive-step-context/Service.js';
import { getInstructionAlgorithmService } from '../instruction-algorithm/Service.js';

const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;

function pad2(value: number): string {
  return value.toString().padStart(2, '0');
}

export function formatLocalDeviceTime(now: Date = new Date()): string {
  const weekday = WEEKDAY_NAMES[now.getDay()];
  const date = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
  const time = `${pad2(now.getHours())}:${pad2(now.getMinutes())}:${pad2(now.getSeconds())}`;

  return `Local device time: ${weekday}, ${date} ${time}`;
}

export interface SessionComponents {
  agent: LoadedAgent;
  provider: Provider;
  syntax: SyntaxType;
  loop: LoopType;
  tools: LoadedTool[];
  /** Optional: use an existing sandbox instead of creating a new one (for agent-to-agent calls) */
  sandbox?: ISandbox;
  /** Optional: override the agent's configured runPath for this session */
  runPath?: string;
}

export interface SessionSnapshot {
  messages: Message[];
  contextFiles: Array<{ filename: string; content: string }>;
  surfacedMemoryFactIds: string[];
  injectedMemoryHints: Array<{ id: string; content: string }>;
  turns?: SessionTurnSnapshot[];
  activeTurn?: SessionActiveTurnSnapshot | null;
  executionState?: SessionExecutionStateSnapshot | null;
}

export interface SessionTurnSnapshot {
  source: 'user' | 'heartbeat';
  userMessage: string;
  assistantResponses: string[];
  messageStartIndex: number;
  messageEndIndex: number;
  surfacedMemoryFactIds: string[];
}

export interface SessionActiveTurnSnapshot {
  source: 'user' | 'heartbeat';
  userMessage: string;
  assistantResponses: string[];
  messageStartIndex: number;
  surfacedMemoryFactIds: string[];
}

export interface SessionExecutionStateSnapshot {
  mode: 'legacy' | 'provider-tools';
  iterations: number;
  noProgressTurns?: number;
  currentAssistantContent?: string;
  continuationUserMessage?: string;
  lastModelTurnContent?: string;
  pendingLegacyOperations?: {
    actionCode?: string | null;
    cliCommand?: string | null;
    filesToWrite?: Array<{ path: string; content: string }>;
    diffs?: string[];
    edits?: Array<{ filename: string; content: string }>;
  } | null;
  pendingProviderToolCalls?: ProviderToolCall[];
  nextProviderToolIndex?: number;
}

interface ActiveTurnState {
  source: 'user' | 'heartbeat';
  userMessage: string;
  messageStartIndex: number;
  assistantResponses: string[];
  surfacedMemoryFactIds: Set<string>;
}

const FULL_TURN_WINDOW = 5;
const COMPACT_TURN_WINDOW = 3;
const TOTAL_TURN_WINDOW = FULL_TURN_WINDOW + COMPACT_TURN_WINDOW;
const COMPACT_PREFIX = '<...> ';

function parseHistoryWindow(rawValue: string | undefined, fallback: number): number {
  if (rawValue === undefined || rawValue === null || rawValue === '') {
    return fallback;
  }

  const parsed = Number.parseInt(rawValue, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 0;
  }

  return parsed;
}

function getHistoryWindowConfig(): { fullTurnWindow: number; compactTurnWindow: number; totalTurnWindow: number } {
  const fullTurnWindow = parseHistoryWindow(process.env.TELOS_SESSION_FULL_TURN_WINDOW, 0);
  const compactTurnWindow = fullTurnWindow > 0
    ? parseHistoryWindow(process.env.TELOS_SESSION_COMPACT_TURN_WINDOW, 0)
    : 0;

  return {
    fullTurnWindow,
    compactTurnWindow,
    totalTurnWindow: fullTurnWindow > 0 ? fullTurnWindow + compactTurnWindow : 0,
  };
}

function isMemoryEnabled(agent: LoadedAgent): boolean {
  return agent.config.memory?.enabled !== false;
}

function areAutoMemoryHintsEnabled(agent: LoadedAgent): boolean {
  return isMemoryEnabled(agent) && agent.config.memory?.autoHints?.enabled !== false;
}

function areToolResponseAutoMemoryHintsEnabled(agent: LoadedAgent): boolean {
  return areAutoMemoryHintsEnabled(agent) && agent.config.memory?.autoHints?.toolResponses?.enabled !== false;
}

function normalizePhraseWeightingMode(value: unknown, fallback: QueryPhraseWeightingMode): QueryPhraseWeightingMode {
  return value === 'embedding' || value === 'llm' ? value : fallback;
}

function appendToolMemoryHints(content: string, hints: string): string {
  const normalizedHints = hints.trim();
  if (!normalizedHints || content.includes('<MEMORY_HINTS>')) {
    return content;
  }
  return `${content}\n\n<MEMORY_HINTS>\n${normalizedHints}\n</MEMORY_HINTS>`;
}

export class Session {
  public readonly id: string;
  public agent: LoadedAgent;
  public provider: Provider;
  public syntax: SyntaxType;
  public loop: LoopType;
  public tools: LoadedTool[];
  public readonly sandbox: ISandbox;

  private messages: Message[] = [];
  private baseSystemPrompt: string;
  private readonly sessionTimeContext: string;
  private initialized = false;
  private surfacedMemoryFactIds: Set<string> = new Set();
  private injectedMemoryHints: Map<string, string> = new Map();
  private lastMemoryRefreshSignature: string | null = null;
  private turns: SessionTurnSnapshot[] = [];
  private activeTurn: ActiveTurnState | null = null;
  private executionState: SessionExecutionStateSnapshot | null = null;

  constructor(components: SessionComponents) {
    this.id = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
    this.agent = components.agent;
    this.provider = components.provider;
    this.syntax = components.syntax;
    this.loop = components.loop;
    this.tools = components.tools;
    const runPath = components.runPath || this.agent.config.runPath;
    this.sandbox = components.sandbox || createSandbox(this.agent.config.sandbox, runPath ? { existingPath: runPath } : undefined);

    // Build the system prompt
    this.baseSystemPrompt = this.buildPrompt();
    this.sessionTimeContext = formatLocalDeviceTime();
  }

  /**
   * Build/Rebuild the system prompt based on current agent and components
   */
  private buildPrompt(agentOverride?: LoadedAgent): string {
    const promptBuilder = new PromptBuilder();
    return promptBuilder.build(
      agentOverride || this.agent,
      this.syntax,
      this.loop,
      this.tools,
      this.sandbox
    );
  }

  /**
   * Rebuild the system prompt, optionally with a different agent config (e.g. for mode switching)
   */
  public rebuildPrompt(
    agentOverride?: LoadedAgent,
    providerOverride?: Provider,
    syntaxOverride?: SyntaxType,
    loopOverride?: LoopType,
    toolsOverride?: LoadedTool[]
  ): void {
    if (agentOverride) this.agent = agentOverride;
    if (providerOverride) this.provider = providerOverride;
    if (syntaxOverride) this.syntax = syntaxOverride;
    if (loopOverride) this.loop = loopOverride;
    if (toolsOverride) this.tools = toolsOverride;

    this.baseSystemPrompt = this.buildPrompt();
  }

  /**
   * Initialize the session (creates sandbox, skills service, etc.)
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    const effectiveCategories = getEffectiveMemoryCategories(this.agent, this.tools);
    const memoryConfig = this.agent.config.memory || effectiveCategories
      ? {
        ...(this.agent.config.memory ?? {}),
        categories: effectiveCategories,
      }
      : undefined;
    await this.sandbox.initialize(this.tools, memoryConfig);
    await this.warmUpSandbox();
    await startModTextureServerIfNeeded(this.tools);
    if (isMemoryEnabled(this.agent)) {
      await getMemoryRuntime(this.agent.config.memory);
    }
    await getAdaptiveStepContextService().ensureForSession(this);

    this.initialized = true;
  }

  private async warmUpSandbox(): Promise<void> {
    if (typeof this.sandbox.warmUp !== 'function') {
      return;
    }

    try {
      await this.sandbox.warmUp();
    } catch (error: any) {
      console.warn(`[Session] Sandbox warm-up failed: ${error?.message || String(error)}`);
    }
  }

  /**
   * Get the system prompt
   */
  getSystemPrompt(): string {
    const base = this.baseSystemPrompt.trim();
    if (!base) {
      return this.sessionTimeContext;
    }

    return `${base}\n\n${this.sessionTimeContext}`;
  }

  /**
   * Get conversation messages (without system prompt)
   */
  getMessages(): Message[] {
    return [...this.messages];
  }

  exportSnapshot(): SessionSnapshot {
    return {
      messages: this.messages.map(message => this.cloneMessage(message)),
      contextFiles: Array.from(this.contextFiles.entries()).map(([filename, content]) => ({
        filename,
        content,
      })),
      surfacedMemoryFactIds: Array.from(this.surfacedMemoryFactIds),
      injectedMemoryHints: Array.from(this.injectedMemoryHints.entries()).map(([id, content]) => ({
        id,
        content,
      })),
      turns: this.turns.map(turn => ({
        ...turn,
        assistantResponses: [...turn.assistantResponses],
        surfacedMemoryFactIds: [...turn.surfacedMemoryFactIds],
      })),
      activeTurn: this.captureActiveTurnSnapshot(),
      executionState: this.getExecutionState(),
    };
  }

  applySnapshot(snapshot: SessionSnapshot): void {
    this.messages = (snapshot.messages || []).map(message => ({
      ...message,
      toolCalls: message.toolCalls ? message.toolCalls.map(toolCall => ({ ...toolCall })) : undefined,
    }));
    this.contextFiles = new Map(
      (snapshot.contextFiles || []).map(file => [file.filename, file.content])
    );
    this.surfacedMemoryFactIds = new Set(snapshot.surfacedMemoryFactIds || []);
    this.injectedMemoryHints = new Map(
      (snapshot.injectedMemoryHints || []).map(entry => [entry.id, entry.content])
    );
    this.turns = (snapshot.turns || []).map(turn => ({
      source: turn.source === 'heartbeat' ? 'heartbeat' : 'user',
      userMessage: String(turn.userMessage || ''),
      assistantResponses: Array.isArray(turn.assistantResponses)
        ? turn.assistantResponses.map(response => String(response || '')).filter(Boolean)
        : [],
      messageStartIndex: Number.isInteger(turn.messageStartIndex) ? turn.messageStartIndex : 0,
      messageEndIndex: Number.isInteger(turn.messageEndIndex) ? turn.messageEndIndex : 0,
      surfacedMemoryFactIds: Array.isArray(turn.surfacedMemoryFactIds)
        ? turn.surfacedMemoryFactIds.map(id => String(id || '')).filter(Boolean)
        : [],
    }));
    this.activeTurn = snapshot.activeTurn
      ? {
        source: snapshot.activeTurn.source === 'heartbeat' ? 'heartbeat' : 'user',
        userMessage: String(snapshot.activeTurn.userMessage || ''),
        messageStartIndex: Number.isInteger(snapshot.activeTurn.messageStartIndex) ? snapshot.activeTurn.messageStartIndex : this.messages.length,
        assistantResponses: Array.isArray(snapshot.activeTurn.assistantResponses)
          ? snapshot.activeTurn.assistantResponses.map(response => String(response || '')).filter(Boolean)
          : [],
        surfacedMemoryFactIds: new Set(
          Array.isArray(snapshot.activeTurn.surfacedMemoryFactIds)
            ? snapshot.activeTurn.surfacedMemoryFactIds.map(id => String(id || '')).filter(Boolean)
            : []
        ),
      }
      : null;
    this.executionState = this.cloneExecutionState(snapshot.executionState || null);
    this.lastMemoryRefreshSignature = null;
  }



  /**
   * Add a user message
   */
  addUserMessage(content: string): void {
    this.messages.push({ role: 'user', content });
  }

  appendToLastUserMessage(extraContent: string): void {
    const extra = String(extraContent || '').trim();
    if (!extra) {
      return;
    }

    for (let i = this.messages.length - 1; i >= 0; i--) {
      const message = this.messages[i];
      if (message?.role !== 'user') {
        continue;
      }
      if (message.content.includes(extra)) {
        return;
      }
      this.messages[i] = {
        ...message,
        content: `${message.content}\n\n${extra}`,
      };
      return;
    }

    this.addUserMessage(extra);
  }

  /**
   * Add any message (used by provider-native tool loops)
   */
  addMessage(message: Message): void {
    this.messages.push(message);
  }

  /**
   * Add an assistant message
   */
  addAssistantMessage(content: string): void {
    this.messages.push({ role: 'assistant', content });
  }

  beginTurn(userMessage: string, source: 'user' | 'heartbeat' = 'user'): void {
    this.activeTurn = {
      source,
      userMessage,
      messageStartIndex: this.messages.length,
      assistantResponses: [],
      surfacedMemoryFactIds: new Set(),
    };
    this.executionState = null;
  }

  recordVisibleAssistantOutput(content: string): void {
    if (!this.activeTurn) {
      return;
    }

    const normalized = String(content || '').trim();
    if (!normalized) {
      return;
    }

    const existing = this.activeTurn.assistantResponses;
    if (existing[existing.length - 1] === normalized) {
      return;
    }

    existing.push(normalized);
  }

  endTurn(): void {
    if (!this.activeTurn) {
      return;
    }

    this.turns.push({
      source: this.activeTurn.source,
      userMessage: this.activeTurn.userMessage,
      assistantResponses: [...this.activeTurn.assistantResponses],
      messageStartIndex: this.activeTurn.messageStartIndex,
      messageEndIndex: this.messages.length - 1,
      surfacedMemoryFactIds: Array.from(this.activeTurn.surfacedMemoryFactIds),
    });
    this.activeTurn = null;
    this.executionState = null;
  }

  private contextFiles: Map<string, string> = new Map();

  /**
   * Add a file message (updates persistent context)
   */
  addFileMessage(content: string, filename: string): void {
    // Store in context map - overwrites existing file with same name
    this.contextFiles.set(filename, content);
  }

  /**
   * Get all messages including system prompt and persistent context files
   */
  getAllMessages(): Message[] {
    const { messages } = this.buildWindowedHistoryState();
    const contextFileMessages: Message[] = Array.from(this.contextFiles.entries()).map(([filename, content]) => ({
      role: 'file',
      content,
      filename
    }));
    const adaptiveMessages = getAdaptiveStepContextService().compactMessagesForPrompt(this, messages);
    const promptMessages = getInstructionAlgorithmService().compactRetiredInstructionBlocks(this, adaptiveMessages);

    return [
      { role: 'system', content: this.getSystemPrompt() },
      ...promptMessages,
      ...contextFileMessages
    ];
  }

  injectVisibleMemoryHintsIntoLastUserMessage(): void {
    if (!areAutoMemoryHintsEnabled(this.agent)) {
      return;
    }

    const memoryHints = this.getVisibleInjectedMemoryHints()
      .map(content => content.trim())
      .filter(Boolean);
    if (memoryHints.length === 0) {
      return;
    }

    this.appendToLastUserMessage(`MEMORY HINTS:\n\n${memoryHints.join('\n\n')}`);
  }

  /**
   * Update the last assistant message (for accumulator loop)
   */
  updateLastAssistantMessage(content: string): void {
    for (let i = this.messages.length - 1; i >= 0; i--) {
      if (this.messages[i]?.role === 'assistant') {
        this.messages[i] = { role: 'assistant', content };
        return;
      }
    }
    // No assistant message found, add one
    this.addAssistantMessage(content);
  }

  /**
   * Get the last assistant message
   */
  getLastAssistantMessage(): string | null {
    for (let i = this.messages.length - 1; i >= 0; i--) {
      if (this.messages[i]?.role === 'assistant') {
        return this.messages[i]?.content ?? null;
      }
    }
    return null;
  }

  /**
   * Clear conversation history
   */
  clearHistory(): void {
    this.messages = [];
    this.turns = [];
    this.activeTurn = null;
    this.executionState = null;
    this.surfacedMemoryFactIds.clear();
    this.injectedMemoryHints.clear();
    this.lastMemoryRefreshSignature = null;
  }

  hasMemoryFactBeenSurfaced(factId: string): boolean {
    return this.surfacedMemoryFactIds.has(factId);
  }

  markMemoryFactsAsSurfaced(factIds: string[], content?: string): void {
    for (const factId of factIds) {
      if (factId) {
        this.surfacedMemoryFactIds.add(factId);
        this.activeTurn?.surfacedMemoryFactIds.add(factId);
      }
    }
    if (content && factIds.length > 0) {
      const key = factIds[0]!;
      if (!this.injectedMemoryHints.has(key)) {
        this.injectedMemoryHints.set(key, content);
      }
    }
  }

  getSurfacedMemoryFactIds(): string[] {
    return Array.from(this.surfacedMemoryFactIds);
  }

  hasActiveTurn(): boolean {
    return this.activeTurn !== null;
  }

  getActiveTurnUserMessage(): string | null {
    return this.activeTurn?.userMessage ?? null;
  }

  getActiveTurnSource(): 'user' | 'heartbeat' | null {
    return this.activeTurn?.source ?? null;
  }

  captureActiveTurnSnapshot(): SessionActiveTurnSnapshot | null {
    if (!this.activeTurn) {
      return null;
    }

    return {
      source: this.activeTurn.source,
      userMessage: this.activeTurn.userMessage,
      assistantResponses: [...this.activeTurn.assistantResponses],
      messageStartIndex: this.activeTurn.messageStartIndex,
      surfacedMemoryFactIds: Array.from(this.activeTurn.surfacedMemoryFactIds),
    };
  }

  setExecutionState(state: SessionExecutionStateSnapshot | null): void {
    this.executionState = this.cloneExecutionState(state);
  }

  getExecutionState(): SessionExecutionStateSnapshot | null {
    return this.cloneExecutionState(this.executionState);
  }

  clearExecutionState(): void {
    this.executionState = null;
  }

  private cloneExecutionState(state: SessionExecutionStateSnapshot | null | undefined): SessionExecutionStateSnapshot | null {
    if (!state) {
      return null;
    }

    return {
      mode: state.mode === 'provider-tools' ? 'provider-tools' : 'legacy',
      iterations: Number.isFinite(state.iterations) ? Math.max(0, Math.floor(state.iterations)) : 0,
      noProgressTurns: Number.isFinite(state.noProgressTurns) ? Math.max(0, Math.floor(state.noProgressTurns!)) : 0,
      currentAssistantContent: String(state.currentAssistantContent || ''),
      continuationUserMessage: String(state.continuationUserMessage || ''),
      lastModelTurnContent: String(state.lastModelTurnContent || ''),
      pendingLegacyOperations: state.pendingLegacyOperations
        ? {
          actionCode: state.pendingLegacyOperations.actionCode ?? null,
          cliCommand: state.pendingLegacyOperations.cliCommand ?? null,
          filesToWrite: Array.isArray(state.pendingLegacyOperations.filesToWrite)
            ? state.pendingLegacyOperations.filesToWrite.map(file => ({
              path: String(file.path || ''),
              content: String(file.content || ''),
            }))
            : [],
          diffs: Array.isArray(state.pendingLegacyOperations.diffs)
            ? state.pendingLegacyOperations.diffs.map(diff => String(diff || ''))
            : [],
          edits: Array.isArray(state.pendingLegacyOperations.edits)
            ? state.pendingLegacyOperations.edits.map(edit => ({
              filename: String(edit.filename || ''),
              content: String(edit.content || ''),
            }))
            : [],
        }
        : null,
      pendingProviderToolCalls: Array.isArray(state.pendingProviderToolCalls)
        ? state.pendingProviderToolCalls.map(toolCall => ({
          ...toolCall,
          id: String(toolCall.id || ''),
          name: String(toolCall.name || ''),
          arguments: toolCall.arguments && typeof toolCall.arguments === 'object'
            ? { ...toolCall.arguments }
            : {},
        }))
        : [],
      nextProviderToolIndex: Number.isFinite(state.nextProviderToolIndex)
        ? Math.max(0, Math.floor(state.nextProviderToolIndex!))
        : 0,
    };
  }

  private cloneMessage(message: Message): Message {
    return {
      ...message,
      toolCalls: message.toolCalls ? message.toolCalls.map(toolCall => ({ ...toolCall, arguments: { ...toolCall.arguments } })) : undefined,
    };
  }

  private getVisibleInjectedMemoryHints(): string[] {
    const { visibleFactIds } = this.buildWindowedHistoryState();
    if (visibleFactIds.size === 0) {
      return [];
    }

    return Array.from(this.injectedMemoryHints.entries())
      .filter(([id]) => visibleFactIds.has(id))
      .map(([, content]) => content);
  }

  private buildWindowedHistoryState(): { messages: Message[]; visibleFactIds: Set<string> } {
    const { fullTurnWindow, totalTurnWindow } = getHistoryWindowConfig();
    if (totalTurnWindow <= 0 || this.turns.length <= totalTurnWindow) {
      const visibleFactIds = new Set(this.turns.flatMap(turn => turn.surfacedMemoryFactIds));
      for (const factId of this.activeTurn?.surfacedMemoryFactIds || []) {
        visibleFactIds.add(factId);
      }

      return {
        messages: this.messages.map(message => this.cloneMessage(message)),
        visibleFactIds,
      };
    }

    const keptTurns = this.turns.slice(-totalTurnWindow);
    const compactTurnCount = Math.max(0, keptTurns.length - fullTurnWindow);
    const compactTurns = keptTurns.slice(0, compactTurnCount);
    const fullTurns = keptTurns.slice(compactTurnCount);
    const nextMessages: Message[] = [];

    for (const turn of compactTurns) {
      if (turn.userMessage.trim()) {
        nextMessages.push({ role: 'user', content: turn.userMessage });
      }

      const compactAssistant = this.buildCompactAssistantMessage(turn);
      if (compactAssistant) {
        nextMessages.push({ role: 'assistant', content: compactAssistant });
      }
    }

    for (const turn of fullTurns) {
      const start = Math.max(0, turn.messageStartIndex);
      const end = Math.min(this.messages.length - 1, turn.messageEndIndex);
      if (end < start) {
        if (turn.userMessage.trim()) {
          nextMessages.push({ role: 'user', content: turn.userMessage });
        }
        const compactAssistant = this.buildCompactAssistantMessage(turn);
        if (compactAssistant) {
          nextMessages.push({ role: 'assistant', content: compactAssistant });
        }
        continue;
      }

      for (const message of this.messages.slice(start, end + 1)) {
        nextMessages.push(this.cloneMessage(message));
      }
    }

    if (this.activeTurn) {
      const start = Math.max(0, this.activeTurn.messageStartIndex);
      for (const message of this.messages.slice(start)) {
        nextMessages.push(this.cloneMessage(message));
      }
    }

    const visibleFactIds = new Set(keptTurns.flatMap(turn => turn.surfacedMemoryFactIds));
    for (const factId of this.activeTurn?.surfacedMemoryFactIds || []) {
      visibleFactIds.add(factId);
    }

    return {
      messages: nextMessages,
      visibleFactIds,
    };
  }

  private buildCompactAssistantMessage(turn: SessionTurnSnapshot): string {
    const normalized = turn.assistantResponses
      .map(response => String(response || '').trim())
      .filter(Boolean);

    if (normalized.length === 0) {
      return '';
    }

    const merged = normalized.join('\n\n');
    return merged.startsWith(COMPACT_PREFIX) ? merged : `${COMPACT_PREFIX}${merged}`;
  }

  async refreshMemoryContext(
    userRequest: string,
    callbacks?: {
      onMemoryHintsRetrieved?: (content: string, score: number) => void;
      onMemoryHintsSearched?: (topScore: number | null) => void;
    },
    options?: {
      topK?: number;
      maxQueryLength?: number;
      queryPhraseWeightingMode?: QueryPhraseWeightingMode;
      signatureScope?: string;
    }
  ): Promise<string | null> {
    if (!areAutoMemoryHintsEnabled(this.agent)) {
      return null;
    }

    try {
      const query = String(userRequest || '').trim().slice(0, Math.max(1, Math.floor(options?.maxQueryLength ?? 4000)));
      if (!query) {
        return null;
      }

      const topK = Math.max(1, Math.floor(options?.topK ?? this.agent.config.memory?.autoHints?.topK ?? 5));
      const runtime = await getMemoryRuntime(this.agent.config.memory);
      const memoryCfg = this.agent.config.memory;
      const effectiveCategories = getEffectiveMemoryCategories(this.agent, this.tools);
      const categories = effectiveCategories?.map((cat) => cat.name);
      const includeUncategorized = memoryCfg?.includeUncategorized;
      const fallbackCategory = memoryCfg?.fallbackCategory;
      const categoryMultipliers: Record<string, number> = {};
      for (const cat of effectiveCategories ?? []) {
        if (typeof cat.multiplier === 'number') {
          categoryMultipliers[cat.name] = cat.multiplier;
        }
      }
      const result = await runtime.service.search(query, {
        agentName: this.agent.config.name,
        categories,
        includeUncategorized,
        fallbackCategory,
        categoryMultipliers: Object.keys(categoryMultipliers).length > 0 ? categoryMultipliers : undefined,
        excludeFactIds: this.getSurfacedMemoryFactIds(),
        queryPhraseWeightingMode: normalizePhraseWeightingMode(
          options?.queryPhraseWeightingMode ?? memoryCfg?.autoHints?.userPhraseWeighting,
          'llm',
        ),
        candidateSelection: {
          mode: 'top-k',
          topK,
          maxCandidates: topK,
        },
      });
      const refreshSignature = JSON.stringify({
        scope: options?.signatureScope ?? 'user',
        query,
        surfacedFactIds: result.surfacedFactIds,
        text: result.text,
      });

      if (refreshSignature === this.lastMemoryRefreshSignature) {
        return null;
      }
      this.lastMemoryRefreshSignature = refreshSignature;

      if (result.surfacedFactIds.length > 0 && result.text.trim()) {
        this.markMemoryFactsAsSurfaced(result.surfacedFactIds, result.text);
        callbacks?.onMemoryHintsRetrieved?.(result.text, result.seedFacts[0]?.score ?? 0);
        return result.text;
      }

      callbacks?.onMemoryHintsSearched?.(result.seedFacts[0]?.score ?? null);
      return null;
    } catch (error) {
      console.error('[Session] Memory search error:', error);
      return null;
    }
  }

  async enrichToolResponseWithMemoryHints(
    content: string,
    callbacks?: {
      onMemoryHintsRetrieved?: (content: string, score: number) => void;
      onMemoryHintsSearched?: (topScore: number | null) => void;
    },
  ): Promise<string> {
    if (!areToolResponseAutoMemoryHintsEnabled(this.agent)) {
      return content;
    }

    const autoHints = this.agent.config.memory?.autoHints;
    const hints = await this.refreshMemoryContext(content, callbacks, {
      topK: autoHints?.toolResponses?.topK ?? autoHints?.topK,
      maxQueryLength: autoHints?.toolResponses?.maxQueryLength ?? 4000,
      queryPhraseWeightingMode: normalizePhraseWeightingMode(autoHints?.toolResponsePhraseWeighting, 'embedding'),
      signatureScope: 'tool',
    });
    return hints ? appendToolMemoryHints(content, hints) : content;
  }

  /**
   * Clean up the session
   */
  async cleanup(): Promise<void> {
    try {
      await this.sandbox.cleanup();
    } finally {
      await stopModTextureServerIfNeeded(this.tools);
    }
  }

  /**
   * Get provider config for this session
   */
  getProviderConfig() {
    return {
      model: this.agent.config.model,
      provider: this.agent.config.provider || this.provider.name,
      providerOptions: this.agent.config.providerOptions,
      temperature: this.agent.config.temperature,
      maxTokens: this.agent.config.maxTokens,
      stopSequences: this.loop.stopSequences ?? [],
      top_p: this.agent.config.top_p,
      top_k: this.agent.config.top_k,
      seed: this.agent.config.seed,
      frequency_penalty: this.agent.config.frequency_penalty,
      presence_penalty: this.agent.config.presence_penalty,
      repetition_penalty: this.agent.config.repetition_penalty,
      reasoning: this.agent.config.reasoning,
      stream: this.agent.config.stream,
    };
  }
}

export default Session;
