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
import { SkillsService, SCORE_THRESHOLD as SKILLS_SCORE_THRESHOLD } from '../skills_system/SkillsService.js';

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
  private baseSystemPrompt: string;
  private initialized = false;
  private addedSkillIds: Set<string> = new Set(); // Track skill entry IDs that have been added to conversation
  private retrievedSkills: Map<string, string> = new Map();
  private lastSkillRefreshSignature: string | null = null;

  constructor(components: SessionComponents) {
    this.id = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
    this.agent = components.agent;
    this.provider = components.provider;
    this.syntax = components.syntax;
    this.loop = components.loop;
    this.tools = components.tools;
    this.sandbox = components.sandbox || createSandbox(this.agent.config.sandbox);

    const toolSkillEntries = this.tools.flatMap((tool) => tool.skillEntries || []);

    // Initialize SkillsService if agent has a skills table or loaded tools contribute local skills.
    if (this.agent.config.skillsTable || toolSkillEntries.length > 0) {
      this.skillsService = new SkillsService(this.agent.config.skillsTable, toolSkillEntries);
    }

    // Build the system prompt
    this.baseSystemPrompt = this.buildPrompt();
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
    const base = this.baseSystemPrompt.trim();
    const timeContext = formatLocalDeviceTime();

    if (!base) {
      if (this.retrievedSkills.size === 0) {
        return timeContext;
      }

      const skillsSectionOnly = Array.from(this.retrievedSkills.values())
        .map(content => content.trim())
        .filter(Boolean)
        .join('\n\n');

      return skillsSectionOnly
        ? `SKILLS:\n\n${skillsSectionOnly}\n\n${timeContext}`
        : timeContext;
    }

    if (this.retrievedSkills.size === 0) {
      return `${base}\n\n${timeContext}`;
    }

    const skillsSection = Array.from(this.retrievedSkills.values())
      .map(content => content.trim())
      .filter(Boolean)
      .join('\n\n');

    if (!skillsSection) {
      return `${base}\n\n${timeContext}`;
    }

    return `${base}\n\nSKILLS:\n\n${skillsSection}\n\n${timeContext}`;
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
      { role: 'system', content: this.getSystemPrompt() },
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
    this.retrievedSkills.clear();
    this.lastSkillRefreshSignature = null;
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
  markSkillAsAdded(skillId: string, content?: string): void {
    this.addedSkillIds.add(skillId);
    if (content && !this.retrievedSkills.has(skillId)) {
      this.retrievedSkills.set(skillId, content);
    }
  }

  /**
   * Mark multiple skill entry IDs as having been added to the conversation
   */
  markSkillsAsAdded(skillIds: string[], contents?: string[]): void {
    for (let i = 0; i < skillIds.length; i++) {
      this.markSkillAsAdded(skillIds[i]!, contents?.[i]);
    }
  }

  async refreshSkillsContext(
    extraMessages: Message[] = [],
    callbacks?: {
      onSkillsRetrieved?: (content: string, score: number) => void;
      onSkillsSearched?: (topScore: number | null) => void;
    }
  ): Promise<void> {
    if (!this.skillsService) {
      return;
    }

    const searchableMessages: Message[] = [
      ...this.messages,
      ...extraMessages,
      ...Array.from(this.contextFiles.entries()).map(([filename, content]) => ({
        role: 'file' as const,
        content,
        filename,
      })),
    ];

    try {
      const skillResult = await this.skillsService.searchHistory(searchableMessages);
      const newEntries = skillResult.entries.filter(entry => !this.hasSkillBeenAdded(entry.entry.id));
      const refreshSignature = JSON.stringify({
        query: skillResult.query,
        topScore: skillResult.topScore,
        matchedIds: skillResult.entries.map(entry => entry.entry.id),
        newIds: newEntries.map(entry => entry.entry.id),
      });

      if (refreshSignature === this.lastSkillRefreshSignature) {
        return;
      }
      this.lastSkillRefreshSignature = refreshSignature;

      if (newEntries.length > 0) {
        const addedIds = newEntries.map(entry => entry.entry.id);
        const contents = newEntries.map(entry => entry.content);
        this.markSkillsAsAdded(addedIds, contents);

        const skippedCount = skillResult.entries.length - newEntries.length;
        if (skippedCount > 0) {
          console.error(`[Session] Retrieved ${newEntries.length} new skill(s) (${skippedCount} already in system prompt, skipped) with scores: ${newEntries.map(e => (e.score * 100).toFixed(0) + '%').join(', ')}`);
        } else {
          console.error(`[Session] Retrieved ${newEntries.length} skill(s) with scores: ${newEntries.map(e => (e.score * 100).toFixed(0) + '%').join(', ')}`);
        }

        callbacks?.onSkillsRetrieved?.(contents.join('\n\n'), newEntries[0]?.score ?? 0);
        return;
      }

      if (skillResult.entries.length > 0) {
        console.error(`[Session] Skills search found ${skillResult.entries.length} matching entries, but all were already present in the system prompt`);
        return;
      }

      if (skillResult.topScore !== null) {
        console.error(`[Session] Skills search found no entries above ${(SKILLS_SCORE_THRESHOLD * 100).toFixed(0)}% threshold. Top score: ${(skillResult.topScore * 100).toFixed(0)}%`);
        callbacks?.onSkillsSearched?.(skillResult.topScore);
        return;
      }

      console.error('[Session] Skills search performed but found no matching entries');
      callbacks?.onSkillsSearched?.(null);
    } catch (error) {
      console.error('[Session] Skills search error:', error);
    } finally {
      this.skillsService.clearPreEmbeddedWords();
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
