/**
 * Core type definitions for the ACN agentic framework
 */

// ============================================================================
// Message Types
// ============================================================================

export type MessageRole = 'system' | 'user' | 'assistant' | 'file' | 'tool';

export interface Message {
  role: MessageRole;
  content: string;
  filename?: string; // Optional filename for file role messages
  toolCalls?: ProviderToolCall[]; // Optional assistant tool calls
  toolCallId?: string; // Optional tool call id for role=tool
  toolName?: string; // Optional tool name for role=tool
}

// ============================================================================
// Provider Types
// ============================================================================

export interface ProviderConfig {
  model: string;
  temperature?: number;
  maxTokens?: number;
  stopSequences?: string[];
  /**
   * Sampling
   */
  top_p?: number; // (0, 1]
  top_k?: number;
  /**
   * Determinism
   */
  seed?: number;
  /**
   * Penalties
   */
  frequency_penalty?: number; // [-2, 2]
  presence_penalty?: number; // [-2, 2]
  repetition_penalty?: number; // (0, 2]
  /**
   * Reasoning control
   */
  reasoning?: 'off' | 'low' | 'medium' | 'high'; // default: 'medium'
  /**
   * Streaming
   */
  stream?: boolean;
}

// Tool-calling provider interfaces
export interface ProviderToolDefinition {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
    strict?: boolean;
  };
}

export interface ProviderToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ProviderToolRequest {
  tools: ProviderToolDefinition[];
  toolChoice?: 'auto' | 'none' | { type: 'function'; function: { name: string } };
}

export interface ProviderToolResponse extends ProviderResponse {
  toolCalls?: ProviderToolCall[];
}

/**
 * Streaming event types following industry standards (OpenRouter/OpenAI patterns)
 */
export type StreamEventType =
  | 'reasoning.delta'
  | 'reasoning.done'
  | 'text.delta'
  | 'text.done'
  | 'tool_call.delta'
  | 'tool_call.done'
  | 'done';

export interface ProviderStreamEvent {
  /** Event type */
  type: StreamEventType;
  /** Content delta (for delta events) */
  delta?: string;
  /** Tool call id (for tool_call events) */
  toolCallId?: string;
  /** Tool name (for tool_call events) */
  toolName?: string;
  /** Parsed tool call (for tool_call.done) */
  toolCall?: ProviderToolCall;
}

/**
 * @deprecated Use ProviderStreamEvent instead
 */
export interface ProviderStreamChunk {
  /** Text delta emitted by the model */
  delta: string;
  /** True if this is the final chunk */
  done?: boolean;
}

export interface ProviderResponse {
  content: string;
  reasoning?: string;
  finishReason: 'stop' | 'length' | 'content_filter' | 'stop_sequence' | 'other';
  toolCalls?: ProviderToolCall[];
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

export interface Provider {
  name: string;
  complete(messages: Message[], config: ProviderConfig): Promise<ProviderResponse>;
  completeWithTools?(messages: Message[], config: ProviderConfig, toolRequest: ProviderToolRequest): Promise<ProviderToolResponse>;
  /** @deprecated Use streamEvents instead */
  stream?(messages: Message[], config: ProviderConfig): AsyncIterable<ProviderStreamChunk>;
  /** Industry-standard streaming with reasoning support */
  streamEvents?(messages: Message[], config: ProviderConfig): AsyncIterable<ProviderStreamEvent>;
  streamEventsWithTools?(messages: Message[], config: ProviderConfig, toolRequest: ProviderToolRequest): AsyncIterable<ProviderStreamEvent>;
  buildRequest?(messages: Message[], config: ProviderConfig): any;
  buildRequestWithTools?(messages: Message[], config: ProviderConfig, toolRequest: ProviderToolRequest): any;
}

// ============================================================================
// Agent Types
// ============================================================================

export interface AgentConfig {
  name: string;
  description?: string;
  model: string;
  provider?: string;
  temperature?: number;
  maxTokens?: number;
  top_p?: number;
  top_k?: number;
  seed?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
  repetition_penalty?: number;
  reasoning?: 'off' | 'low' | 'medium' | 'high';
  stream?: boolean;
  systemPrompt: string;  // filename reference
  tools: string[];       // tool names
  loop: string;          // loop type name
  syntax: string;        // syntax type name
  skillsTable?: string;  // Optional: LanceDB table name for this agent's skills
  memory?: AgentMemoryConfig; // Optional: semantic graph memory configuration
  sandbox?: string;      // Sandbox type: 'local' (default) or 'browser'

  // Model switching for dynamic model selection
  modelSwitching?: ModelSwitchingConfig;

