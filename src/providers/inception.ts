import { BaseProvider, registerProvider } from './base.js';
import type { Message, ProviderConfig, ProviderResponse } from '../types/index.js';

const DEFAULT_BASE_URL = 'https://api.inceptionlabs.ai/v1';

interface InceptionChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface InceptionChoice {
  message?: {
    content?: string;
    reasoning?: string;
  };
  finish_reason?: string;
}

interface InceptionUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

interface InceptionResponse {
  choices?: InceptionChoice[];
  usage?: InceptionUsage;
}

function mapRole(role: Message['role']): InceptionChatMessage['role'] | null {
  if (role === 'system' || role === 'user' || role === 'assistant') {
    return role;
  }
  return null;
}

function mapReasoning(reasoning: ProviderConfig['reasoning']): string {
  if (reasoning === 'off' || !reasoning) {
    return 'instant';
  }
  return reasoning;
}

function mapFinishReason(reason: string | undefined): ProviderResponse['finishReason'] {
  switch (reason) {
    case 'stop':
      return 'stop';
    case 'length':
      return 'length';
    case 'content_filter':
      return 'content_filter';
    default:
      return 'other';
  }
}

export class InceptionProvider extends BaseProvider {
  name = 'inception';
  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(apiKey?: string, baseUrl?: string) {
    super();
    this.apiKey = apiKey || process.env.INCEPTION_API_KEY || '';
    this.baseUrl = baseUrl || process.env.INCEPTION_BASE_URL || DEFAULT_BASE_URL;
    if (!this.apiKey) {
      throw new Error('INCEPTION_API_KEY is required for the Inception provider.');
    }
  }

  override buildRequest(messages: Message[], config: ProviderConfig): any {
    this.validateConfig(config);
    const cfg = this.withDefaults(config);
    const mappedMessages: InceptionChatMessage[] = messages
      .map((message) => {
        const role = mapRole(message.role);
        if (!role) {
          return null;
        }
        return {
          role,
          content: message.content,
        };
      })
      .filter((message): message is InceptionChatMessage => Boolean(message));

    return {
      model: cfg.model,
      messages: mappedMessages,
      temperature: cfg.temperature,
      max_tokens: cfg.maxTokens,
      reasoning_effort: mapReasoning(cfg.reasoning),
      stream: Boolean(cfg.stream),
    };
  }

  override async complete(messages: Message[], config: ProviderConfig): Promise<ProviderResponse> {
    const request = this.buildRequest(messages, config);
    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(request),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Inception request failed with ${response.status}: ${body}`);
    }

    const parsed = await response.json() as InceptionResponse;
    const choice = parsed.choices?.[0];
    return {
      content: choice?.message?.content ?? '',
      reasoning: choice?.message?.reasoning ?? '',
      finishReason: mapFinishReason(choice?.finish_reason),
      usage: parsed.usage ? {
        promptTokens: parsed.usage.prompt_tokens ?? 0,
        completionTokens: parsed.usage.completion_tokens ?? 0,
        totalTokens: parsed.usage.total_tokens ?? 0,
      } : undefined,
    };
  }
}

registerProvider('inception', () => new InceptionProvider());
