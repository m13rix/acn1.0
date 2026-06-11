/**
 * OpenRouter Provider
 * 
 * Maps universal OpenAI-style parameters to OpenRouter's API format.
 * OpenRouter provides access to multiple LLM models through a unified API.
 */

import { OpenRouter } from '@openrouter/sdk';
import { BaseProvider, registerProvider } from './base.js';
import { OAuthOnlyModelSelectedViaApiProviderError } from './openai-codex/errors.js';
import type {
  Message,
  ProviderConfig,
  ProviderResponse,
  ProviderStreamChunk,
  ProviderStreamEvent,
  ProviderToolCall,
  ProviderToolRequest,
  ProviderToolResponse,
} from '../types/index.js';
// @ts-ignore - mime-types doesn't have perfect TypeScript types
import { lookup } from 'mime-types';

const EMPTY_CHOICES_RETRY_DELAYS_MS = [250, 750];
const OPENROUTER_RETRY_DELAYS_MS = [1500, 3000, 6000, 12000];

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
    this.ensureSupportedModel(config.model);
    const cfg = this.withDefaults(config);

    return this.buildOpenRouterRequest(messages, cfg);
  }

  override buildRequestWithTools(
    messages: Message[],
    config: ProviderConfig,
    toolRequest: ProviderToolRequest
  ): any {
    this.validateConfig(config);
    this.ensureSupportedModel(config.model);
    const cfg = this.withDefaults(config);
    return this.buildOpenRouterRequest(messages, cfg, toolRequest);
  }

  override async complete(messages: Message[], config: ProviderConfig): Promise<ProviderResponse> {
    this.validateConfig(config);
    this.ensureSupportedModel(config.model);
    const cfg = this.withDefaults(config);

    const request = this.buildOpenRouterRequest(messages, cfg);
    const response = await this.sendWithMissingReasoningFallback(messages, cfg, undefined, request);
    const choice = this.getPrimaryChoiceOrThrow(response);

    // Handle content which can be string or array of content items
    const content = this.extractMessageText(choice.message);

    const reasoningInfo = this.extractReasoning(choice);
    const finishReason = this.mapFinishReason(choice.finishReason);

    const usage = response.usage ? {
      promptTokens: response.usage.promptTokens ?? 0,
      completionTokens: response.usage.completionTokens ?? 0,
      totalTokens: response.usage.totalTokens ?? 0,
    } : undefined;

    return {
      content,
      reasoning: reasoningInfo.text,
      reasoningDetails: reasoningInfo.details,
      finishReason,
      usage,
    };
  }

  override async completeWithTools(
    messages: Message[],
    config: ProviderConfig,
    toolRequest: ProviderToolRequest
  ): Promise<ProviderToolResponse> {
    this.validateConfig(config);
    this.ensureSupportedModel(config.model);
    const cfg = this.withDefaults(config);
    const request = this.buildOpenRouterRequest(messages, cfg, toolRequest);
    const response = await this.sendWithMissingReasoningFallback(messages, cfg, toolRequest, request);
    const choice = this.getPrimaryChoiceOrThrow(response);

    const parsedToolCalls = this.parseToolCalls((choice as any)?.message);
    const content = this.extractMessageText(choice.message);

    const reasoningInfo = this.extractReasoning(choice);
    const finishReason = this.mapFinishReason(choice.finishReason);
    const usage = response.usage ? {
      promptTokens: response.usage.promptTokens ?? 0,
      completionTokens: response.usage.completionTokens ?? 0,
      totalTokens: response.usage.totalTokens ?? 0,
    } : undefined;

    return {
      content,
      reasoning: reasoningInfo.text,
      reasoningDetails: reasoningInfo.details,
      finishReason,
      usage,
      toolCalls: parsedToolCalls,
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
    this.ensureSupportedModel(config.model);
    const cfg = this.withDefaults(config);

    const request = this.buildOpenRouterRequest(messages, {
      ...cfg,
      stream: true,
    });

    // Use chat.send with streaming
    const streamResult = await this.sendChatRequestWithRetry(
      {
        ...request,
        stream: true,
      },
      'stream'
    ) as AsyncIterable<any>;

    let hasEmittedReasoningDone = false;

    for await (const chunk of streamResult) {
      const choice = chunk.choices?.[0];
      if (!choice) continue;

      // Handle reasoning content (if model supports it)
      // OpenRouter models that support reasoning include it in the response
      const reasoningDelta = choice.delta?.reasoning
        ?? choice.delta?.reasoning_content
        ?? this.extractReasoningTextFromDetails(choice.delta?.reasoningDetails)
        ?? '';
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

  override async *streamEventsWithTools(
    messages: Message[],
    config: ProviderConfig,
    toolRequest: ProviderToolRequest
  ): AsyncIterable<ProviderStreamEvent> {
    this.validateConfig(config);
    this.ensureSupportedModel(config.model);
    const cfg = this.withDefaults(config);
    const request = this.buildOpenRouterRequest(messages, { ...cfg, stream: true }, toolRequest);

    const streamResult = await this.sendChatRequestWithRetry(
      {
        ...request,
        stream: true,
      },
      'stream-with-tools'
    ) as AsyncIterable<any>;
    const toolCallState = new Map<number, { id: string; name: string; argumentsRaw: string }>();
    let hasEmittedReasoningDone = false;

    for await (const chunk of streamResult) {
      const choice = chunk.choices?.[0];
      if (!choice) continue;

      const reasoningDelta = choice.delta?.reasoning
        ?? choice.delta?.reasoning_content
        ?? this.extractReasoningTextFromDetails(choice.delta?.reasoningDetails)
        ?? '';
      if (reasoningDelta) {
        yield { type: 'reasoning.delta', delta: reasoningDelta };
      }

      const textDelta = choice.delta?.content ?? '';
      if (textDelta) {
        if (!hasEmittedReasoningDone && reasoningDelta === '' && textDelta) {
          yield { type: 'reasoning.done' };
          hasEmittedReasoningDone = true;
        }
        yield { type: 'text.delta', delta: textDelta };
      }

      const toolCallDeltas = choice.delta?.toolCalls || choice.delta?.tool_calls || [];
      if (Array.isArray(toolCallDeltas) && toolCallDeltas.length > 0) {
        for (const delta of toolCallDeltas) {
          if (!delta || typeof delta !== 'object') continue;
          const index = Number((delta as any).index ?? 0);
          const existing = toolCallState.get(index) || { id: '', name: '', argumentsRaw: '' };

          const id = (delta as any).id || existing.id;
          const name = (delta as any).function?.name || existing.name;
          const argumentsChunk = (delta as any).function?.arguments || '';
          const next = {
            id,
            name,
            argumentsRaw: existing.argumentsRaw + argumentsChunk,
          };
          toolCallState.set(index, next);

          if (argumentsChunk) {
            yield {
              type: 'tool_call.delta',
              delta: argumentsChunk,
              toolCallId: next.id || `tool_${index}`,
              toolName: next.name || 'unknown',
            };
          }
        }
      }

      const finishReason = choice.finishReason || choice.finish_reason;
      if (finishReason) {
        for (const [index, call] of toolCallState.entries()) {
          if (!call.name) continue;
          yield {
            type: 'tool_call.done',
            toolCallId: call.id || `tool_${index}`,
            toolName: call.name,
            toolCall: {
              id: call.id || `tool_${index}`,
              name: call.name,
              arguments: this.safeParseArguments(call.argumentsRaw),
            },
          };
        }
        yield { type: 'text.done' };
        yield { type: 'done' };
        return;
      }
    }

    for (const [index, call] of toolCallState.entries()) {
      if (!call.name) continue;
      yield {
        type: 'tool_call.done',
        toolCallId: call.id || `tool_${index}`,
        toolName: call.name,
        toolCall: {
          id: call.id || `tool_${index}`,
          name: call.name,
          arguments: this.safeParseArguments(call.argumentsRaw),
        },
      };
    }
    yield { type: 'text.done' };
    yield { type: 'done' };
  }

  /**
   * Build an OpenRouter request object
   * OpenRouter uses OpenAI-compatible format, so mapping is straightforward
   */
  private buildOpenRouterRequest(
    messages: Message[],
    config: ProviderConfig,
    toolRequest?: ProviderToolRequest
  ): any {
    // Convert messages to OpenRouter format, handling file messages
    const openRouterMessages: any[] = [];

    for (let i = 0; i < messages.length; i++) {
      const m = messages[i];
      if (!m) continue;

      if (m.role === 'file') {
        // File messages need to be attached to the previous user message
        // or converted to a user message with content array
        // Find the last user message to attach to, or create a new one
        let lastUserIndex = -1;
        for (let j = openRouterMessages.length - 1; j >= 0; j--) {
          if (openRouterMessages[j]?.role === 'user') {
            lastUserIndex = j;
            break;
          }
        }

        if (lastUserIndex >= 0) {
          // Attach to existing user message
          const userMsg = openRouterMessages[lastUserIndex];
          if (typeof userMsg.content === 'string') {
            // Convert string content to array with text and file
            userMsg.content = [
              { type: 'text', text: userMsg.content },
              ...this.convertFileToOpenRouter(m),
            ];
          } else if (Array.isArray(userMsg.content)) {
            // Add file to existing content array
            userMsg.content.push(...this.convertFileToOpenRouter(m));
          }
        } else {
          // Create new user message with file
          openRouterMessages.push({
            role: 'user',
            content: this.convertFileToOpenRouter(m),
          });
        }
      } else if (m.role === 'tool') {
        openRouterMessages.push({
          role: 'tool',
          content: m.content,
          toolCallId: m.toolCallId,
        });
      } else {
        // Regular message - convert as-is
        const baseMessage: any = {
          role: m.role,
          content: m.content,
        };
        if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0) {
          baseMessage.toolCalls = m.toolCalls.map(call => ({
            id: call.id,
            type: 'function',
            function: {
              name: call.name,
              arguments: JSON.stringify(call.arguments ?? {}),
            },
          }));

          const reasoningText = (m.reasoning || this.extractReasoningTextFromDetails(m.reasoningDetails)).trim();
          if ((config.reasoning ?? 'medium') !== 'off' && reasoningText) {
            // OpenRouter preserves reasoning context across tool steps via
            // message.reasoning. This is required by providers such as Kimi
            // when thinking is enabled and a prior assistant message made
            // tool calls.
            baseMessage.reasoning = reasoningText;
            if (m.reasoningDetails && m.reasoningDetails.length > 0) {
              baseMessage.reasoningDetails = m.reasoningDetails;
              baseMessage.reasoning_details = m.reasoningDetails;
            }
          }
        }
        openRouterMessages.push(baseMessage);
      }
    }

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

    if (toolRequest) {
      request.tools = toolRequest.tools;
      if (toolRequest.toolChoice) {
        request.toolChoice = toolRequest.toolChoice;
      }
    }

    // Remove undefined values to keep request clean
    Object.keys(request).forEach(key => {
      if (request[key] === undefined) {
        delete request[key];
      }
    });

    return request;
  }

  private ensureSupportedModel(model: string): void {
    if (String(model || '').startsWith('openai-codex/')) {
      throw new OAuthOnlyModelSelectedViaApiProviderError();
    }
  }

  /**
   * Convert a file message to OpenRouter content format
   * Returns an array of content items (can be multiple items for some file types)
   */
  private convertFileToOpenRouter(message: Message): any[] {
    if (message.role !== 'file' || !message.filename) {
      return [];
    }

    const filename = message.filename;
    const base64Content = message.content;

    // Detect MIME type from filename
    const mimeType = lookup(filename) || 'application/octet-stream';

    // Determine content type based on MIME type
    if (mimeType.startsWith('image/')) {
      // Images: use image_url content type
      const dataUri = `data:${mimeType};base64,${base64Content}`;
      return [{ type: 'image_url', imageUrl: { url: dataUri } }];
    } else if (mimeType.startsWith('video/')) {
      // Videos: use video_url content type
      const dataUri = `data:${mimeType};base64,${base64Content}`;
      return [{ type: 'video_url', videoUrl: { url: dataUri } }];
    } else if (
      mimeType.startsWith('text/') ||
      mimeType === 'application/javascript' ||
      mimeType === 'application/json' ||
      mimeType === 'application/x-typescript' ||
      filename.endsWith('.ts') ||
      filename.endsWith('.tsx') ||
      filename.endsWith('.js') ||
      filename.endsWith('.jsx') ||
      filename.endsWith('.html') ||
      filename.endsWith('.css') ||
      filename.endsWith('.md')
    ) {
      // Text-like files: embed as text with [obs] tags per user request
      // We need to decode base64 to text
      try {
        const textContent = Buffer.from(base64Content, 'base64').toString('utf-8');
        return [{
          type: 'text',
          text: `<obs>\n${filename}:\n${textContent}\n</obs>`
        }];
      } catch (e) {
        console.error(`Failed to decode text file ${filename}:`, e);
        // Fallback to file type if decoding fails
        const dataUri = `data:${mimeType};base64,${base64Content}`;
        return [{ type: 'file', file: { filename, fileData: dataUri } }];
      }
    } else {
      // PDFs and other files: use file content type
      const dataUri = `data:${mimeType};base64,${base64Content}`;
      return [{ type: 'file', file: { filename, fileData: dataUri } }];
    }
  }

  /**
   * Map TELOS's unified reasoning levels to OpenRouter's ReasoningConfig.
   *
   * TELOS: off | low | medium (default) | high
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

  private parseToolCalls(message: any): ProviderToolCall[] {
    const raw = message?.toolCalls || message?.tool_calls || [];
    if (!Array.isArray(raw)) return [];

    const out: ProviderToolCall[] = [];
    for (let i = 0; i < raw.length; i++) {
      const call = raw[i];
      if (!call || typeof call !== 'object') continue;
      const id = call.id || `tool_${i}`;
      const name = call.function?.name;
      const rawArgs = call.function?.arguments;
      if (!name) continue;
      out.push({
        id,
        name,
        arguments: this.safeParseArguments(rawArgs),
      });
    }
    return out;
  }

  private extractReasoning(choice: any): { text: string; details?: unknown[] } {
    const message = choice?.message || {};
    const details = Array.isArray(choice?.reasoningDetails)
      ? choice.reasoningDetails
      : Array.isArray(choice?.reasoning_details)
        ? choice.reasoning_details
        : Array.isArray(message?.reasoningDetails)
          ? message.reasoningDetails
          : Array.isArray(message?.reasoning_details)
            ? message.reasoning_details
            : undefined;

    const direct = message?.reasoning_content
      ?? message?.reasoning
      ?? choice?.reasoning_content
      ?? choice?.reasoning;
    const text = typeof direct === 'string' && direct.trim()
      ? direct
      : this.extractReasoningTextFromDetails(details);

    return {
      text: text || '',
      details,
    };
  }

  private extractReasoningTextFromDetails(details: unknown): string {
    if (!Array.isArray(details)) {
      return '';
    }

    return details
      .map(detail => {
        if (!detail || typeof detail !== 'object') {
          return '';
        }
        const item = detail as Record<string, unknown>;
        const type = String(item.type || '');
        if (type === 'reasoning.text' && typeof item.text === 'string') {
          return item.text;
        }
        if (type === 'reasoning.summary' && typeof item.summary === 'string') {
          return item.summary;
        }
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }

  private safeParseArguments(rawArgs: unknown): Record<string, unknown> {
    if (rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs)) {
      return rawArgs as Record<string, unknown>;
    }
    if (typeof rawArgs !== 'string' || !rawArgs.trim()) {
      return {};
    }
    try {
      const parsed = JSON.parse(rawArgs);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
      return { value: parsed };
    } catch {
      return { content: rawArgs };
    }
  }

  private async sendWithEmptyChoiceRetry(request: any): Promise<any> {
    let lastResponse: any;

    for (let attempt = 0; attempt <= EMPTY_CHOICES_RETRY_DELAYS_MS.length; attempt++) {
      const response = await this.sendChatRequestWithRetry(request, 'complete');
      lastResponse = response;

      if (this.getPrimaryChoice(response)) {
        return response;
      }

      if (attempt < EMPTY_CHOICES_RETRY_DELAYS_MS.length) {
        const delay = EMPTY_CHOICES_RETRY_DELAYS_MS[attempt];
        if (typeof delay === 'number' && delay > 0) {
          await this.sleep(delay);
        }
      }
    }

    throw new Error(`No response choices returned from OpenRouter (${this.summarizeUnexpectedResponse(lastResponse)})`);
  }

  private async sendWithMissingReasoningFallback(
    messages: Message[],
    config: ProviderConfig,
    toolRequest: ProviderToolRequest | undefined,
    request: any
  ): Promise<any> {
    try {
      return await this.sendWithEmptyChoiceRetry(request);
    } catch (error) {
      if (
        (config.reasoning ?? 'medium') === 'off'
        || !this.isMissingReasoningContentError(error)
        || !this.hasAssistantToolCallMissingReasoning(messages)
      ) {
        throw error;
      }

      console.warn(
        '[OpenRouter] Provider rejected replay because older assistant tool-call history is missing reasoning_content; retrying once with reasoning disabled for this request.'
      );
      const fallbackRequest = this.buildOpenRouterRequest(
        messages,
        { ...config, reasoning: 'off' },
        toolRequest
      );
      return this.sendWithEmptyChoiceRetry(fallbackRequest);
    }
  }

  private isMissingReasoningContentError(error: unknown): boolean {
    return /reasoning_content is missing|thinking is enabled/i.test(this.describeError(error));
  }

  private hasAssistantToolCallMissingReasoning(messages: Message[]): boolean {
    return messages.some(message => {
      if (message.role !== 'assistant' || !message.toolCalls || message.toolCalls.length === 0) {
        return false;
      }
      return !message.reasoning?.trim() && !this.extractReasoningTextFromDetails(message.reasoningDetails).trim();
    });
  }

  private getPrimaryChoice(response: any): any | undefined {
    if (!response || typeof response !== 'object') return undefined;
    const choices = (response as any).choices;
    if (!Array.isArray(choices) || choices.length === 0) return undefined;
    return choices[0];
  }

  private getPrimaryChoiceOrThrow(response: any): any {
    const choice = this.getPrimaryChoice(response);
    if (!choice) {
      throw new Error(`No response choices returned from OpenRouter (${this.summarizeUnexpectedResponse(response)})`);
    }
    return choice;
  }

  private extractMessageText(message: any): string {
    const messageContent = message?.content;
    if (typeof messageContent === 'string') return messageContent;
    if (!Array.isArray(messageContent)) return '';

    return messageContent
      .map(item => {
        if (typeof item === 'string') return item;
        if (item && typeof item === 'object' && 'type' in item && item.type === 'text' && 'text' in item) {
          return item.text ?? '';
        }
        return '';
      })
      .join('');
  }

  private summarizeUnexpectedResponse(response: any): string {
    if (!response || typeof response !== 'object') return 'empty response object';
    const id = typeof response.id === 'string' ? response.id : undefined;
    const hasError = Boolean((response as any).error);
    const hasChoicesField = Object.prototype.hasOwnProperty.call(response, 'choices');
    const constructorName = response?.constructor?.name || 'unknown';
    const hasAsyncIterator = typeof response?.[Symbol.asyncIterator] === 'function';
    return [
      id ? `id=${id}` : 'id=unknown',
      `hasChoicesField=${hasChoicesField}`,
      `hasError=${hasError}`,
      `constructor=${constructorName}`,
      `hasAsyncIterator=${hasAsyncIterator}`,
    ].join(', ');
  }

  private async sleep(ms: number): Promise<void> {
    await new Promise(resolve => setTimeout(resolve, ms));
  }

  private async sendChatRequestWithRetry<T>(request: any, label: string): Promise<T> {
    let lastError: unknown;

    for (let attempt = 0; attempt <= OPENROUTER_RETRY_DELAYS_MS.length; attempt++) {
      try {
        return await this.client.chat.send(request) as T;
      } catch (error) {
        lastError = error;
        const retryDelayMs = this.getRetryDelayMs(error, attempt);
        if (retryDelayMs === null) {
          throw error;
        }

        console.warn(
          `[OpenRouter] ${label} transient failure, retrying in ${retryDelayMs}ms: ${this.describeError(error)}`
        );
        await this.sleep(retryDelayMs);
      }
    }

    throw lastError;
  }

  private getRetryDelayMs(error: unknown, attempt: number): number | null {
    const headers = this.getErrorHeaders(error);
    const retryAfterMs = this.getRetryAfterMs(headers?.get?.('retry-after'));
    if (retryAfterMs !== null) {
      return retryAfterMs;
    }

    const statusCode = this.getErrorStatusCode(error);
    const message = this.describeError(error);
    const isRetryableStatus = statusCode === 408
      || statusCode === 409
      || statusCode === 425
      || statusCode === 429
      || statusCode === 500
      || statusCode === 502
      || statusCode === 503
      || statusCode === 504;
    const isRetryableMessage = /rate.?limit|retry shortly|temporarily unavailable|temporarily rate-limited|timed out|timeout|fetch failed|network|socket|ECONNRESET|ECONNREFUSED|ETIMEDOUT/i.test(message);

    if ((!isRetryableStatus && !isRetryableMessage) || attempt >= OPENROUTER_RETRY_DELAYS_MS.length) {
      return null;
    }

    return OPENROUTER_RETRY_DELAYS_MS[attempt] ?? null;
  }

  private getErrorStatusCode(error: unknown): number | null {
    const value = (error as any)?.statusCode
      ?? (error as any)?.status
      ?? (error as any)?.error?.code
      ?? (error as any)?.data$?.error?.code
      ?? (error as any)?.rawResponse?.status;
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
  }

  private getErrorHeaders(error: unknown): Headers | null {
    const headers = (error as any)?.headers ?? (error as any)?.rawResponse?.headers;
    return headers instanceof Headers ? headers : null;
  }

  private getRetryAfterMs(value: string | null | undefined): number | null {
    if (!value) {
      return null;
    }

    const numericSeconds = Number(value);
    if (Number.isFinite(numericSeconds) && numericSeconds > 0) {
      return numericSeconds * 1000;
    }

    const dateMs = Date.parse(value);
    if (Number.isFinite(dateMs)) {
      return Math.max(0, dateMs - Date.now());
    }

    return null;
  }

  private describeError(error: unknown): string {
    if (error instanceof Error && error.message.trim()) {
      return error.message;
    }
    if (typeof error === 'string' && error.trim()) {
      return error.trim();
    }

    const body = (error as any)?.body ?? (error as any)?.data$?.body$;
    if (typeof body === 'string' && body.trim()) {
      return body.trim();
    }

    const fallback = this.getErrorStatusCode(error);
    return fallback ? `HTTP ${fallback}` : 'Unknown OpenRouter error';
  }
}

// Register the provider
registerProvider('openrouter', () => new OpenRouterProvider());

export default OpenRouterProvider;
