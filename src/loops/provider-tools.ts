/**
 * Provider Tools Loop
 *
 * Native provider tool-calling loop for OpenRouter/Ollama-style function calls.
 * Does not use syntax parsing.
 */

import { BaseLoop, registerLoop } from './base.js';
import type {
  ProcessedResponse,
  ProviderConfig,
  ProviderToolCall,
  ProviderToolRequest,
  SyntaxType,
} from '../types/index.js';
import type { Session } from '../core/Session.js';
import type { ExecutorOptions } from '../core/Executor.js';
import type { ToolExecutionEngine } from '../core/ToolExecutionEngine.js';

const DEFAULT_MAX_ITERATIONS = 500;

interface ProviderToolsLoopContext {
  session: Session;
  options: ExecutorOptions;
  processFileMessages: () => Promise<void>;
  toolEngine: ToolExecutionEngine;
}

export class ProviderToolsLoop extends BaseLoop {
  name = 'provider-tools';
  override stopSequences = [];

  override usesSyntax(): boolean {
    return false;
  }

  processResponse(response: string, _syntax: SyntaxType): ProcessedResponse {
    // provider-native loop does not rely on syntax parsing
    return {
      hasAction: false,
      actionCode: null,
      hasCli: false,
      cliCommand: null,
      filesToWrite: [],
      diffs: [],
      edits: [],
      fullResponse: response,
    };
  }

  buildContinuationMessages(
    currentAssistantContent: string,
    _observation: string,
    _syntax: SyntaxType,
    _filename?: string,
    _originalUserRequest?: string
  ): { updatedAssistantContent: string; continuationUserMessage: string } {
    return {
      updatedAssistantContent: currentAssistantContent,
      continuationUserMessage: '',
    };
  }

  override async run(context: ProviderToolsLoopContext): Promise<string | null> {
    const { session, options, processFileMessages, toolEngine } = context;
    const maxIterations = options.maxIterations ?? DEFAULT_MAX_ITERATIONS;
    const callbacks = options.callbacks ?? {};

    const toolRequest: ProviderToolRequest = {
      tools: [
        {
          type: 'function',
          function: {
            name: 'action',
            description: 'Execute TypeScript code in sandbox. Use a single "content" string argument.',
            parameters: {
              type: 'object',
              properties: {
                content: { type: 'string', description: 'TypeScript code to execute' },
              },
              required: ['content'],
            },
          },
        },
        {
          type: 'function',
          function: {
            name: 'cli',
            description: 'Execute shell command in sandbox. Use a single "content" string argument.',
            parameters: {
              type: 'object',
              properties: {
                content: { type: 'string', description: 'Shell command to execute' },
              },
              required: ['content'],
            },
          },
        },
        {
          type: 'function',
          function: {
            name: 'file',
            description: 'Create/update/edit a single file by filename. Use "filename" and "content".',
            parameters: {
              type: 'object',
              properties: {
                filename: { type: 'string', description: 'Target file path, e.g. ./src/app.ts' },
                content: {
                  type: 'string',
                  description: 'Either full file content or SEARCH/REPLACE edit payload for the specified filename',
                },
              },
              required: ['filename', 'content'],
            },
          },
        },
      ],
      toolChoice: 'auto',
    };

    for (let iteration = 0; iteration < maxIterations; iteration++) {
      await processFileMessages();

      const messages = session.getAllMessages();
      const providerConfig: ProviderConfig = {
        ...session.getProviderConfig(),
        stream: options.stream,
      };

      const provider = session.provider;
      if (!provider.completeWithTools) {
        throw new Error(`Provider "${provider.name}" does not support native tools`);
      }

      if (callbacks.onBeforeProviderCall) {
        const actualRequest = provider.buildRequestWithTools
          ? provider.buildRequestWithTools(messages, providerConfig, toolRequest)
          : provider.buildRequest?.(messages, providerConfig);
        callbacks.onBeforeProviderCall(messages, providerConfig, actualRequest);
      }

      const modelResponse = await this.getModelResponseWithTools(messages, providerConfig, toolRequest, context);
      const responseText = modelResponse.text || '';
      const toolCalls = modelResponse.toolCalls || [];

      if (toolCalls.length === 0) {
        if (responseText.trim()) {
          session.addAssistantMessage(responseText);
        }
        const warningMessage = 'SYSTEM: You haven\'t completed the task yet. To finish, you MUST call the `FINISH("message")` function with a description of what you have done and the result.';

        if (options.requireFinish) {
          session.addUserMessage(warningMessage);
          continue;
        } else {
          // Require finish is disabled, so we can exit the loop naturally
          const message = responseText || '(no content generated)';

          // Content already added above if it exists

          callbacks.onResponse?.(message);
          return message;
        }
      }

      session.addMessage({
        role: 'assistant',
        content: responseText,
        toolCalls,
      });

      for (const toolCall of toolCalls) {
        const result = await toolEngine.executeProviderToolCall(toolCall);
        let observation = result.observation;
        if (result.finishParseError) {
          observation += `\nSYSTEM: ${result.finishParseError}`;
        }

        callbacks.onObservation?.(observation);
        session.addMessage({
          role: 'tool',
          content: observation,
          toolCallId: toolCall.id,
          toolName: toolCall.name,
        });

        if (toolCall.name === 'action') {
          await processFileMessages();
        }

        if (result.finishMessage) {
          callbacks.onResponse?.(result.finishMessage);
          return result.finishMessage;
        }
      }
    }

    const maxIterationMessage = '[Max iterations reached. Please continue with a new message if needed.]';
    callbacks.onResponse?.(maxIterationMessage);
    return maxIterationMessage;
  }