  // Agent system config
  injectAgentsList?: boolean;  // Inject available agents list into system prompt (default: true)
  requireFinish?: boolean;     // Whether the agent must call FINISH to complete a task (default: true)
  subagentPrompt?: string;     // Optional: file to use as base system prompt for sub-agents (instead of CORE)
}

export interface LoadedAgent {
  config: AgentConfig;
  systemPromptContent: string;
  subagentPromptContent?: string;
  directory: string;
}

export interface AgentMemoryConfig {
  enabled?: boolean;
  table?: string;
  linkerProvider?: string;
  linkerModel?: string;
  linkerTemperature?: number;
  linkerMaxTokens?: number;
  docParserProvider?: string;
  docParserModel?: string;
  docParserTemperature?: number;
  docParserMaxTokens?: number;
  docCrossLinkMax?: number;
  docEnricherProvider?: string;
  docEnricherModel?: string;
  docEnricherTemperature?: number;
  docEnricherMaxTokens?: number;
  docFactConfidenceFallback?: number;
  docTopicFallback?: string;
  embeddingModel?: string;
  candidateFactsPerTopic?: number;
  candidatePoolMax?: number;
  maxAutoLinksPerFact?: number;
  dedupeThreshold?: number;
  searchMaxDepth?: number;
  searchMaxStartFacts?: number;
  searchMaxChains?: number;
}

export interface ModelSwitchingConfig {
  registryPath?: string;           // Path to models.json
  embeddingIndexPath?: string;     // Path to embeddings.json
  mode?: 'whitelist' | 'allow_all' | 'blacklist';
  whitelist?: string[];
  blacklist?: string[];
  topK?: number;
  overrides?: Record<string, any>;
  defaultModelId?: string;         // Default model to start with
  selector?: {
    provider: string;
    model: string;
    temperature?: number;
    systemPrompt?: string;
    apiKey?: string;
  };
  embedding?: {
    model?: string;
    apiKey?: string;
  };
}



// ============================================================================
// Tool Types
// ============================================================================

export interface ToolConfig {
  name: string;
  description: string;
  module: string;  // path to the tool's index.ts/js file
}

export interface LoadedTool {
  config: ToolConfig;
  directory: string;
  absolutePath: string;
}

// ============================================================================
// Syntax Types
// ============================================================================

export interface SyntaxType {
  name: string;

  // Extraction methods (handle incomplete/cut-off tags)
  getThinking(text: string): string | null;
  getAction(text: string): string | null;
  getObservation(text: string): string | null;
  getCli(text: string): string | null;
  getSkills(text: string): string | null;
  getFiles(text: string): { path: string; content: string }[];
  getDiffs(text: string): string[];
  getEdits(text: string): { filename: string; content: string }[];

  // Check if tag exists (even incomplete)
  hasAction(text: string): boolean;
  hasCli(text: string): boolean;

  // Check if tag is fully closed
  isActionClosed(text: string): boolean;
  isCliClosed(text: string): boolean;

  /**
   * Check if any actionable block (action, cli, file) is fully closed.
   * Used for dynamic stopping of LLM generation.
   */
  hasAnyClosedBlock(text: string): boolean;

  // Wrapping methods
  wrapThinking(content: string): string;
  wrapAction(content: string): string;
  wrapObservation(content: string): string;
  wrapCli(content: string): string;
  wrapSkills(content: string): string;
  wrapSkillsMultiple?(contents: string[]): string;  // Optional: wrap multiple skill entries

  // Documentation for system prompt
  getDescription(): string;
}

// ============================================================================
// Loop Types
// ============================================================================

export interface ProcessedResponse {
  hasAction: boolean;
  actionCode: string | null;
  hasCli: boolean;
  cliCommand: string | null;
  filesToWrite: { path: string; content: string }[];
  diffs: string[];
  edits: { filename: string; content: string }[];  // Search & Replace edits
  fullResponse: string;
}

export interface LoopType {
  name: string;
  /**
   * Stop sequences are loop-specific. Keep them as data rather than requiring a method
   * on the base class.
   */
  stopSequences?: string[];

  // Process model output and determine if there's an action to execute
  processResponse(response: string, syntax: SyntaxType): ProcessedResponse;

  // Build continuation messages after action execution
  buildContinuationMessages(
    currentAssistantContent: string,
    observation: string,
    syntax: SyntaxType,
    filename?: string, // Filename of the executed file (for code executions only)
    originalUserRequest?: string
  ): { updatedAssistantContent: string; continuationUserMessage: string };

  // Documentation for system prompt
  getDescription(): string;

  /**
   * Whether to commit assistant messages to history after each action execution.
   * If true, the assistant message is committed and observation is added as a user message.
   * If false, messages accumulate in currentAssistantContent until completion (default).
   */
  shouldCommitMessagesAfterAction?(): boolean;

  /**
   * Optional full loop execution for loops that own provider round-trips and tool orchestration.
   * Return null to fall back to default Executor behavior.
   */
  run?(context: any): Promise<string | null>;

  /**
   * Whether this loop uses syntax instructions/parsing.
   * Defaults to true.
   */
  usesSyntax?(): boolean;
}

// ============================================================================
// Session Types
// ============================================================================

export interface SessionConfig {
  agentName: string;
  sandboxDir?: string;
}

export interface ExecutionResult {
  success: boolean;
  output: string;
  error?: string;
  filename?: string; // Filename of the executed file (for code executions only)
}
