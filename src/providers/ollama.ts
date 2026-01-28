/**
 * Ollama Provider
 * 
 * Maps universal OpenAI-style parameters to Ollama's API format.
 * Supports streaming, vision, and thinking models (reasoning).
 */

import { Ollama } from 'ollama';
import { BaseProvider, registerProvider } from './base.js';
import type { Message, ProviderConfig, ProviderResponse, ProviderStreamEvent } from '../types/index.js';
// @ts-ignore - mime-types doesn't have perfect TypeScript types
import { lookup } from 'mime-types';

export class OllamaProvider extends BaseProvider {
    name = 'ollama';
    private client: Ollama;

    constructor(host?: string) {
        super();
        // Default to local Ollama host if not provided
        const ollamaHost = host || process.env['OLLAMA_HOST'] || 'http://localhost:11434';
        this.client = new Ollama({ host: ollamaHost });
    }

    /**
     * Build the actual Ollama request object (public for debugging)
     */
    override buildRequest(messages: Message[], config: ProviderConfig): any {
        this.validateConfig(config);
        const cfg = this.withDefaults(config);

        return this.buildOllamaRequest(messages, cfg);
    }

    override async complete(messages: Message[], config: ProviderConfig): Promise<ProviderResponse> {
        this.validateConfig(config);
        const cfg = this.withDefaults(config);

        const request = this.buildOllamaRequest(messages, cfg);

        const response = (await this.client.chat({
            ...request,
            stream: false,
        })) as any;

        const content = response.message.content || '';
        const reasoning = response.message.thinking || '';
        // Ollama chat response doesn't explicitly have finish_reason in the same way OpenAI does, 
        // but we can infer it or use 'stop' as default.
        const finishReason: ProviderResponse['finishReason'] = response.done_reason === 'length' ? 'length' : 'stop';

        return {
            content,
            reasoning,
            finishReason,
            usage: {
                promptTokens: response.prompt_eval_count ?? 0,
                completionTokens: response.eval_count ?? 0,
                totalTokens: (response.prompt_eval_count ?? 0) + (response.eval_count ?? 0),
            },
        };
    }

    /**
     * Industry-standard streaming with reasoning support.
     */
    override async *streamEvents(messages: Message[], config: ProviderConfig): AsyncIterable<ProviderStreamEvent> {
        this.validateConfig(config);
        const cfg = this.withDefaults(config);

        const request = this.buildOllamaRequest(messages, {
            ...cfg,
            stream: true,
        });

        const stream = await this.client.chat({
            ...request,
            stream: true,
        });

        let hasEmittedReasoningDone = false;
        let inThinking = false;

        for await (const chunk of stream) {
            // Handle thinking content (reasoning)
            if (chunk.message.thinking) {
                if (!inThinking) {
                    inThinking = true;
                    // No need to emit reasoning.done here, as it's the start
                }
                yield { type: 'reasoning.delta', delta: chunk.message.thinking };
            }

            // Handle regular text content
            if (chunk.message.content) {
                // If we were in thinking mode and now have content, emit reasoning.done
                if (inThinking) {
                    yield { type: 'reasoning.done' };
                    inThinking = false;
                    hasEmittedReasoningDone = true;
                }
                yield { type: 'text.delta', delta: chunk.message.content };
            }

            // Check if finished
            if (chunk.done) {
                if (inThinking && !hasEmittedReasoningDone) {
                    yield { type: 'reasoning.done' };
                }
                yield { type: 'text.done' };
                yield { type: 'done' };
                return;
            }
        }

        // Fallback if loop ends without done chunk
        if (inThinking && !hasEmittedReasoningDone) {
            yield { type: 'reasoning.done' };
        }
        yield { type: 'text.done' };
        yield { type: 'done' };
    }

    /**
     * Build an Ollama request object
     */
    private buildOllamaRequest(
        messages: Message[],
        config: ProviderConfig
    ): any {
        const ollamaMessages: any[] = [];

        for (const m of messages) {
            if (m.role === 'file' && m.filename) {
                // Attach images to the previous user message or create a new one
                let lastUserMessage = ollamaMessages[ollamaMessages.length - 1];
                if (lastUserMessage && lastUserMessage.role === 'user') {
                    if (!lastUserMessage.images) lastUserMessage.images = [];
                    lastUserMessage.images.push(m.content); // Ollama accepts base64
                } else {
                    ollamaMessages.push({
                        role: 'user',
                        content: '',
                        images: [m.content],
                    });
                }
            } else if (m.role !== 'file') {
                ollamaMessages.push({
                    role: m.role === 'assistant' ? 'assistant' : m.role,
                    content: m.content,
                });
            }
        }

        // Map ACN reasoning effort to Ollama 'think' field
        // Most models accept boolean, GPT-OSS accepts low/medium/high
        let think: any = true;
        if (config.reasoning === 'off') {
            think = false;
        } else if (config.model.toLowerCase().includes('gpt-oss')) {
            think = config.reasoning ?? 'medium';
        }

        const request: any = {
            model: config.model,
            messages: ollamaMessages,
            think: think,
            options: {
                temperature: config.temperature,
                num_predict: config.maxTokens,
                top_p: config.top_p,
                top_k: config.top_k,
                seed: config.seed,
                stop: config.stopSequences && config.stopSequences.length > 0 ? config.stopSequences : undefined,
                presence_penalty: config.presence_penalty,
                frequency_penalty: config.frequency_penalty,
            },
        };

        // Remove undefined options
        if (request.options) {
            Object.keys(request.options).forEach(key => {
                if (request.options[key] === undefined) {
                    delete request.options[key];
                }
            });
        }

        return request;
    }
}

// Register the provider
registerProvider('ollama', () => new OllamaProvider());

export default OllamaProvider;
