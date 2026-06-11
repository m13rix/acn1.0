import { generateText, streamText } from 'ai';
import type {
  ProviderAuthChallenge,
  ProviderAuthCompletion,
  ProviderAuthStatus,
  ProviderConfig,
  ProviderResponse,
  ProviderStreamEvent,
  ProviderToolRequest,
  ProviderToolResponse,
} from '../types/index.js';
import { BaseProvider, registerProvider } from './base.js';
import { mapTextModelSettings, resolveTextLanguageModel } from '../ai-sdk/model-registry.js';
import { OpenAICodexProvider } from './openai-codex/index.js';
import {
  providerToolRequestToAiSdkTools,
  splitSystemMessages,
  telosMessagesToModelMessages,
  toolCallsFromAiSdkParts,
  usageFromAiSdk,
} from '../ai-sdk/message-mapper.js';

function mapFinishReason(reason: string): ProviderResponse['finishReason'] {
  if (reason === 'stop') return 'stop';
  if (reason === 'length') return 'length';
  if (reason === 'content-filter') return 'content_filter';
  if (reason === 'stop-sequence') return 'stop_sequence';
  return 'other';
}

export class AiSdkTextProvider extends BaseProvider {
  private codexProvider?: OpenAICodexProvider;

  constructor(public override name: string, private readonly apiKey?: string) {
    super();
  }

  override getAuthStatus(): Promise<ProviderAuthStatus> {
    if (this.name !== 'openai-codex') {
      return super.getAuthStatus();
    }
    return this.getCodexProvider().getAuthStatus();
  }

  override beginLogin(options?: Record<string, unknown>): Promise<ProviderAuthChallenge> {
    return this.getCodexProvider().beginLogin(options);
  }

  override completeLogin(payload: ProviderAuthCompletion): Promise<ProviderAuthStatus> {
    return this.getCodexProvider().completeLogin(payload);
  }

  override logout(profileId?: string): Promise<void> {
    return this.getCodexProvider().logout(profileId);
  }

  override async complete(messages: Parameters<BaseProvider['complete']>[0], config: ProviderConfig): Promise<ProviderResponse> {
    const response = await this.completeInternal(messages, config);
    return response;
  }

  override async completeWithTools(
    messages: Parameters<BaseProvider['complete']>[0],
    config: ProviderConfig,
    toolRequest: ProviderToolRequest
  ): Promise<ProviderToolResponse> {
    return this.completeInternal(messages, config, toolRequest);
  }

  override async *streamEvents(messages: Parameters<BaseProvider['complete']>[0], config: ProviderConfig): AsyncIterable<ProviderStreamEvent> {
    yield* this.streamInternal(messages, config);
  }

  override async *streamEventsWithTools(
    messages: Parameters<BaseProvider['complete']>[0],
    config: ProviderConfig,
    toolRequest: ProviderToolRequest
  ): AsyncIterable<ProviderStreamEvent> {
    yield* this.streamInternal(messages, config, toolRequest);
  }

  private async completeInternal(
    messages: Parameters<BaseProvider['complete']>[0],
    config: ProviderConfig,
    toolRequest?: ProviderToolRequest
  ): Promise<ProviderToolResponse> {
    this.validateConfig(config);
    const { system, messages: nonSystemMessages } = splitSystemMessages(messages);
    const { model, providerOptions } = resolveTextLanguageModel(this.name, config, this.apiKey);
    const result = await generateText({
      model,
      system: system || undefined,
      messages: telosMessagesToModelMessages(nonSystemMessages),
      tools: toolRequest ? providerToolRequestToAiSdkTools(toolRequest) : undefined,
      toolChoice: toolRequest?.toolChoice === 'none' ? 'none' : 'auto',
      stopWhen: () => true,
      providerOptions,
      ...mapTextModelSettings(config),
    } as any);

    return {
      content: result.text || '',
      reasoning: result.reasoningText || '',
      finishReason: mapFinishReason(result.finishReason),
      toolCalls: toolCallsFromAiSdkParts(result.content as any[]),
      usage: usageFromAiSdk(result.usage),
    };
  }

  private getCodexProvider(): OpenAICodexProvider {
    if (this.name !== 'openai-codex') {
      throw new Error(`Provider "${this.name}" does not support interactive login`);
    }
    this.codexProvider ??= new OpenAICodexProvider();
    return this.codexProvider;
  }

  private async *streamInternal(
    messages: Parameters<BaseProvider['complete']>[0],
    config: ProviderConfig,
    toolRequest?: ProviderToolRequest
  ): AsyncIterable<ProviderStreamEvent> {
    this.validateConfig(config);
    const { system, messages: nonSystemMessages } = splitSystemMessages(messages);
    const { model, providerOptions } = resolveTextLanguageModel(this.name, config, this.apiKey);
    const result = streamText({
      model,
      system: system || undefined,
      messages: telosMessagesToModelMessages(nonSystemMessages),
      tools: toolRequest ? providerToolRequestToAiSdkTools(toolRequest) : undefined,
      toolChoice: toolRequest?.toolChoice === 'none' ? 'none' : 'auto',
      stopWhen: () => true,
      providerOptions,
      ...mapTextModelSettings(config),
    } as any);

    for await (const part of result.fullStream) {
      if (part.type === 'reasoning-delta') {
        yield { type: 'reasoning.delta', delta: part.text };
      } else if (part.type === 'reasoning-end') {
        yield { type: 'reasoning.done' };
      } else if (part.type === 'text-delta') {
        yield { type: 'text.delta', delta: part.text };
      } else if (part.type === 'text-end') {
        yield { type: 'text.done' };
      } else if (part.type === 'tool-input-delta') {
        yield { type: 'tool_call.delta', toolCallId: part.id, delta: part.delta };
      } else if (part.type === 'tool-call') {
        yield {
          type: 'tool_call.done',
          toolCallId: part.toolCallId,
          toolName: part.toolName,
          toolCall: {
            id: part.toolCallId,
            name: part.toolName,
            arguments: part.input && typeof part.input === 'object' ? part.input as Record<string, unknown> : {},
          },
        };
      } else if (part.type === 'finish') {
        yield { type: 'done' };
      } else if (part.type === 'error') {
        throw part.error instanceof Error ? part.error : new Error(String(part.error));
      }
    }
  }
}

export function createTextRuntimePlaceholderProvider(name = 'ai-sdk-text') {
  return new AiSdkTextProvider(name);
}

for (const provider of ['openrouter', 'gemini', 'ollama', 'inception', 'kimi-code', 'openai-codex']) {
  registerProvider(provider, () => new AiSdkTextProvider(provider));
}