  private async getModelResponseWithTools(
    messages: ReturnType<Session['getAllMessages']>,
    config: ProviderConfig,
    toolRequest: ProviderToolRequest,
    context: ProviderToolsLoopContext
  ): Promise<{ text: string; reasoning: string; toolCalls: ProviderToolCall[] }> {
    const callbacks = context.options.callbacks ?? {};
    const provider = context.session.provider;

    if (config.stream && provider.streamEventsWithTools) {
      let reasoning = '';
      let text = '';
      const toolCalls: ProviderToolCall[] = [];
      try {
        for await (const event of provider.streamEventsWithTools(messages, config, toolRequest)) {
          switch (event.type) {
            case 'reasoning.delta':
              if (event.delta) {
                reasoning += event.delta;
                callbacks.onReasoningDelta?.(event.delta, reasoning);
              }
              break;
            case 'reasoning.done':
              callbacks.onReasoningDone?.(reasoning);
              break;
            case 'text.delta':
              if (event.delta) {
                text += event.delta;
                callbacks.onTextDelta?.(event.delta, text);
                callbacks.onStreamChunk?.(event.delta, text);
              }
              break;
            case 'text.done':
              callbacks.onTextDone?.(text);
              break;
            case 'tool_call.done':
              if (event.toolCall) {
                toolCalls.push(event.toolCall);
              }
              break;
            case 'tool_call.delta':
            case 'done':
              break;
          }
        }
      } catch (streamError) {
        console.warn(`[ProviderToolsLoop] Streaming with tools failed for provider "${provider.name}", falling back to non-stream tool completion.`, streamError);
        if (!provider.completeWithTools) {
          throw streamError;
        }

        const fallbackResponse = await provider.completeWithTools(
          messages,
          { ...config, stream: false },
          toolRequest
        );
        callbacks.onTextDone?.(fallbackResponse.content || '');
        return {
          text: fallbackResponse.content || '',
          reasoning: fallbackResponse.reasoning || '',
          toolCalls: fallbackResponse.toolCalls || [],
        };
      }

      return { text, reasoning, toolCalls };
    }

    if (!provider.completeWithTools) {
      throw new Error(`Provider "${provider.name}" does not support native tools`);
    }

    const response = await provider.completeWithTools(messages, config, toolRequest);
    callbacks.onTextDone?.(response.content || '');
    return {
      text: response.content || '',
      reasoning: response.reasoning || '',
      toolCalls: response.toolCalls || [],
    };
  }

  getDescription(): string {
    return `## Loop (provider-tools)

- Use native provider function tools instead of fenced syntax blocks.
- Available tools:
  - \`action(content)\` for TypeScript execution.
  - \`cli(content)\` for shell command execution.
  - \`file(filename, content)\` for single-file write/edit.
- Tool calls are executed sequentially.
- To finish, you MUST call \`FINISH("message")\` inside \`action\` tool code.`;
  }
}

registerLoop('provider-tools', () => new ProviderToolsLoop());

export default ProviderToolsLoop;
