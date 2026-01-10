/**
 * Gemini Provider
 * 
 * Maps universal OpenAI-style parameters to Google's GenAI SDK format.
 */

import { GoogleGenAI } from '@google/genai';
import { BaseProvider, registerProvider } from './base.js';
import type { Message, ProviderConfig, ProviderResponse, ProviderStreamChunk, ProviderStreamEvent } from '../types/index.js';

/**
 * Role mapping from OpenAI format to Gemini format
 */
const ROLE_MAP: Record<string, string> = {
  user: 'user',
  assistant: 'model',
};

export class GeminiProvider extends BaseProvider {
  name = 'gemini';
  private ai: GoogleGenAI;
  
  constructor(apiKey?: string) {
    super();
    const key = apiKey || process.env['GEMINI_API_KEY'];
    if (!key) {
      throw new Error('GEMINI_API_KEY is required. Set it in environment or pass to constructor.');
    }
    this.ai = new GoogleGenAI({ apiKey: key });
  }
  
  /**
   * Build the actual GenAI request object (public for debugging)
   */
  override buildRequest(messages: Message[], config: ProviderConfig): any {
    this.validateConfig(config);
    const cfg = this.withDefaults(config);
    
    // Extract system message if present
    const systemMessage = messages.find(m => m.role === 'system');
    const chatMessages = messages.filter(m => m.role !== 'system');
    
    return this.buildGenAIRequest(chatMessages, systemMessage?.content, {
      ...cfg,
      ...config,
      // Default reasoning to 'medium' per spec
      reasoning: config.reasoning ?? 'medium',
    });
  }

