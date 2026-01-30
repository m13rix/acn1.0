import { GoogleGenAI } from '@google/genai';
import { BaseProvider } from './base.js';
import { createRetryHandler } from '../utils/retry.js';

/**
 * Google Gemini provider implementation using new @google/genai SDK
 */
export class GeminiProvider extends BaseProvider {
  constructor(apiKey, model, logger = null, customParams = {}) {
    super(apiKey, model);
    this.logger = logger;
    this.customParams = customParams || {};
    this.retryHandler = createRetryHandler();
    
    // File Search Store names (для экспериментальной функции)
    this.fileSearchStoreNames = null;

    // Initialize new GenAI client
    this.client = new GoogleGenAI({
      apiKey: apiKey
    });
  }

  /**
   * Устанавливает имена File Search Store для использования в запросах
   * @param {string[]} storeNames - Массив имён store
   */
  setFileSearchStoreNames(storeNames) {
    this.fileSearchStoreNames = storeNames;
    this.log(`File Search enabled with stores: ${storeNames.join(', ')}`);
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
      attachments = []
    } = options;

    return await this.retryHandler.executeWithRetry(async () => {
      // Convert messages to Gemini format
      const geminiMessages = this.convertToGeminiFormat(messages, systemPrompt, attachments);

      // Generation config with custom parameters
      const generationConfig = {
        temperature,
        // Only pass stopSequences when not streaming; for streaming we enforce stops client-side
        ...(stopSequences.length > 0 && !onChunk && { stopSequences }),
        // Merge custom parameters
        ...this.customParams
      };

      // Enable thinking config for models that support it (like gemini-2.5-pro)
      const configWithThinking = {
        ...generationConfig,
        thinkingConfig: onReasoning ? { includeThoughts: true } : undefined
      };

      if (onChunk) {
        return await this.streamChat(geminiMessages, configWithThinking, onChunk, onReasoning, stopSequences);
      } else {
        return await this.nonStreamChat(geminiMessages, configWithThinking);
      }
    }, 'Gemini API call');
  }

  convertToGeminiFormat(messages, systemPrompt, attachments = []) {
    console.log("TEST")
    // Build contents array for Gemini API
    const contents = [];

    for (const msg of messages) {
      // Skip empty messages (except when it is the last user message with attachments)
      const isLast = msg === messages[messages.length - 1];
      const hasAttachments = isLast && attachments && attachments.length > 0;
      console.log(hasAttachments)

      if ((!msg.content || msg.content.trim() === '') && !hasAttachments) continue;

      // Skip system messages (we'll use systemInstruction instead)
      if (msg.role === 'system') continue;

      const parts = [];

      if (msg.content && msg.content.trim() !== '') {
        parts.push({ text: msg.content });
      }

      // Inject attachments for the last user message
      if (isLast && msg.role === 'user' && hasAttachments) {
        for (const att of attachments) {
          console.log(att.type)
          // Handle text files as text parts
          if (att.type.startsWith('text/') ||
              att.type === 'application/json' ||
              att.type === 'application/javascript' ||
              att.name.endsWith('.js') ||
              att.name.endsWith('.ts') ||
              att.name.endsWith('.py') ||
              att.name.endsWith('.md') ||
              att.name.endsWith('.txt')) {

            try {
              console.log("TEXT FILE")
              const base64 = att.dataUrl.split(',')[1];
              const textContent = Buffer.from(base64, 'base64').toString('utf-8');
              parts.push({ text: `\n\n--- Attached File: ${att.name} ---\n${textContent}\n--- End of File ---\n` });
            } catch (e) {
              console.error(`Failed to decode text attachment ${att.name} for Gemini:`, e);
            }
          } else {
            console.log("OTHER FILE")
            // Handle binary files (images, pdf, video, audio) as inlineData
            // Gemini supports: images, audio, video, pdf
            // inlineData requires base64 string (without prefix) and mimeType
            try {
              const base64Data = att.dataUrl.split(',')[1];
              console.log(att.type)
              parts.push({
                inlineData: {
                  mimeType: att.type,
                  data: base64Data
                }
              });
            } catch (e) {
              console.error(`Failed to process binary attachment ${att.name} for Gemini:`, e);
            }
          }
        }
      }

      if (parts.length > 0) {
        contents.push({
          role: msg.role === 'assistant' ? 'model' : 'user',
          parts: parts
        });
      }
    }

    return {
      contents,
      systemInstruction: systemPrompt || undefined
    };
  }

  async nonStreamChat(geminiMessages, generationConfig) {
    // Собираем конфигурацию с опциональным fileSearch
    const config = {
      ...generationConfig,
      systemInstruction: geminiMessages.systemInstruction
    };

    // Добавляем fileSearch tools если они настроены
    if (this.fileSearchStoreNames && this.fileSearchStoreNames.length > 0) {
      config.tools = [
        {
          fileSearch: {
            fileSearchStoreNames: this.fileSearchStoreNames
          }
        }
      ];
    }

    const response = await this.client.models.generateContent({
      model: this.model,
      contents: geminiMessages.contents,
      config
    });

    // Ensure we return a string, even if response.text is undefined
    const text = response?.text || response?.candidates?.[0]?.content?.parts?.[0]?.text || '';

    if (!text) {
      console.error('Gemini response:', JSON.stringify(response, null, 2));
      throw new Error('Gemini API returned empty response');
    }

    return text;
  }

  async streamChat(geminiMessages, generationConfig, onChunk, onReasoning = null, stopSequences = []) {
    // Собираем конфигурацию с опциональным fileSearch
    const config = {
      ...generationConfig,
      systemInstruction: geminiMessages.systemInstruction,
      thinkingConfig: {
        includeThoughts: true,
      }
    };

    // Добавляем fileSearch tools если они настроены
    if (this.fileSearchStoreNames && this.fileSearchStoreNames.length > 0) {
      config.tools = [
        {
          fileSearch: {
            fileSearchStoreNames: this.fileSearchStoreNames
          }
        }
      ];
    }

    const stream = await this.client.models.generateContentStream({
      model: this.model,
      contents: geminiMessages.contents,
      config
    });

    let fullContent = '';
    let fullThoughts = '';
    let stopped = false;
    let sentLength = 0; // track how many characters we've emitted to onChunk
    let sentThoughtsLength = 0; // track thoughts characters emitted

    try {
      for await (const chunk of stream) {
        if (stopped) break;

        // Handle Gemini's thought summaries (for models like gemini-2.5-pro)
        // The response structure has candidates[0].content.parts array
        const parts = chunk.candidates?.[0]?.content?.parts || [];

        for (const part of parts) {
          if (!part.text) continue;

          // Check if this is a thought part
          if (part.thought && onReasoning) {
            fullThoughts += part.text;
            const toSendThoughts = fullThoughts.substring(sentThoughtsLength);
            if (toSendThoughts) onReasoning(toSendThoughts);
            sentThoughtsLength += toSendThoughts.length;
          } else {
            // Regular content
            fullContent += part.text;

            // Manual stop sequence check (in case SDK doesn't handle it in streaming)
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
              const toSend = fullContent.substring(sentLength);
              if (toSend) onChunk(toSend);
              sentLength += toSend.length;
            }
          }
        }

        // Fallback: handle simple chunk.text format if parts structure is not present
        if (parts.length === 0) {
          const chunkText = chunk.text || '';
          if (chunkText) {
            fullContent += chunkText;

            if (stopSequences.length > 0) {
              for (const stopSeq of stopSequences) {
                if (fullContent.includes(stopSeq)) {
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

            if (!stopped) {
              const toSend = fullContent.substring(sentLength);
              if (toSend) onChunk(toSend);
              sentLength += toSend.length;
            }
          }
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
