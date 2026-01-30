import OpenAI from 'openai';
import { BaseProvider } from './base.js';
import { createRetryHandler } from '../utils/retry.js';
import chalk from 'chalk';

/**
 * OpenRouter provider implementation using OpenAI-compatible SDK
 */
export class OpenRouterProvider extends BaseProvider {
  constructor(apiKey, model, logger = null, customParams = {}) {
    super(apiKey, model);
    this.apiKey = apiKey; // used for Activity API cost lookup (streaming)
    this.logger = logger;
    this.customParams = customParams || {};
    this.retryHandler = createRetryHandler();

    // Initialize OpenAI client with OpenRouter configuration
    this.client = new OpenAI({
      baseURL: 'https://openrouter.ai/api/v1',
      apiKey,
    });
  }

  /**
   * Check if the current model requires explicit cache_control breakpoints.
   * - Anthropic Claude: requires explicit cache_control
   * - Google Gemini: supports cache_control (uses last breakpoint)
   * - DeepSeek, Grok, OpenAI: automatic caching, no cache_control needed
   */
  requiresExplicitCacheControl() {
    const modelLower = this.model.toLowerCase();
    // Anthropic models
    if (modelLower.includes('anthropic/') || modelLower.includes('claude')) {
      return true;
    }
    // Gemini models
    if (modelLower.includes('google/gemini') || modelLower.includes('gemini')) {
      return true;
    }
    return false;
  }

  log(message) {
    if (this.logger) {
      this.logger(message, 'provider');
    }
  }

  async chat(messages, options = {}) {
    const {
      temperature = 0.7,
      systemPrompt = '',
      onChunk = null,
      onReasoning = null,
      stopSequences = [],
      attachments = [],
      onUsage = null
    } = options;

    return await this.retryHandler.executeWithRetry(async () => {
      const formattedMessages = this.formatMessages(messages, systemPrompt, attachments);

      const requestParams = {
        model: this.model,
        messages: formattedMessages,
        temperature,
        stream: !!onChunk,
        // Enable OpenRouter usage/cost accounting
        usage: { include: true },
        // Only pass server-side stop sequences when not streaming; for streaming we handle stops client-side
        ...(stopSequences.length > 0 && !onChunk && { stop: stopSequences }),
        // Merge custom parameters
        ...this.customParams
      };

      if (onChunk) {
        return await this.streamChat(requestParams, onChunk, onReasoning, stopSequences, onUsage);
      } else {
        return await this.nonStreamChat(requestParams, onUsage);
      }
    }, 'OpenRouter API call');
  }

  formatMessages(messages, systemPrompt, attachments = []) {
    const formatted = [];

    if (systemPrompt) {
      // For Anthropic/Gemini: use multipart format with cache_control
      // For DeepSeek/Grok/OpenAI: simple string format (automatic caching)
      if (this.requiresExplicitCacheControl()) {
        formatted.push({
          role: 'system',
          content: [
            {
              type: 'text',
              text: systemPrompt,
              cache_control: { type: 'ephemeral' }
            }
          ]
        });
      } else {
        formatted.push({ role: 'system', content: systemPrompt });
      }
    }

    for (const msg of messages) {
      // Skip messages with no content unless they have attachments (last user message)
      const isLast = msg === messages[messages.length - 1];
      const hasAttachments = isLast && attachments && attachments.length > 0;

      if ((!msg.content || msg.content.trim() === '') && !hasAttachments) continue;

      if (msg.role === 'system') continue;

      // Standard text message
      if (!hasAttachments) {
        formatted.push({
          role: msg.role,
          content: msg.content
        });
        continue;
      }

      // Last user message with attachments
      if (isLast && msg.role === 'user' && hasAttachments) {
        const contentParts = [];

        // Add text content
        if (msg.content) {
          contentParts.push({ type: 'text', text: msg.content });
        }

        // Add attachments
        for (const att of attachments) {
          // Handle Text Files: Append to text content
          if (att.type.startsWith('text/') ||
              att.type === 'application/json' ||
              att.type === 'application/javascript' ||
              att.name.endsWith('.js') ||
              att.name.endsWith('.ts') ||
              att.name.endsWith('.py') ||
              att.name.endsWith('.md') ||
              att.name.endsWith('.txt')) {

            try {
              const base64 = att.dataUrl.split(',')[1];
              const textContent = Buffer.from(base64, 'base64').toString('utf-8');
              // Add as a separate text block or append to previous?
              // OpenAI API supports multiple text blocks, let's use that.
              contentParts.push({ type: 'text', text: `\n\n--- Attached File: ${att.name} ---\n${textContent}\n--- End of File ---\n` });
            } catch (e) {
              console.error(`Failed to decode text attachment ${att.name} for OpenRouter:`, e);
            }
          }
          // Handle Images: use image_url
          else if (att.type.startsWith('image/')) {
             contentParts.push({
               type: 'image_url',
               image_url: {
                 url: att.dataUrl // OpenRouter supports data URI
               }
             });
          }
          // Other types (PDF, Video, Audio) - OpenRouter support varies.
          // Usually not supported via standard chat/completions unless explicitly multimodal model.
          // For now, we skip or maybe append a "not supported" text note?
          // Let's try to append a note.
          else {
             console.warn(`Attachment type ${att.type} (${att.name}) might not be supported by OpenRouter standard API`);
             // Optional: Try to treat as text if we think it might be? No, binary is dangerous.
          }
        }

        formatted.push({
          role: msg.role,
          content: contentParts
        });
      } else {
        formatted.push({
          role: msg.role,
          content: msg.content
        });
      }
    }

    return formatted;
  }

