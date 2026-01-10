/**
 * OpenRouter Provider
 * 
 * Maps universal OpenAI-style parameters to OpenRouter's API format.
 * OpenRouter provides access to multiple LLM models through a unified API.
 */

import { OpenRouter } from '@openrouter/sdk';
import { BaseProvider, registerProvider } from './base.js';
import type { Message, ProviderConfig, ProviderResponse, ProviderStreamChunk, ProviderStreamEvent } from '../types/index.js';

export class OpenRouterProvider extends BaseProvider {
  name = 'openrouter';
  private client: OpenRouter;
  
  constructor(apiKey?: string) {
    super();
    const key = apiKey || process.env['OPENROUTER_API_KEY'];
    if (!key) {
      throw new Error('OPENROUTER_API_KEY is required. Set it in environment or pass to constructor.');
    }
    this.client = new OpenRouter({ apiKey: key });
  }
  
  /**
   * Build the actual OpenRouter request object (public for debugging)
   */
  override buildRequest(messages: Message[], config: ProviderConfig): any {
    this.validateConfig(config);
    const cfg = this.withDefaults(config);
    
    return this.buildOpenRouterRequest(messages, cfg);
  }

  override async complete(messages: Message[], config: ProviderConfig): Promise<ProviderResponse> {
    this.validateConfig(config);
    const cfg = this.withDefaults(config);
    
    const request = this.buildOpenRouterRequest(messages, cfg);
    
    const response = await this.client.chat.send(request);
    
    // OpenRouter returns OpenAI-compatible format
    const choice = response.choices?.[0];
    if (!choice) {
      throw new Error('No response choices returned from OpenRouter');
    }
    
    // Handle content which can be string or array of content items
    const messageContent = choice.message?.content;
    const content = typeof messageContent === 'string' 
      ? messageContent 
      : Array.isArray(messageContent)
        ? messageContent
            .map(item => {
              if (typeof item === 'string') return item;
              // Extract text from text content items
              if (item && typeof item === 'object' && 'type' in item && item.type === 'text' && 'text' in item) {
                return item.text ?? '';
              }
              return '';
            })
            .join('')
        : '';
    
    const finishReason = this.mapFinishReason(choice.finishReason);
    
    const usage = response.usage ? {
      promptTokens: response.usage.promptTokens ?? 0,
      completionTokens: response.usage.completionTokens ?? 0,
      totalTokens: response.usage.totalTokens ?? 0,
    } : undefined;
    
    return {
      content,
      finishReason,
      usage,
    };
  }

  /**
   * @deprecated Use streamEvents instead
   */
  override async *stream(messages: Message[], config: ProviderConfig): AsyncIterable<ProviderStreamChunk> {
    // Delegate to streamEvents for backward compatibility
    for await (const event of this.streamEvents(messages, config)) {
      if (event.type === 'text.delta' && event.delta) {
        yield { delta: event.delta };
      } else if (event.type === 'done') {
        yield { delta: '', done: true };
      }
    }
  }

