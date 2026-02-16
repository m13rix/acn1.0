/**
 * Session Manager
 * 
 * Manages agent session state including:
 * - Conversation history
 * - Sandbox lifecycle
 * - Configuration
 */

import type { Message, LoadedAgent, LoadedTool, Provider, SyntaxType, LoopType } from '../types/index.js';
import { createSandbox, type ISandbox } from '../sandbox/index.js';
import { PromptBuilder } from './PromptBuilder.js';
import { SkillsService } from '../skills_system/SkillsService.js';

export interface SessionComponents {
  agent: LoadedAgent;
  provider: Provider;
  syntax: SyntaxType;
  loop: LoopType;
  tools: LoadedTool[];
  /** Optional: use an existing sandbox instead of creating a new one (for agent-to-agent calls) */
  sandbox?: ISandbox;
}

export class Session {
  public readonly id: string;
  public agent: LoadedAgent;
  public provider: Provider;
  public syntax: SyntaxType;
  public loop: LoopType;
  public tools: LoadedTool[];
  public readonly sandbox: ISandbox;
  public readonly skillsService?: SkillsService;

  private messages: Message[] = [];
  private systemPrompt: string;
  private initialized = false;
  private addedSkillIds: Set<string> = new Set(); // Track skill entry IDs that have been added to conversation

  constructor(components: SessionComponents) {
    this.id = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
    this.agent = components.agent;
    this.provider = components.provider;
    this.syntax = components.syntax;
    this.loop = components.loop;
    this.tools = components.tools;
    this.sandbox = components.sandbox || createSandbox(this.agent.config.sandbox);

    // Initialize SkillsService if agent has a skillsTable configured
    if (this.agent.config.skillsTable) {
      this.skillsService = new SkillsService(this.agent.config.skillsTable);
    }

    // Build the system prompt
    this.systemPrompt = this.buildPrompt();
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

    this.systemPrompt = this.buildPrompt();
  }

  /**
   * Initialize the session (creates sandbox, skills service, etc.)
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    // Initialize sandbox with tools, skillsTable, and memory config
    await this.sandbox.initialize(this.tools, this.agent.config.skillsTable, this.agent.config.memory);

    // Initialize SkillsService if configured
    if (this.skillsService) {
      await this.skillsService.initialize();
    }

    this.initialized = true;
  }

  /**
   * Get the system prompt
   */
  getSystemPrompt(): string {
    return this.systemPrompt;
  }

  /**
   * Get conversation messages (without system prompt)
   */
  getMessages(): Message[] {
    return [...this.messages];
  }



  /**
   * Add a user message
   */
  addUserMessage(content: string): void {
    this.messages.push({ role: 'user', content });
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
    const contextFileMessages: Message[] = Array.from(this.contextFiles.entries()).map(([filename, content]) => ({
      role: 'file',
      content,
      filename
    }));

    return [
      { role: 'system', content: this.systemPrompt },
      ...this.messages,
      ...contextFileMessages
    ];
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
    this.addedSkillIds.clear(); // Clear skill tracking when history is cleared
  }

  /**
   * Check if a skill entry ID has already been added to the conversation
   */
  hasSkillBeenAdded(skillId: string): boolean {
    return this.addedSkillIds.has(skillId);
  }

  /**
   * Mark a skill entry ID as having been added to the conversation
   */
  markSkillAsAdded(skillId: string): void {
    this.addedSkillIds.add(skillId);
  }

  /**
   * Mark multiple skill entry IDs as having been added to the conversation
   */
  markSkillsAsAdded(skillIds: string[]): void {
    for (const id of skillIds) {
      this.addedSkillIds.add(id);
    }
  }

  /**
   * Clean up the session
   */
  async cleanup(): Promise<void> {
    await this.sandbox.cleanup();
  }

  /**
   * Get provider config for this session
   */
  getProviderConfig() {
    return {
      model: this.agent.config.model,
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
