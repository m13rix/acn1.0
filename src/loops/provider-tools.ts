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
import {
  buildCompletionWarning,
  PRIMARY_COMPLETION_FUNCTION,
} from '../core/completion.js';
import { buildProviderToolRequest } from '../core/providerTools.js';
import { NoStreamRegistry } from '../providers/NoStreamRegistry.js';

const DEFAULT_MAX_ITERATIONS = 500;

interface ProviderToolsLoopContext {
  session: Session;
  options: ExecutorOptions;
  processFileMessages: () => Promise<void>;
  processMemoryMessages: () => Promise<void>;
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
    const { session, options, processFileMessages, processMemoryMessages, toolEngine } = context;
    const maxIterations = options.maxIterations ?? DEFAULT_MAX_ITERATIONS;
    const callbacks = options.callbacks ?? {};
    const checkpoint = async (reason: string): Promise<void> => {
      if (!options.onCheckpoint) {
        return;
      }
      await options.onCheckpoint(session.exportSnapshot(), { reason });
    };

    const toolRequest: ProviderToolRequest = buildProviderToolRequest(options.requireFinish ?? true);
    const restoredState = session.getExecutionState();
    let iteration = restoredState?.mode === 'provider-tools'
      ? Math.max(0, restoredState.iterations)
      : 0;
    let pendingToolCalls = restoredState?.mode === 'provider-tools' && Array.isArray(restoredState.pendingProviderToolCalls)
      ? restoredState.pendingProviderToolCalls.map(toolCall => ({
        ...toolCall,
        arguments: { ...toolCall.arguments },
      }))
      : [];
    let nextToolIndex = restoredState?.mode === 'provider-tools'
      ? Math.max(0, restoredState.nextProviderToolIndex ?? 0)
      : 0;

    while (iteration < maxIterations) {
      iteration += 1;

      if (pendingToolCalls.length === 0) {
        await processFileMessages();
        await processMemoryMessages();

        const messages = session.getAllMessages();
        const providerConfig: ProviderConfig = {
          ...session.getProviderConfig(),
          stream: options.stream,
        };

        const provider = session.provider;
        if (!provider.completeWithTools) {
          throw new Error(`Provider "${provider.name}" does not support native tools`);
        }

        session.setExecutionState({
          mode: 'provider-tools',
          iterations: iteration,
          pendingProviderToolCalls: [],
          nextProviderToolIndex: 0,
        });
        await checkpoint('provider-tools-before-provider-call');

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
          const warningMessage = buildCompletionWarning();

          if (options.requireFinish) {
            session.addUserMessage(warningMessage);
            session.setExecutionState({
              mode: 'provider-tools',
              iterations: iteration,
              pendingProviderToolCalls: [],
              nextProviderToolIndex: 0,
            });
            await checkpoint('provider-tools-warning');
            continue;
          } else {
            const message = responseText || '(no content generated)';
            session.clearExecutionState();
            await checkpoint('provider-tools-natural-complete');
            callbacks.onResponse?.(message);
            return message;
          }
        }

        session.addMessage({
          role: 'assistant',
          content: responseText,
          reasoning: modelResponse.reasoning || '',
          reasoningDetails: modelResponse.reasoningDetails,
          toolCalls,
        });
        pendingToolCalls = toolCalls.map(toolCall => ({
          ...toolCall,
          arguments: { ...toolCall.arguments },
        }));

        // Deduplicate identical tool calls from the same model response.
        // When the LLM emits two identical tool calls (same name + same args),
        // only keep the first one to avoid double-execution.
        const seenContentKeys = new Set<string>();
        pendingToolCalls = pendingToolCalls.filter(tc => {
          const key = `${tc.name}::${JSON.stringify(tc.arguments)}`;
          if (seenContentKeys.has(key)) {
            return false;
          }
          seenContentKeys.add(key);
          return true;
        });

        nextToolIndex = 0;
        session.setExecutionState({
          mode: 'provider-tools',
          iterations: iteration,
          pendingProviderToolCalls: pendingToolCalls,
          nextProviderToolIndex: nextToolIndex,
        });
        await checkpoint('provider-tools-after-tool-call-response');
      }


