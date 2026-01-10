/**
 * Session Manager
 * 
 * Manages agent session state including:
 * - Conversation history
 * - Sandbox lifecycle
 * - Configuration
 */

import type { Message, LoadedAgent, LoadedTool, Provider, SyntaxType, LoopType } from '../types/index.js';
import { Sandbox } from '../sandbox/Sandbox.js';
import { PromptBuilder } from './PromptBuilder.js';
import { SkillsService } from '../skills_system/SkillsService.js';

export interface SessionComponents {
  agent: LoadedAgent;
  provider: Provider;
  syntax: SyntaxType;
  loop: LoopType;
  tools: LoadedTool[];
}

export class Session {
  public readonly id: string;
  public readonly agent: LoadedAgent;
  public readonly provider: Provider;
  public readonly syntax: SyntaxType;
  public readonly loop: LoopType;
  public readonly tools: LoadedTool[];
  public readonly sandbox: Sandbox;
  public readonly skillsService?: SkillsService;
  
  private messages: Message[] = [];
  private systemPrompt: string;
  private initialized = false;
  
  constructor(components: SessionComponents) {
    this.id = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
    this.agent = components.agent;
    this.provider = components.provider;
    this.syntax = components.syntax;
    this.loop = components.loop;
    this.tools = components.tools;
    this.sandbox = new Sandbox();
    
    // Initialize SkillsService if agent has a skillsTable configured
    if (this.agent.config.skillsTable) {
      this.skillsService = new SkillsService(this.agent.config.skillsTable);
    }
    
    // Build the system prompt
    const promptBuilder = new PromptBuilder();
    this.systemPrompt = promptBuilder.build(
      this.agent,
      this.syntax,
      this.loop,
      this.tools
    );
  }
  
  /**
   * Initialize the session (creates sandbox, skills service, etc.)
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;
    
    // Initialize sandbox with tools and skillsTable
    await this.sandbox.initialize(this.tools, this.agent.config.skillsTable);
    
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
   * Get all messages including system prompt
   */
  getAllMessages(): Message[] {
    return [
      { role: 'system', content: this.systemPrompt },
      ...this.messages,
    ];
  }
  
  /**
   * Add a user message
   */
  addUserMessage(content: string): void {
    this.messages.push({ role: 'user', content });
  }
  
  /**
   * Add an assistant message
   */
  addAssistantMessage(content: string): void {
    this.messages.push({ role: 'assistant', content });
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