  async nonStreamChat(requestParams, onUsage = null) {
    const response = await this.client.chat.completions.create(requestParams);

    const usage = response?.usage;
    console.log('[openrouter] non-stream usage:', usage);
    
    // Log cache statistics if available
    this.logCacheStats(usage);
    
    const cost = usage?.cost;
    if (onUsage && typeof onUsage === 'function') {
      try {
        onUsage({ usage, cost });
      } catch {
        // ignore usage callback errors
      }
    }

    return response.choices[0].message.content;
  }

  /**
   * Log prompt caching statistics from usage data.
   * Fields available from OpenRouter:
   * - cache_creation_input_tokens: tokens written to cache (cache write)
   * - cache_read_input_tokens: tokens read from cache (cache hit)
   */
  logCacheStats(usage) {
    if (!usage) return;

    const cacheWrite = usage.cache_creation_input_tokens;
    const cacheRead = usage.cache_read_input_tokens;

    if (cacheWrite || cacheRead) {
      const parts = [];
      if (cacheWrite) parts.push(`write=${cacheWrite}`);
      if (cacheRead) parts.push(chalk.green(`hit=${cacheRead}`));
      console.log(`[openrouter] ${chalk.cyan('cache')}: ${parts.join(', ')}`);
    }
  }

  /**
   * Fetch cost from OpenRouter Activity API by generation_id.
   * Activity may lag; we retry with backoff.
   *
   * API: GET https://openrouter.ai/api/v1/activity (Authorization: Bearer <key>)
   */
  async fetchCostFromActivity(generationId, { maxRetries = 6, delaysMs = [300, 600, 1000, 1500, 2500] } = {}) {
    if (!generationId || !this.apiKey) return null;

    const url = 'https://openrouter.ai/api/v1/generation?id=' + generationId;
    const retries = Math.max(1, Number(maxRetries) || 1);

    for (let attempt = 0; attempt < retries; attempt++) {
      try {
        if (attempt > 0) {
          const delay = delaysMs[Math.min(attempt - 1, delaysMs.length - 1)] || 1000;
          console.log(`[openrouter][activity] retry ${attempt}/${retries - 1} in ${delay}ms for ${generationId}`);
          await new Promise(resolve => setTimeout(resolve, delay));
        } else {
          console.log(`[openrouter][activity] fetching cost for ${generationId}`);
        }

        const res = await fetch(url, {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            Accept: 'application/json'
          }
        });

        if (!res.ok) {
          console.log(`[openrouter][activity] http ${res.status} ${res.statusText}`);
          continue;
        }

        const data = await res.json();
        console.log(data.data)
        console.log(data)

        const cost = data.data.total_cost;
        const costNum = typeof cost === 'number' ? cost : Number(cost);
        const usage = {
          prompt_tokens: data.data.tokens_prompt,
          completion_tokens: data.data.tokens_completion,
          total_tokens: data.data.tokens_prompt + data.data.tokens_completion
        };

        if (Number.isFinite(costNum)) {
          console.log(`[openrouter][activity] found cost=${costNum} for ${generationId}`);
          return { cost: costNum, usage };
        }

        console.log(`[openrouter][activity] entry found but cost missing for ${generationId}`);
        return { cost: null, usage };
      } catch (err) {
        console.log(`[openrouter][activity] error: ${err?.message || String(err)}`);
      }
    }

