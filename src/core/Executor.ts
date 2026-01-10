/**
 * Executor
 * 
 * Main orchestrator for the agent loop.
 * Handles the full cycle of:
 * 1. Sending messages to the provider
 * 2. Processing responses
 * 3. Executing actions in sandbox
 * 4. Appending observations
 * 5. Continuing until complete
 */

import type { Session } from './Session.js';
import type { ProviderConfig, ProviderStreamEvent } from '../types/index.js';

/**
 * Streaming callbacks following industry-standard patterns
 */
export interface StreamCallbacks {
  /** Called when reasoning content is streamed */
  onReasoningDelta?: (delta: string, accumulated: string) => void;
  /** Called when reasoning completes */
  onReasoningDone?: (fullReasoning: string) => void;
  /** Called when text content is streamed */
  onTextDelta?: (delta: string, accumulated: string) => void;
  /** Called when text completes */
  onTextDone?: (fullText: string) => void;
}

export interface ExecutorCallbacks extends StreamCallbacks {
  onThinking?: (content: string) => void;
  onAction?: (code: string) => void;
  onCli?: (command: string) => void;
  onObservation?: (output: string) => void;
  onResponse?: (content: string) => void;
  onError?: (error: Error) => void;
  onBeforeProviderCall?: (messages: any[], config: ProviderConfig, actualRequest?: any) => void;
  /** Called when skills are retrieved and added to the message */
  onSkillsRetrieved?: (content: string, score: number) => void;
  /** Called when skills search is performed but score is below threshold */
  onSkillsSearched?: (topScore: number | null) => void;
  /** @deprecated Use onTextDelta instead */
  onStreamChunk?: (delta: string, accumulated: string) => void;
}

export interface ExecutorOptions {
  maxIterations?: number;
  stream?: boolean;
  callbacks?: ExecutorCallbacks;
}

const DEFAULT_MAX_ITERATIONS = 10;
const SKILLS_SCORE_THRESHOLD = 0.7; // 70% minimum score for automated skill retrieval

export class Executor {
  private session: Session;
  private options: ExecutorOptions;
  
  constructor(session: Session, options: ExecutorOptions = {}) {
    this.session = session;
    this.options = {
      maxIterations: options.maxIterations ?? DEFAULT_MAX_ITERATIONS,
      stream: options.stream ?? false,
      callbacks: options.callbacks ?? {},
    };
  }
  
  /**
   * Execute a user message and return the final response
   */
  async execute(userMessage: string): Promise<string> {
    // Run skills search if configured
    let enhancedMessage = userMessage;
    
    if (this.session.skillsService) {
      try {
        const skillResult = await this.session.skillsService.search(userMessage);
        
        if (skillResult && skillResult.normalizedScore >= SKILLS_SCORE_THRESHOLD) {
          // Wrap skill content and append to message
          const wrappedSkills = this.session.syntax.wrapSkills(skillResult.content);
          enhancedMessage = userMessage + '\n\n' + wrappedSkills;
          
          if (this.options.callbacks?.onSkillsRetrieved) {
            this.options.callbacks.onSkillsRetrieved(skillResult.content, skillResult.normalizedScore);
          }
        } else {
          // Notify that search was performed but didn't meet threshold
          if (this.options.callbacks?.onSkillsSearched) {
            this.options.callbacks.onSkillsSearched(skillResult?.normalizedScore ?? null);
          }
        }
      } catch (error) {
        // Skills search failed - continue without skills
        console.error('[Executor] Skills search error:', error);
      }
      
      // Clear pre-embedded words after search
      this.session.skillsService.clearPreEmbeddedWords();
    }
    
    // Add (possibly enhanced) user message to history
    this.session.addUserMessage(enhancedMessage);
    
    let iterations = 0;
    let currentAssistantContent = '';
    let continuationUserMessage = 'Continue with the user request.';
    
    while (iterations < (this.options.maxIterations ?? DEFAULT_MAX_ITERATIONS)) {
      iterations++;
      
      // Build messages for the provider
      const messages = this.buildMessages(currentAssistantContent, continuationUserMessage);
      const providerConfig: ProviderConfig = {
        ...this.session.getProviderConfig(),
        stream: this.options.stream,
      };
      
      // Debug: Output actual provider request before provider call
      if (this.options.callbacks?.onBeforeProviderCall) {
        // Build the actual provider-specific request
        const actualRequest = this.session.provider.buildRequest?.(messages, providerConfig);
        this.options.callbacks.onBeforeProviderCall(messages, providerConfig, actualRequest);
      }
      
      // Get response from provider
      const responseText = await this.getModelResponseText(messages, providerConfig);
      
      // Process the NEW response text only (not accumulated content) to detect if there's a new action
      const processed = this.session.loop.processResponse(
        responseText,
        this.session.syntax
      );
      
      // Append to current content AFTER processing
      currentAssistantContent += responseText;
      
      // Extract and notify about thinking
      const thinking = this.session.syntax.getThinking(responseText);
      if (thinking && this.options.callbacks?.onThinking) {
        this.options.callbacks.onThinking(thinking);
      }
      
      if (!processed.hasAction && !processed.hasCli) {
        // No action or CLI - we're done
        this.session.addAssistantMessage(currentAssistantContent);
        
        if (this.options.callbacks?.onResponse) {
          this.options.callbacks.onResponse(currentAssistantContent);
        }
        
        return currentAssistantContent;
      }
      
      // Execute the action or CLI command
      let observation: string;
      
      if (processed.hasAction && processed.actionCode) {
        // Execute code action
        if (this.options.callbacks?.onAction) {
          this.options.callbacks.onAction(processed.actionCode);
        }
        
        const result = await this.session.sandbox.execute(processed.actionCode);
        
        if (result.success) {
          observation = result.output;
        } else {
          observation = `Error: ${result.error}\n${result.output}`.trim();
        }
      } else if (processed.hasCli && processed.cliCommand) {
        // Execute CLI command
        if (this.options.callbacks?.onCli) {
          this.options.callbacks.onCli(processed.cliCommand);
        }
        
        const result = await this.session.sandbox.executeCli(processed.cliCommand);
        
        if (result.success) {
          observation = result.output;
        } else {
          observation = `Error: ${result.error}\n${result.output}`.trim();
        }
      } else {
        // Shouldn't happen, but handle gracefully
        observation = '(no executable content found)';
      }
      
      if (this.options.callbacks?.onObservation) {
        this.options.callbacks.onObservation(observation);
      }
      
      // Build continuation - use the accumulated content (which now includes the new response)
      const continuation = this.session.loop.buildContinuationMessages(
        currentAssistantContent,
        observation,
        this.session.syntax
      );
      
      // Update current content for next iteration
      currentAssistantContent = continuation.updatedAssistantContent;
      continuationUserMessage = continuation.continuationUserMessage;
    }
    
    // Max iterations reached
    const finalMessage = currentAssistantContent + 
      '\n\n[Max iterations reached. Please continue with a new message if needed.]';
    
    this.session.addAssistantMessage(finalMessage);
    
    if (this.options.callbacks?.onResponse) {
      this.options.callbacks.onResponse(finalMessage);
    }
    
    return finalMessage;
  }
  