      for (; nextToolIndex < pendingToolCalls.length; nextToolIndex++) {
        const toolCall = pendingToolCalls[nextToolIndex]!;
        session.setExecutionState({
          mode: 'provider-tools',
          iterations: iteration,
          pendingProviderToolCalls: pendingToolCalls,
          nextProviderToolIndex: nextToolIndex,
        });
        await checkpoint('provider-tools-before-tool-execution');

        const result = await toolEngine.executeProviderToolCall(toolCall);
        let observation = result.observation;
        if (result.finishParseError) {
          observation += `\nSYSTEM: ${result.finishParseError}`;
        }

        callbacks.onObservation?.(observation);

        if (toolCall.name === 'action') {
          await processFileMessages();
          await processMemoryMessages();
        }

        const modelObservation = await session.enrichToolResponseWithMemoryHints(observation, callbacks);
        session.addMessage({
          role: 'tool',
          content: modelObservation,
          toolCallId: toolCall.id,
          toolName: toolCall.name,
        });

        if (result.finishMessage) {
          session.clearExecutionState();
          await checkpoint('provider-tools-finish-message');
          callbacks.onResponse?.(result.finishMessage);
          return result.finishMessage;
        }

        session.setExecutionState({
          mode: 'provider-tools',
          iterations: iteration,
          pendingProviderToolCalls: pendingToolCalls,
          nextProviderToolIndex: nextToolIndex + 1,
        });
        await checkpoint('provider-tools-after-tool-execution');
      }

      pendingToolCalls = [];
      nextToolIndex = 0;
      session.setExecutionState({
        mode: 'provider-tools',
        iterations: iteration,
        pendingProviderToolCalls: [],
        nextProviderToolIndex: 0,
      });
      await checkpoint('provider-tools-iteration-complete');
    }

    const maxIterationMessage = '[Max iterations reached. Please continue with a new message if needed.]';
    session.clearExecutionState();
    await checkpoint('provider-tools-max-iterations');
    callbacks.onResponse?.(maxIterationMessage);
    return maxIterationMessage;
  }

  private async getModelResponseWithTools(
    messages: ReturnType<Session['getAllMessages']>,
    config: ProviderConfig,
    toolRequest: ProviderToolRequest,
    context: ProviderToolsLoopContext
  ): Promise<{ text: string; reasoning: string; reasoningDetails?: unknown[]; toolCalls: ProviderToolCall[] }> {
    const callbacks = context.options.callbacks ?? {};
    const provider = context.session.provider;

    // Check if this model is registered as no-stream (known streaming bugs)
    const noStreamRegistry = NoStreamRegistry.getInstance();
    const forceNoStream = noStreamRegistry.isNoStream(provider.name, config.model);

    if (forceNoStream && config.stream) {
      console.error(
        `[ProviderToolsLoop] Model "${config.model}" is in no-stream registry for "${provider.name}", using non-streaming mode.`
      );
    }
    const effectiveConfig: ProviderConfig = forceNoStream && config.stream
      ? { ...config, stream: false }
      : config;

    if (effectiveConfig.stream && provider.streamEventsWithTools && !forceNoStream) {
      let reasoning = '';
      let text = '';
      const toolCalls: ProviderToolCall[] = [];
      try {
        for await (const event of provider.streamEventsWithTools(messages, effectiveConfig, toolRequest)) {
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

        // Auto-register this model in the no-stream registry so future calls skip streaming
        const errorMsg = streamError instanceof Error ? streamError.message : String(streamError);
        noStreamRegistry.recordFailure(provider.name, config.model, errorMsg);
        if (!provider.completeWithTools) {
          throw streamError;
        }

        const fallbackResponse = await provider.completeWithTools(
          messages,
          { ...effectiveConfig, stream: false },
          toolRequest
        );
        callbacks.onTextDone?.(fallbackResponse.content || '');
        return {
          text: fallbackResponse.content || '',
          reasoning: fallbackResponse.reasoning || '',
          reasoningDetails: fallbackResponse.reasoningDetails,
          toolCalls: fallbackResponse.toolCalls || [],
        };
      }

      return { text, reasoning, toolCalls };
    }

    if (!provider.completeWithTools) {
      throw new Error(`Provider "${provider.name}" does not support native tools`);
    }

    const response = await provider.completeWithTools(messages, effectiveConfig, toolRequest);
    callbacks.onTextDone?.(response.content || '');
    return {
      text: response.content || '',
      reasoning: response.reasoning || '',
      reasoningDetails: response.reasoningDetails,
      toolCalls: response.toolCalls || [],
    };
  }

  getDescription(): string {
    return ``;
  }
}

registerLoop('provider-tools', () => new ProviderToolsLoop());

export default ProviderToolsLoop;
