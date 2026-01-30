import OpenAI from 'openai';
import { BaseProvider } from './base.js';
import { createRetryHandler } from '../utils/retry.js';

/**
 * SambaNova provider implementation using OpenAI-compatible SDK
 */
export class SambaNovaProvider extends BaseProvider {
  constructor(apiKey, model, logger = null, customParams = {}) {
    super(apiKey, model);
    this.logger = logger;
    this.customParams = customParams || {};
    this.retryHandler = createRetryHandler();

    // Initialize OpenAI client with SambaNova configuration
    this.client = new OpenAI({
      baseURL: this.customParams.baseURL || 'https://api.sambanova.ai/v1',
      apiKey: this.apiKey,
    });
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
      onReasoning = null, // Not used by SambaNova but accepted for interface compatibility
      stopSequences = [],
      attachments = []
    } = options;

    return await this.retryHandler.executeWithRetry(async () => {
      // Use base formatMessages which handles text attachments
      const formattedMessages = this.formatMessages(messages, systemPrompt, attachments);

      const requestParams = {
        model: this.model,
        messages: formattedMessages,
        temperature,
        stream: !!onChunk,
        // Only pass server-side stop sequences when not streaming; for streaming we handle stops client-side
        ...(stopSequences.length > 0 && !onChunk && { stop: stopSequences }),
        // Merge custom parameters
        ...this.customParams
      };

      if (onChunk) {
        return await this.streamChat(requestParams, onChunk, stopSequences);
      } else {
        return await this.nonStreamChat(requestParams);
      }
    }, 'SambaNova API call');
  }

  async nonStreamChat(requestParams) {
    const response = await this.client.chat.completions.create(requestParams);
    return response.choices[0].message.content;
  }

  async streamChat(requestParams, onChunk, stopSequences = []) {
    const stream = await this.client.chat.completions.create(requestParams);

    let fullContent = '';
    let stopped = false;
    let sentLength = 0; // track how many characters we've emitted to onChunk

    try {
      for await (const chunk of stream) {
        if (stopped) break;

        const content = chunk.choices[0]?.delta?.content;

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

    return fullContent;
  }
}

