/**
 * Core type definitions for the ACN agentic framework
 */

// ============================================================================
// Message Types
// ============================================================================

export type MessageRole = 'system' | 'user' | 'assistant' | 'file';

export interface Message {
  role: MessageRole;
  content: string;
  filename?: string; // Optional filename for file role messages
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

/**
 * Streaming event types following industry standards (OpenRouter/OpenAI patterns)
 */
export type StreamEventType =
  | 'reasoning.delta'
  | 'reasoning.done'
  | 'text.delta'
  | 'text.done'
  | 'done';

export interface ProviderStreamEvent {
  /** Event type */
  type: StreamEventType;
  /** Content delta (for delta events) */
  delta?: string;
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
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

export interface Provider {
  name: string;
  complete(messages: Message[], config: ProviderConfig): Promise<ProviderResponse>;
  /** @deprecated Use streamEvents instead */
  stream?(messages: Message[], config: ProviderConfig): AsyncIterable<ProviderStreamChunk>;
  /** Industry-standard streaming with reasoning support */
  streamEvents?(messages: Message[], config: ProviderConfig): AsyncIterable<ProviderStreamEvent>;
  buildRequest?(messages: Message[], config: ProviderConfig): any;
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
  sandbox?: string;      // Sandbox type: 'local' (default) or 'browser'
}

export interface LoadedAgent {
  config: AgentConfig;
  systemPromptContent: string;
  directory: string;
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

  // Check if tag exists (even incomplete)
  hasAction(text: string): boolean;
  hasCli(text: string): boolean;

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