  override async complete(messages: Message[], config: ProviderConfig): Promise<ProviderResponse> {
    this.validateConfig(config);
    const cfg = this.withDefaults(config);
    
    // Extract system message if present
    const systemMessage = messages.find(m => m.role === 'system');
    const chatMessages = messages.filter(m => m.role !== 'system');
    
    const req = this.buildGenAIRequest(chatMessages, systemMessage?.content, {
      ...cfg,
      ...config,
      // Default reasoning to 'medium' per spec
      reasoning: config.reasoning ?? 'medium',
    });

    const response: any = await this.ai.models.generateContent(req);
    const text = this.extractText(response);
    const finishReason = this.mapFinishReason(response?.candidates?.[0]?.finishReason);
    
    return {
      content: text,
      finishReason,
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
   * Industry-standard streaming with reasoning support using Gemini's includeThoughts.
   */
  override async *streamEvents(messages: Message[], config: ProviderConfig): AsyncIterable<ProviderStreamEvent> {
    this.validateConfig(config);
    const cfg = this.withDefaults(config);

    const systemMessage = messages.find(m => m.role === 'system');
    const chatMessages = messages.filter(m => m.role !== 'system');

    const req = this.buildGenAIRequest(chatMessages, systemMessage?.content, {
      ...cfg,
      ...config,
      reasoning: config.reasoning ?? 'medium',
      stream: true,
    });

    // Enable includeThoughts for reasoning streaming
    if (req.config?.thinkingConfig) {
      req.config.thinkingConfig.includeThoughts = true;
    }

    // GenAI streaming API
    const stream: AsyncGenerator<any> = await this.ai.models.generateContentStream(req);
    
    let prevThought = '';
    let prevText = '';
    let hadReasoning = false;
    
    for await (const chunk of stream) {
      // Extract parts from chunk
      const parts = chunk?.candidates?.[0]?.content?.parts;
      if (!Array.isArray(parts)) continue;

      for (const part of parts) {
        if (!part?.text) continue;
        
        if (part.thought) {
          // This is reasoning content
          hadReasoning = true;
          const fullThought = part.text;
          const delta = fullThought.startsWith(prevThought) 
            ? fullThought.slice(prevThought.length) 
            : fullThought;
          prevThought = fullThought;
          
          if (delta) {
            yield { type: 'reasoning.delta', delta };
          }
        } else {
          // This is regular text content
          if (hadReasoning && prevThought) {
            // Reasoning just finished, emit reasoning.done
            yield { type: 'reasoning.done' };
            hadReasoning = false;
          }
          
          const fullText = part.text;
          const delta = fullText.startsWith(prevText)
            ? fullText.slice(prevText.length)
            : fullText;
          prevText = fullText;
          
          if (delta) {
            yield { type: 'text.delta', delta };
          }
        }
      }
    }
    
    // Emit final events
    if (hadReasoning) {
      yield { type: 'reasoning.done' };
    }
    yield { type: 'text.done' };
    yield { type: 'done' };
  }
  
  /**
   * Build a GenAI request object (kept as `any` to allow SDK evolution without forcing
   * the whole framework to chase types).
   */
  private buildGenAIRequest(
    messages: Message[],
    systemPrompt: string | undefined,
    config: ProviderConfig
  ): any {
    const contents = messages.map(m => ({
      role: ROLE_MAP[m.role] || 'user',
      parts: [{ text: m.content }],
    }));

    const genaiConfig: any = {
      temperature: config.temperature,
      maxOutputTokens: config.maxTokens,
      stopSequences: config.stopSequences,
      topP: config.top_p,
      topK: config.top_k,
      seed: config.seed,
      frequencyPenalty: config.frequency_penalty,
      presencePenalty: config.presence_penalty,
    };

    // Set system instruction via config.systemInstruction (GenAI SDK standard)
    if (systemPrompt && systemPrompt.trim()) {
      genaiConfig.systemInstruction = systemPrompt;
    }

    // Optional repetition penalty (if supported by SDK; ignored otherwise)
    if (typeof config.repetition_penalty === 'number') {
      genaiConfig.repetitionPenalty = config.repetition_penalty;
    }

    // Thinking / reasoning mapping
    const thinkingConfig = this.mapReasoning(config.model, config.reasoning ?? 'medium');
    if (thinkingConfig) {
      genaiConfig.thinkingConfig = thinkingConfig;
    }

    const req: any = {
      model: config.model,
      contents,
      config: genaiConfig,
    };

    return req;
  }

  private mapReasoning(model: string, reasoning: NonNullable<ProviderConfig['reasoning']>): any {
    const m = model.toLowerCase();

    // Gemini 3 models use thinkingLevel
    if (m.includes('gemini-3')) {
      let level: string;
      if (m.includes('gemini-3-flash')) {
        // flash: low/medium/high behave similarly, off maps to minimal
        level = reasoning === 'off' ? 'minimal' : reasoning;
      } else if (m.includes('gemini-3-pro')) {
        // pro: 'off' and 'medium' not supported; default is 'high'
        level = (reasoning === 'off' || reasoning === 'medium') ? 'high' : reasoning;
      } else {
        // fallback for unknown gemini-3 variants
        level = reasoning === 'off' ? 'minimal' : reasoning;
      }

      if (!['minimal', 'low', 'medium', 'high'].includes(level)) {
        level = 'medium';
      }

      return { thinkingLevel: level };
    }

    // Other models use thinkingBudget
    let budget: number;
    switch (reasoning) {
      case 'off':
        budget = 0;
        break;
      case 'low':
        budget = 2048;
        break;
      case 'medium':
        // recommended: dynamic thinking
        budget = -1;
        break;
      case 'high':
      default:
        budget = 24576;
        break;
    }

    // gemini-2.5-pro cannot disable thinking; minimum is 128
    if (m.includes('gemini-2.5-pro')) {
      if (budget === 0) budget = 128;
      if (budget > 0 && budget < 128) budget = 128;
    }

    return { thinkingBudget: budget };
  }

  private extractText(responseOrChunk: any): string {
    try {
      if (!responseOrChunk) return '';
      if (typeof responseOrChunk.text === 'function') return String(responseOrChunk.text() ?? '');
      if (typeof responseOrChunk.text === 'string') return responseOrChunk.text;
      if (typeof responseOrChunk.text === 'undefined' && typeof responseOrChunk?.text !== 'undefined') {
        // defensive
      }
      // Common candidate-based shapes
      const parts = responseOrChunk.candidates?.[0]?.content?.parts;
      if (Array.isArray(parts)) {
        return parts.map((p: any) => p?.text ?? '').join('');
      }
      const out = responseOrChunk.outputText;
      if (typeof out === 'string') return out;
      return '';
    } catch {
      return '';
    }
  }

  private mapFinishReason(reason: string | undefined): ProviderResponse['finishReason'] {
    switch (String(reason ?? '').toUpperCase()) {
      case 'STOP':
        return 'stop';
      case 'MAX_TOKENS':
        return 'length';
      case 'SAFETY':
      case 'RECITATION':
        return 'content_filter';
      case 'STOP_SEQUENCE':
        return 'stop_sequence';
      default:
        return 'other';
    }
  }
}

// Register the provider
registerProvider('gemini', () => new GeminiProvider());

export default GeminiProvider;