    console.log(`[openrouter][activity] gave up after ${retries} attempt(s) for ${generationId}`);
    return null;
  }

  async streamChat(requestParams, onChunk, onReasoning = null, stopSequences = [], onUsage = null) {
    const stream = await this.client.chat.completions.create(requestParams);

    let fullContent = '';
    let fullReasoning = '';
    let stopped = false;
    let sentLength = 0; // track how many characters we've emitted to onChunk
    let sentReasoningLength = 0; // track reasoning characters emitted
    let lastUsage = null;
    let generationId = null;
    let firstChunk = true;

    console.log('[openrouter] stream started');

    try {
      for await (const chunk of stream) {
        if (stopped) break;

        // OpenRouter streams expose generation id on chunk.id (example: gen-...)
        if (firstChunk) {
          firstChunk = false;
          if (chunk?.id) {
            generationId = chunk.id;
            console.log('[openrouter] generation_id:', generationId);
          } else {
            console.log('[openrouter] first chunk has no id');
          }
        }

        const content = chunk.choices[0]?.delta?.content;
        const reasoning = chunk.choices[0]?.delta?.reasoning;
        if (chunk.usage) {
          lastUsage = chunk.usage;
          console.log('[openrouter] stream chunk usage:', chunk.usage);
          this.logCacheStats(chunk.usage);
        }

        // Handle reasoning/chain-of-thought from models that support it
        if (reasoning && onReasoning) {
          fullReasoning += reasoning;
          const toSendReasoning = fullReasoning.substring(sentReasoningLength);
          if (toSendReasoning) onReasoning(toSendReasoning);
          sentReasoningLength += toSendReasoning.length;
        }

        if (content) {
          fullContent += content;

          // Check if we hit any stop sequence
          if (stopSequences.length > 0) {
            for (const stopSeq of stopSequences) {
              if (fullContent.includes(stopSeq)) {
                // Include the stop sequence itself to preserve a closed tag
                const cutIndex = fullContent.indexOf(stopSeq) + stopSeq.length;
                const toSend = fullContent.substring(sentLength, cutIndex);
                if (toSend) onChunk(toSend);
                sentLength += toSend.length;

                stopped = true;
                fullContent = fullContent.substring(0, cutIndex);
                break;
              }
            }
          }

          // Only send the chunk if we haven't stopped
          if (!stopped) {
            // Send only the portion we haven't emitted yet (handles chunk replay/aggregation)
            const toSend = fullContent.substring(sentLength);
            if (toSend) onChunk(toSend);
            sentLength += toSend.length;
          }
        }

        // Check finish reason
        if (chunk.choices[0]?.finish_reason) {
          break;
        }
      }
    } catch (error) {
      // Stream might be aborted, that's ok if we stopped intentionally
      if (!stopped) {
        throw error;
      }
    }

    // Best-effort: OpenAI SDK streams sometimes provide a helper to get the final completion (with usage)
    if (!lastUsage && stream && typeof stream.finalChatCompletion === 'function') {
      try {
        const final = await stream.finalChatCompletion();
        if (final?.usage) lastUsage = final.usage;
      } catch {
        // ignore
      }
    }

    // Money tracking: separate request to Activity API for 100% accurate cost in streaming mode.
    if (onUsage && typeof onUsage === 'function' && generationId) {
      try {
        const timeoutMs = 10_000;
        const activity = await Promise.race([
          this.fetchCostFromActivity(generationId),
          new Promise((_, reject) => setTimeout(() => reject(new Error('Activity API timeout')), timeoutMs))
        ]);

        if (activity && activity.cost !== null && activity.cost !== undefined) {
          onUsage({ usage: activity.usage, cost: activity.cost });
        } else {
          console.log('[openrouter] activity missing cost, falling back to stream final usage.cost if any');
          onUsage({ usage: lastUsage, cost: lastUsage?.cost });
        }
      } catch (err) {
        console.log(`[openrouter] activity lookup failed: ${err?.message || String(err)}; fallback to stream final usage.cost`);
        try {
          onUsage({ usage: lastUsage, cost: lastUsage?.cost });
        } catch {
          // ignore
        }
      }
    } else if (onUsage && typeof onUsage === 'function') {
      // No generationId; fallback
      console.log('[openrouter] no generation_id, falling back to stream final usage.cost if any');
      try {
        onUsage({ usage: lastUsage, cost: lastUsage?.cost });
      } catch {
        // ignore
      }
    }

    return fullContent;
  }
}
