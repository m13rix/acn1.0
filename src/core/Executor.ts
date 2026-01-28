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
import { readFile, unlink } from 'fs/promises';
import { join } from 'path';

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
const SKILLS_SCORE_THRESHOLD = 0.8; // 80% minimum score for automated skill retrieval

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

        if (skillResult && skillResult.entries && skillResult.entries.length > 0) {
          // Filter out entries that have already been added to the conversation (save tokens)
          const newEntries = skillResult.entries.filter(entry => {
            return !this.session.hasSkillBeenAdded(entry.entry.id);
          });

          if (newEntries.length > 0) {
            // Format multiple entries as separate <skills> tags
            const contents = newEntries.map(e => e.content);
            const wrappedSkills = this.session.syntax.wrapSkillsMultiple
              ? this.session.syntax.wrapSkillsMultiple(contents)
              : contents.map(content => this.session.syntax.wrapSkills(content)).join('\n');
            enhancedMessage = userMessage + '\n\n' + wrappedSkills;

            // Mark these skill entries as added to prevent duplicates in future messages
            const addedIds = newEntries.map(e => e.entry.id);
            this.session.markSkillsAsAdded(addedIds);

            // Debug log for skills retrieval
            const skippedCount = skillResult.entries.length - newEntries.length;
            if (skippedCount > 0) {
              console.log(`[Executor] Retrieved ${newEntries.length} new skill(s) (${skippedCount} already in context, skipped) with scores: ${newEntries.map(e => (e.score * 100).toFixed(0) + '%').join(', ')}`);
            } else {
              console.log(`[Executor] Retrieved ${newEntries.length} skill(s) with scores: ${newEntries.map(e => (e.score * 100).toFixed(0) + '%').join(', ')}`);
            }

            // Call callback for each entry (or combine - using highest score for backward compatibility)
            const topScore = newEntries[0]?.score ?? 0;
            const combinedContent = newEntries.map(e => e.content).join('\n\n');
            if (this.options.callbacks?.onSkillsRetrieved) {
              this.options.callbacks.onSkillsRetrieved(combinedContent, topScore);
            }
          } else {
            // All entries were already in context - nothing new to add
            console.log(`[Executor] Skills search found ${skillResult.entries.length} matching entries, but all were already added to context (skipped to save tokens)`);
          }
        } else {
          // Notify that search was performed but didn't meet threshold
          if (skillResult && skillResult.entries && skillResult.entries.length > 0) {
            const topEntry = skillResult.entries[0];
            if (topEntry) {
              console.log(`[Executor] Skills search found ${skillResult.entries.length} entries but none met 80% threshold. Top score: ${(topEntry.score * 100).toFixed(0)}%`);
              if (this.options.callbacks?.onSkillsSearched) {
                this.options.callbacks.onSkillsSearched(topEntry.score);
              }
            } else {
              console.log(`[Executor] Skills search performed but found no matching entries`);
              if (this.options.callbacks?.onSkillsSearched) {
                this.options.callbacks.onSkillsSearched(null);
              }
            }
          } else {
            console.log(`[Executor] Skills search performed but found no matching entries`);
            if (this.options.callbacks?.onSkillsSearched) {
              this.options.callbacks.onSkillsSearched(null);
            }
          }
        }
      } catch (error) {
        // Skills search failed - continue without skills
        console.error('[Executor] Skills search error:', error);
      }

      // Clear pre-embedded words after search (deprecated but harmless)
      this.session.skillsService.clearPreEmbeddedWords();
    }

    // Add (possibly enhanced) user message to history
    this.session.addUserMessage(enhancedMessage);

    let iterations = 0;
    let currentAssistantContent = '';
    let continuationUserMessage = 'Continue with the user request.';

    while (iterations < (this.options.maxIterations ?? DEFAULT_MAX_ITERATIONS)) {
      iterations++;

      // Load any pending file messages (e.g., screenshots) into context
      await this.processFileMessages();

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
      const modelResponse = await this.getModelResponse(messages, providerConfig);
      const responseText = modelResponse.text;
      const reasoningText = modelResponse.reasoning || '';

      // Wrap reasoning in syntax tags if it exists and isn't already wrapped
      let reasoningToSave = reasoningText;
      let wrappedReasoning = '';
      if (reasoningText) {
        // Check if reasoning already has <think> or <thought> tags
        const hasThink = this.session.syntax.name === 'xml-tags' &&
          (reasoningText.trim().startsWith('<think') || reasoningText.trim().startsWith('<thought'));

        if (hasThink) {
          reasoningToSave = reasoningText;
          wrappedReasoning = reasoningText;
        } else {
          wrappedReasoning = this.session.syntax.wrapThinking(reasoningText);
          reasoningToSave = wrappedReasoning;
        }
      }

      // Combine for processing. We want to find actions in both.
      const responseToProcess = wrappedReasoning + (wrappedReasoning && responseText ? '\n' : '') + responseText;

      // Process the combined response to detect actions
      const processed = this.session.loop.processResponse(
        responseToProcess,
        this.session.syntax
      );

      // Append EVERYTHING to current assistant content for history
      currentAssistantContent += responseToProcess;

      // Extract and notify about thinking (for backward compatibility/callbacks)
      // Note: we now look at the processed/wrapped content
      const thinking = this.session.syntax.getThinking(responseToProcess);
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

      let filename: string | undefined;

      if (processed.hasAction && processed.actionCode) {
        // Execute code action
        if (this.options.callbacks?.onAction) {
          this.options.callbacks.onAction(processed.actionCode);
        }

        const result = await this.session.sandbox.execute(processed.actionCode);
        filename = result.filename; // Get filename from result

        // Process file messages from .acn-files.json if it exists
        await this.processFileMessages();

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
        // CLI doesn't have a filename, so filename remains undefined
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
        this.session.syntax,
        filename,
        enhancedMessage
      );

      // Check if this loop type commits messages after each action
      const shouldCommit = this.session.loop.shouldCommitMessagesAfterAction?.() ?? false;

      if (shouldCommit) {
        // Commit the assistant message with the completed action to history
        this.session.addAssistantMessage(continuation.updatedAssistantContent);

        // Add the observation as a new user message (it's already wrapped in continuationUserMessage)
        this.session.addUserMessage(continuation.continuationUserMessage);

        // Reset for next iteration - will continue from conversation history
        currentAssistantContent = '';
        continuationUserMessage = '';
      } else {
        // Accumulate in currentAssistantContent (default behavior)
        currentAssistantContent = continuation.updatedAssistantContent;
        continuationUserMessage = continuation.continuationUserMessage;
      }
    }

    // Max iterations reached
    // If currentAssistantContent is empty, we've committed all messages (message-passthrough loop)
    // In that case, the conversation is already in a good state
    if (currentAssistantContent) {
      const finalMessage = currentAssistantContent +
        '\n\n[Max iterations reached. Please continue with a new message if needed.]';

      this.session.addAssistantMessage(finalMessage);

      if (this.options.callbacks?.onResponse) {
        this.options.callbacks.onResponse(finalMessage);
      }

      return finalMessage;
    } else {
      // All messages have been committed, conversation is complete
      const message = '[Max iterations reached. Please continue with a new message if needed.]';

      if (this.options.callbacks?.onResponse) {
        this.options.callbacks.onResponse(message);
      }

      return message;
    }
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

  private async getModelResponse(messages: any[], config: ProviderConfig): Promise<{ text: string; reasoning: string }> {
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
      return { text: out, reasoning: '' };
    }

    const response = await this.session.provider.complete(messages, config);
    return { text: response.content, reasoning: response.reasoning || '' };
  }

  /**
   * Stream response with proper event handling for reasoning and text
   */
  private async streamWithEvents(messages: any[], config: ProviderConfig): Promise<{ text: string; reasoning: string }> {
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

    return { text, reasoning };
  }

  /**
   * Process file messages from .acn-files.json
   * Reads the file, adds file messages to session, and deletes the file
   */
  private async processFileMessages(): Promise<void> {
    const filesJsonPath = join(this.session.sandbox.directory, '.acn-files.json');

    try {
      // Check if file exists
      const content = await readFile(filesJsonPath, 'utf-8');
      const files = JSON.parse(content) as Array<{ content: string; filename: string }>;

      // Add each file as a file message to the session
      for (const file of files) {
        this.session.addFileMessage(file.content, file.filename);
      }

      // Delete the file after processing
      await unlink(filesJsonPath);
    } catch (error: any) {
      // File doesn't exist or error reading - ignore (not an error condition)
      if (error.code !== 'ENOENT') {
        // Only log non-ENOENT errors (file not found is expected if no files were viewed)
        console.warn(`[Executor] Failed to process file messages: ${error.message}`);
      }
    }
  }
}

export default Executor;
