/**
 * Ollama Provider
 * 
 * Maps universal OpenAI-style parameters to Ollama's API format.
 * Supports streaming, vision, and thinking models (reasoning).
 */

import { Ollama } from 'ollama';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { BaseProvider, registerProvider } from './base.js';
import { OAuthOnlyModelSelectedViaApiProviderError } from './openai-codex/errors.js';
import type {
    Message,
    ProviderConfig,
    ProviderResponse,
    ProviderStreamEvent,
    ProviderToolCall,
    ProviderToolRequest,
    ProviderToolResponse,
} from '../types/index.js';
// @ts-ignore - mime-types doesn't have perfect TypeScript types
import { lookup } from 'mime-types';

function parsePositiveInteger(value: unknown): number | undefined {
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
        return Math.floor(value);
    }
    if (typeof value === 'string' && value.trim()) {
        const parsed = Number.parseInt(value.trim(), 10);
        if (Number.isFinite(parsed) && parsed > 0) {
            return parsed;
        }
    }
    return undefined;
}

function resolveOllamaOption(config: ProviderConfig, ...keys: string[]): unknown {
    const providerOptions = config.providerOptions || {};
    for (const key of keys) {
        if (providerOptions[key] !== undefined) {
            return providerOptions[key];
        }
    }
    return undefined;
}

function normalizeKeepAlive(value: unknown): string | number | undefined {
    if (typeof value === 'number' && Number.isFinite(value)) {
        return value;
    }
    if (typeof value === 'string' && value.trim()) {
        return value.trim();
    }
    return undefined;
}

export class OllamaProvider extends BaseProvider {
    name = 'ollama';
    private client: Ollama;
    private host: string;

    constructor(host?: string) {
        super();
        // Default to local Ollama host if not provided
        const ollamaHost = host || process.env['OLLAMA_HOST'] || 'http://localhost:11434';
        this.host = ollamaHost;
        this.client = new Ollama({ host: ollamaHost });
    }

    /**
     * Build the actual Ollama request object (public for debugging)
     */
    override buildRequest(messages: Message[], config: ProviderConfig): any {
        this.validateConfig(config);
        this.ensureSupportedModel(config.model);
        const cfg = this.withDefaults(config);

        return this.buildOllamaRequest(messages, cfg);
    }

    override buildRequestWithTools(
        messages: Message[],
        config: ProviderConfig,
        toolRequest: ProviderToolRequest
    ): any {
        this.validateConfig(config);
        this.ensureSupportedModel(config.model);
        const cfg = this.withDefaults(config);
        return this.buildOllamaRequest(messages, cfg, toolRequest);
    }