  /**
   * Build messages array for the provider
   */
  private buildMessages(currentAssistantContent: string, continuationUserMessage: string) {
    const messages = [...this.session.getAllMessages()];
    
    if (currentAssistantContent) {
      // We're in the middle of a loop - add the current assistant content
      // and a continuation user message
      messages.push({ 
        role: 'assistant' as const, 
        content: currentAssistantContent 
      });
      messages.push({ 
        role: 'user' as const, 
        content: continuationUserMessage
      });
    }
    
    return messages;
  }

  private async getModelResponseText(messages: any[], config: ProviderConfig): Promise<string> {
    // Prefer streamEvents for industry-standard streaming with reasoning support
    if (config.stream && this.session.provider.streamEvents) {
      return this.streamWithEvents(messages, config);
    }
    
    // Fallback to legacy stream method
    if (config.stream && this.session.provider.stream) {
      let out = '';
      for await (const chunk of this.session.provider.stream(messages, config)) {
        if (chunk.delta) {
          out += chunk.delta;
          // Call streaming callbacks
          if (this.options.callbacks?.onTextDelta) {
            this.options.callbacks.onTextDelta(chunk.delta, out);
          }
          // Legacy callback support
          if (this.options.callbacks?.onStreamChunk) {
            this.options.callbacks.onStreamChunk(chunk.delta, out);
          }
        }
        if (chunk.done) {
          break;
        }
      }
      return out;
    }

    const response = await this.session.provider.complete(messages, config);
    return response.content;
  }

  /**
   * Stream response with proper event handling for reasoning and text
   */
  private async streamWithEvents(messages: any[], config: ProviderConfig): Promise<string> {
    let reasoning = '';
    let text = '';
    
    for await (const event of this.session.provider.streamEvents!(messages, config)) {
      switch (event.type) {
        case 'reasoning.delta':
          if (event.delta) {
            reasoning += event.delta;
            this.options.callbacks?.onReasoningDelta?.(event.delta, reasoning);
          }
          break;
          
        case 'reasoning.done':
          this.options.callbacks?.onReasoningDone?.(reasoning);
          break;
          
        case 'text.delta':
          if (event.delta) {
            text += event.delta;
            this.options.callbacks?.onTextDelta?.(event.delta, text);
            // Legacy callback support
            this.options.callbacks?.onStreamChunk?.(event.delta, text);
          }
          break;
          
        case 'text.done':
          this.options.callbacks?.onTextDone?.(text);
          break;
          
        case 'done':
          // Full response complete
          break;
      }
    }
    
    return text;
  }
}

export default Executor;