  /**
   * Industry-standard streaming with reasoning support.
   * Uses OpenRouter's chat.send with streaming and handles reasoning events.
   */
  override async *streamEvents(messages: Message[], config: ProviderConfig): AsyncIterable<ProviderStreamEvent> {
    this.validateConfig(config);
    const cfg = this.withDefaults(config);
    
    const request = this.buildOpenRouterRequest(messages, {
      ...cfg,
      stream: true,
    });
    
    // Use chat.send with streaming
    const streamPromise = this.client.chat.send({
      ...request,
      stream: true,
    }) as unknown as Promise<AsyncIterable<any>>;
    
    const streamResult = await streamPromise;
    
    let hasEmittedReasoningDone = false;
    
    for await (const chunk of streamResult) {
      const choice = chunk.choices?.[0];
      if (!choice) continue;
      
      // Handle reasoning content (if model supports it)
      // OpenRouter models that support reasoning include it in the response
      const reasoningDelta = choice.delta?.reasoning ?? choice.delta?.reasoning_content ?? '';
      if (reasoningDelta) {
        yield { type: 'reasoning.delta', delta: reasoningDelta };
      }
      
      // Handle text content
      const textDelta = choice.delta?.content ?? '';
      if (textDelta) {
        // If we were streaming reasoning and now have text, emit reasoning.done first
        if (!hasEmittedReasoningDone && reasoningDelta === '' && textDelta) {
          yield { type: 'reasoning.done' };
          hasEmittedReasoningDone = true;
        }
        yield { type: 'text.delta', delta: textDelta };
      }
      
      // Check for completion
      const finishReason = choice.finishReason || choice.finish_reason;
      if (finishReason) {
        yield { type: 'text.done' };
        yield { type: 'done' };
        return;
      }
    }
    
    // Ensure we emit done events
    yield { type: 'text.done' };
    yield { type: 'done' };
  }
  
  /**
   * Build an OpenRouter request object
   * OpenRouter uses OpenAI-compatible format, so mapping is straightforward
   */
  private buildOpenRouterRequest(
    messages: Message[],
    config: ProviderConfig
  ): any {
    // OpenRouter expects OpenAI-compatible message format
    // System messages are supported natively
    const openRouterMessages = messages.map(m => ({
      role: m.role,
      content: m.content,
    }));
    
    const request: any = {
      model: config.model,
      messages: openRouterMessages,
      temperature: config.temperature,
      max_tokens: config.maxTokens,
      top_p: config.top_p,
      top_k: config.top_k,
      seed: config.seed,
      frequency_penalty: config.frequency_penalty,
      presence_penalty: config.presence_penalty,
      // OpenRouter reasoning control (per docs). We map the framework's
      // off/low/medium/high into OpenRouter effort levels.
      reasoning: this.mapReasoning(config.reasoning),
      stream: config.stream ?? false,
    };
    
    // Only include stop sequences if they exist and have at least one element
    // OpenRouter (like OpenAI) expects stop to be an array with at least one string
    if (config.stopSequences && config.stopSequences.length > 0) {
      request.stop = config.stopSequences;
    }
    
    // Remove undefined values to keep request clean
    Object.keys(request).forEach(key => {
      if (request[key] === undefined) {
        delete request[key];
      }
    });
    
    return request;
  }

  /**
   * Map ACN's unified reasoning levels to OpenRouter's ReasoningConfig.
   *
   * ACN: off | low | medium (default) | high
   * OpenRouter effort: none | low | medium | high
   */
  private mapReasoning(
    reasoning: ProviderConfig['reasoning']
  ): { effort: 'none' | 'low' | 'medium' | 'high'; enabled?: boolean } {
    const level = reasoning ?? 'medium';
    switch (level) {
      case 'off':
        // Per OpenRouter ReasoningConfig: explicitly disable reasoning
        return { effort: 'none', enabled: false };
      case 'low':
        return { effort: 'low' };
      case 'high':
        return { effort: 'high' };
      case 'medium':
      default:
        return { effort: 'medium' };
    }
  }

  /**
   * Map OpenRouter finish reasons to universal format
   * OpenRouter uses OpenAI-compatible finish reasons (enum values)
   */
  private mapFinishReason(reason: string | null | undefined): ProviderResponse['finishReason'] {
    if (!reason) return 'other';
    
    // OpenRouter uses enum values, normalize to string for comparison
    const reasonStr = String(reason).toLowerCase();
    switch (reasonStr) {
      case 'stop':
        return 'stop';
      case 'length':
      case 'max_tokens':
        return 'length';
      case 'content_filter':
        return 'content_filter';
      case 'stop_sequence':
        return 'stop_sequence';
      default:
        return 'other';
    }
  }
}

// Register the provider
registerProvider('openrouter', () => new OpenRouterProvider());

export default OpenRouterProvider;
