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

import { actionContext } from './ActionContext.js';
import { agentContext } from './AgentContext.js'; // Import agentContext
import {
  buildCompletionContinuationMessage,
  buildCompletionWarning,
  COMPLETION_SIGNAL_REGEX,
} from './completion.js';
import type { Session } from './Session.js';
import type { ProviderConfig, ProviderStreamEvent } from '../types/index.js';
import { ToolExecutionEngine } from './ToolExecutionEngine.js';
import { readFile, unlink, writeFile, mkdir } from 'fs/promises';
import { join, dirname } from 'path';

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
  onFile?: (filename: string, content: string) => void;
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
  requireFinish?: boolean;
}

const DEFAULT_MAX_ITERATIONS = 500;

export class Executor {
  private session: Session;
  private options: ExecutorOptions;

  constructor(session: Session, options: ExecutorOptions = {}) {
    this.session = session;
    this.options = {
      maxIterations: options.maxIterations ?? DEFAULT_MAX_ITERATIONS,
      stream: options.stream ?? false,
      callbacks: options.callbacks ?? {},
      requireFinish: options.requireFinish ?? true,
    };
  }

  /**
   * Execute a user message and return the final response
   */
  async execute(userMessage: string): Promise<string> {
    this.session.addUserMessage(userMessage);

    // Shared execution helper for action/cli/file flows
    const toolEngine = new ToolExecutionEngine(this.session, {
      onAction: this.options.callbacks?.onAction,
      onCli: this.options.callbacks?.onCli,
      onFile: this.options.callbacks?.onFile,
    });

    // Provider-native loop path (loop owns provider round-trips and tool orchestration)
    if (this.session.loop.run) {
      const delegated = await this.session.loop.run({
        session: this.session,
        options: this.options,
        processFileMessages: this.processFileMessages.bind(this),
        toolEngine,
      });
      if (delegated !== null) {
        return delegated;
      }
    }

    let iterations = 0;
    let currentAssistantContent = '';
    let continuationUserMessage = buildCompletionContinuationMessage();

    while (iterations < (this.options.maxIterations ?? DEFAULT_MAX_ITERATIONS)) {
      iterations++;

      // Load any pending file messages (e.g., screenshots) into context
      await this.processFileMessages();

      const extraMessages = currentAssistantContent
        ? [
          {
            role: 'assistant' as const,
            content: currentAssistantContent,
          },
          {
            role: 'user' as const,
            content: continuationUserMessage,
          },
        ]
        : [];

      await this.session.refreshSkillsContext(extraMessages, this.options.callbacks);

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

      const hasFiles = processed.filesToWrite && processed.filesToWrite.length > 0;
      const hasDiffs = processed.diffs && processed.diffs.length > 0;
      const hasEdits = processed.edits && processed.edits.length > 0;

      if (!processed.hasAction && !processed.hasCli && !hasFiles && !hasDiffs && !hasEdits) {
        // No action or CLI - check if we should finish or force continue
        // We now REQUIRE TASK_DONE()/FINISH() to be called.
        // If we have no new actions, we must tell the agent to finish.
        if (this.options.requireFinish) {
          const warningMessage = buildCompletionWarning();

          // Append warning and continue loop
          currentAssistantContent += '\n\n' + warningMessage;

          // Add to session for next iteration
          this.session.addAssistantMessage(currentAssistantContent);
          this.session.addUserMessage(warningMessage); // Treat as system feedback

          // Reset assistant content for next turn
          currentAssistantContent = '';
          continuationUserMessage = buildCompletionContinuationMessage();

          continue; // Force next iteration
        } else {
          // Require finish is disabled, so we can exit the loop naturally
          // If there are no actions, we assume the agent is done with this turn/task
          const message = currentAssistantContent || '(no content generated)';

          // Commit the final state so it's not lost
          this.session.addAssistantMessage(currentAssistantContent);

          if (this.options.callbacks?.onResponse) {
            this.options.callbacks.onResponse(message);
          }
          return message;
        }
      }

      // Execute the action or CLI command
      let observationParts: string[] = [];
      let filename: string | undefined;

      // 1. Write files first
      if (hasFiles) {
        for (const file of processed.filesToWrite) {
          const result = await toolEngine.writeFileToSandbox(file.path, file.content);
          observationParts.push(result.observation);
        }
      }

      // 2. Apply Diffs (legacy unified diff format)
      if (hasDiffs) {
        for (const diff of processed.diffs) {
          // Execute handles diff parsing automatically
          // We treat it as an execution because the sandbox logic routes it to applyDiff
          const result = await this.session.sandbox.execute(diff, 'diff');

          if (result.success) {
            observationParts.push(result.output);
            if (result.filename) filename = result.filename; // Maybe useful if it executed something?
          } else {
            observationParts.push(`Error applying diff: ${result.error}\n${result.output}`);
          }
        }
      }

      // 3. Apply Search & Replace edits (new format - preferred)
      if (hasEdits) {
        for (const edit of processed.edits) {
          const result = await toolEngine.applySearchReplaceEdit(edit.filename, edit.content);
          observationParts.push(result.observation);
          if (result.filename) filename = result.filename;
        }
      }

      // 3. Execute Action or CLI
      if (processed.hasAction && processed.actionCode) {
        const result = await toolEngine.executeAction(processed.actionCode);
        if (result.filename) filename = result.filename;

        // Process file messages from .acn-files.json if it exists
        await this.processFileMessages();

        observationParts.push(result.observation);
      } else if (processed.hasCli && processed.cliCommand) {
        const result = await toolEngine.executeCli(processed.cliCommand);
        observationParts.push(result.observation);
        // CLI doesn't have a filename, so filename remains undefined
      }

      let observation = observationParts.join('\n\n');
      if (!observation && (hasFiles || hasDiffs)) {
        // If only files were written/diffed and no output produced (rare, but possible)
        observation = "Files processed successfully.";
      } else if (!observation) {
        observation = '(no executable content found)';
      }

      if (this.options.callbacks?.onObservation) {
        this.options.callbacks.onObservation(observation);
      }

      // Check for completion signal
      const finishMatch = observation.match(COMPLETION_SIGNAL_REGEX);
      if (finishMatch) {
        try {
          // Parse the JSON message
          const rawFinishPayload = finishMatch[1];
          if (!rawFinishPayload) {
            throw new Error('Completion payload is empty');
          }
          const finishMessage = JSON.parse(rawFinishPayload);

          // We found the completion signal.
          // Remove the signal from observation to keep history clean?
          // Or keep it as log? Let's keep it but maybe format it.

          // Commit the final state
          this.session.addAssistantMessage(currentAssistantContent);
          this.session.addUserMessage(observation); // Add final observation

          if (this.options.callbacks?.onResponse) {
            this.options.callbacks.onResponse(finishMessage);
          }

          return finishMessage;
        } catch (e) {
          console.error('Failed to parse completion message:', e);
          // Verify this doesn't loop infinitely if parse fails
          observation += '\nSYSTEM: Failed to parse completion message. Ensure it is a valid string.';
        }
      }

      // Build continuation - use the accumulated content (which now includes the new response)
      const continuation = this.session.loop.buildContinuationMessages(
        currentAssistantContent,
        observation,
        this.session.syntax,
        filename,
        userMessage
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

            // Dynamic Stopping: Check if an actionable block has been fully generated
            if (this.session.syntax.hasAnyClosedBlock(text)) {
              // We found a closed action/cli/file block.
              // Stop generation immediately to prevent hallucinations/extra actions.
              return { text, reasoning };
            }
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