    override async complete(messages: Message[], config: ProviderConfig): Promise<ProviderResponse> {
        this.validateConfig(config);
        this.ensureSupportedModel(config.model);
        const cfg = this.withDefaults(config);

        const request = this.buildOllamaRequest(messages, cfg);

        const response = (await this.postChat({
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

    override async completeWithTools(
        messages: Message[],
        config: ProviderConfig,
        toolRequest: ProviderToolRequest
    ): Promise<ProviderToolResponse> {
        this.validateConfig(config);
        this.ensureSupportedModel(config.model);
        const cfg = this.withDefaults(config);
        const request = this.buildOllamaRequest(messages, cfg, toolRequest);

        const response = (await this.postChat({
            ...request,
            stream: false,
        })) as any;

        const content = response.message?.content || '';
        const reasoning = response.message?.thinking || '';
        const finishReason: ProviderResponse['finishReason'] = response.done_reason === 'length' ? 'length' : 'stop';
        const toolCalls = this.parseToolCalls(response.message?.tool_calls);

        return {
            content,
            reasoning,
            finishReason,
            toolCalls,
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
        this.ensureSupportedModel(config.model);
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

    override async *streamEventsWithTools(
        messages: Message[],
        config: ProviderConfig,
        toolRequest: ProviderToolRequest
    ): AsyncIterable<ProviderStreamEvent> {
        this.validateConfig(config);
        this.ensureSupportedModel(config.model);
        const cfg = this.withDefaults(config);
        const request = this.buildOllamaRequest(messages, { ...cfg, stream: true }, toolRequest);

        const stream = await this.client.chat({
            ...request,
            stream: true,
        });

        let hasEmittedReasoningDone = false;
        let inThinking = false;
        const toolCallState = new Map<number, { id: string; name: string; argumentsRaw: string }>();

        for await (const chunk of stream) {
            if (chunk.message?.thinking) {
                inThinking = true;
                yield { type: 'reasoning.delta', delta: chunk.message.thinking };
            }

            if (chunk.message?.content) {
                if (inThinking) {
                    yield { type: 'reasoning.done' };
                    inThinking = false;
                    hasEmittedReasoningDone = true;
                }
                yield { type: 'text.delta', delta: chunk.message.content };
            }

            // Ollama streaming chunk usually gives the entire tool call object at once when done
            // or delta. We must handle merging them if it's delta.
            // As of latest ollama, chunk.message.tool_calls contains an array of fully or partially populated objects.
            const rawCalls = chunk.message?.tool_calls;
            if (Array.isArray(rawCalls) && rawCalls.length > 0) {
                for (const raw of rawCalls) {
                    if (!raw || typeof raw !== 'object') continue;
                    // Ollama might not provide 'index', so we auto-assign based on position in map or function name
                    // Since Ollama might just yield the whole tool_calls list at the end of the stream, 
                    // we just parse them directly.
                    const name = raw.function?.name;
                    if (!name) continue;
                    // Hash the name as an index just to keep track, assuming Ollama returns them in full chunks
                    const argsObj = raw.function?.arguments || {};
                    // Convert back to raw string for delta logic if we want, or just yield it as a done call immediately
                    // The simplest is to just yield them as done since Ollama currently bursts tool calls.
                    const index = toolCallState.size;
                    if (!toolCallState.has(index)) {
                        toolCallState.set(index, { id: `tool_${index}`, name, argumentsRaw: '' });
                        yield {
                            type: 'tool_call.done',
                            toolCallId: `tool_${index}`,
                            toolName: name,
                            toolCall: {
                                id: `tool_${index}`,
                                name,
                                arguments: argsObj
                            }
                        };
                    }
                }
            }

            if (chunk.done) {
                if (inThinking && !hasEmittedReasoningDone) {
                    yield { type: 'reasoning.done' };
                }
                yield { type: 'text.done' };
                yield { type: 'done' };
                return;
            }
        }

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
        config: ProviderConfig,
        toolRequest?: ProviderToolRequest
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
            } else if (m.role === 'tool') {
                ollamaMessages.push({
                    role: 'tool',
                    content: m.content,
                    tool_name: m.toolName,
                });
            } else if (m.role !== 'file') {
                const baseMessage: any = {
                    role: m.role === 'assistant' ? 'assistant' : m.role,
                    content: m.content,
                };
                if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0) {
                    baseMessage.tool_calls = m.toolCalls.map((call, index) => ({
                        type: 'function',
                        function: {
                            index: index, // some ollama models expect index
                            name: call.name,
                            arguments: call.arguments,
                        },
                    }));
                }
                ollamaMessages.push(baseMessage);
            }
        }

        // Map TELOS reasoning effort to Ollama 'think' field
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
            tools: toolRequest
                ? toolRequest.tools.map(tool => ({
                    type: 'function',
                    function: {
                        name: tool.function.name,
                        description: tool.function.description,
                        parameters: tool.function.parameters,
                    },
                }))
                : undefined,
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
                num_ctx: parsePositiveInteger(
                    resolveOllamaOption(config, 'num_ctx', 'numCtx') ?? process.env['TELOS_OLLAMA_NUM_CTX']
                ),
            },
        };

        const keepAlive = normalizeKeepAlive(
            resolveOllamaOption(config, 'keep_alive', 'keepAlive') ?? process.env['TELOS_OLLAMA_KEEP_ALIVE']
        );
        if (keepAlive !== undefined) {
            request.keep_alive = keepAlive;
        }

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

    private async postChat(request: any): Promise<any> {
        const url = new URL('/api/chat', this.host);
        const transport = url.protocol === 'https:' ? httpsRequest : httpRequest;
        const body = JSON.stringify(request);

        return new Promise((resolve, reject) => {
            const req = transport(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Accept': 'application/json',
                    'Content-Length': Buffer.byteLength(body),
                },
            }, (res) => {
                let raw = '';
                res.setEncoding('utf8');
                res.on('data', (chunk) => {
                    raw += chunk;
                });
                res.on('end', () => {
                    if ((res.statusCode || 0) >= 400) {
                        let message = `Error ${res.statusCode}: ${res.statusMessage || 'Ollama request failed'}`;
                        try {
                            const parsed = JSON.parse(raw);
                            if (parsed?.error) {
                                message = String(parsed.error);
                            }
                        } catch {
                            if (raw.trim()) {
                                message = raw.trim();
                            }
                        }
                        const error = new Error(message) as Error & { status_code?: number; error?: string };
                        error.name = 'ResponseError';
                        error.status_code = res.statusCode;
                        error.error = message;
                        reject(error);
                        return;
                    }

                    try {
                        resolve(raw.trim() ? JSON.parse(raw) : {});
                    } catch (error) {
                        reject(error);
                    }
                });
            });

            req.on('error', reject);
            req.end(body);
        });
    }

    private parseToolCalls(rawToolCalls: any): ProviderToolCall[] {
        if (!Array.isArray(rawToolCalls)) return [];
        const out: ProviderToolCall[] = [];
        for (let i = 0; i < rawToolCalls.length; i++) {
            const call = rawToolCalls[i];
            if (!call || typeof call !== 'object') continue;
            const name = call.function?.name;
            if (!name) continue;
            const args = call.function?.arguments;
            out.push({
                id: `tool_${i}`,
                name,
                arguments: args && typeof args === 'object' ? args : {},
            });
        }
        return out;
    }

    private ensureSupportedModel(model: string): void {
        if (String(model || '').startsWith('openai-codex/')) {
            throw new OAuthOnlyModelSelectedViaApiProviderError();
        }
    }
}

// Register the provider
registerProvider('ollama', () => new OllamaProvider());

export default OllamaProvider;
