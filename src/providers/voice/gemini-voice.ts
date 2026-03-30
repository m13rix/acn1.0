import { GoogleGenAI, Modality } from '@google/genai';
import { BaseVoiceProvider } from './base.js';
import { registerVoiceProvider } from './registry.js';
import type {
  ProviderToolCall,
  ProviderToolDefinition,
  ProviderToolResult,
  VoiceRealtimeInput,
  VoiceSession,
  VoiceSessionConfig,
  VoiceSessionEvent,
} from '../../types/index.js';

function logGeminiVoice(message: string, details?: string): void {
  console.log(`[gemini-voice] ${message}${details ? `: ${details}` : ''}`);
}

class AsyncEventQueue<T> {
  private readonly items: T[] = [];
  private readonly waiters: Array<(value: IteratorResult<T>) => void> = [];
  private closed = false;

  push(item: T): void {
    if (this.closed) {
      return;
    }
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter({ value: item, done: false });
      return;
    }
    this.items.push(item);
  }

  close(): void {
    this.closed = true;
    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift();
      waiter?.({ value: undefined as T, done: true });
    }
  }

  async next(): Promise<IteratorResult<T>> {
    if (this.items.length > 0) {
      return { value: this.items.shift() as T, done: false };
    }

    if (this.closed) {
      return { value: undefined as T, done: true };
    }

    return new Promise<IteratorResult<T>>((resolve) => {
      this.waiters.push(resolve);
    });
  }
}

class GeminiLiveSession implements VoiceSession {
  constructor(
    private readonly session: any,
    private readonly queue: AsyncEventQueue<VoiceSessionEvent>,
  ) {}

  async sendRealtimeInput(input: VoiceRealtimeInput): Promise<void> {
    const parts: string[] = [];
    const payload: Record<string, unknown> = {};
    if (input.audio) {
      const size = typeof input.audio.data === 'string'
        ? Buffer.byteLength(input.audio.data, 'base64')
        : input.audio.data.length;
      parts.push(`audio=${size}b`);
      payload['audio'] = {
        data: this.toBase64(input.audio.data),
        mimeType: input.audio.mimeType,
      };
    }
    if (input.video) {
      const size = typeof input.video.data === 'string'
        ? Buffer.byteLength(input.video.data, 'base64')
        : input.video.data.length;
      parts.push(`video=${size}b`);
      payload['video'] = {
        data: this.toBase64(input.video.data),
        mimeType: input.video.mimeType,
      };
    }
    if (typeof input.text === 'string') {
      parts.push(`text=${input.text.length}c`);
      payload['text'] = input.text;
    }
    if (typeof input.audioStreamEnd === 'boolean') {
      parts.push(`audioStreamEnd=${input.audioStreamEnd}`);
      payload['audioStreamEnd'] = input.audioStreamEnd;
    }
    if (parts.length > 0) {
      logGeminiVoice('sendRealtimeInput', parts.join(', '));
    }
    this.session.sendRealtimeInput(payload);
  }

  async sendTextTurn(turn: { text: string; turnComplete?: boolean }): Promise<void> {
    logGeminiVoice(
      'sendClientContent',
      `chars=${turn.text.length}, turnComplete=${turn.turnComplete ?? true}`,
    );
    this.session.sendClientContent({
      turns: [
        {
          role: 'user',
          parts: [{ text: turn.text }],
        },
      ],
      turnComplete: turn.turnComplete ?? true,
    });
  }

  async sendToolResults(results: ProviderToolResult[]): Promise<void> {
    logGeminiVoice('sendToolResponse', results.map((result) => result.name).join(', ') || 'none');
    this.session.sendToolResponse({
      functionResponses: results.map((result) => ({
        id: result.id,
        name: result.name,
        response: result.response,
      })),
    });
  }

  async *receive(): AsyncIterable<VoiceSessionEvent> {
    while (true) {
      const next = await this.queue.next();
      if (next.done) {
        return;
      }
      yield next.value;
    }
  }

  async close(): Promise<void> {
    this.session.close();
    this.queue.close();
  }

  private toBase64(data: Buffer | string): string {
    if (typeof data === 'string') {
      return data;
    }
    return data.toString('base64');
  }
}

function normalizeToolCalls(functionCalls: Array<any> | undefined): ProviderToolCall[] {
  if (!Array.isArray(functionCalls)) {
    return [];
  }

  return functionCalls.map((call, index) => ({
    id: String(call?.id || `voice-tool-${index + 1}`),
    name: String(call?.name || '').trim(),
    arguments: typeof call?.args === 'object' && call.args
      ? call.args as Record<string, unknown>
      : {},
  }));
}

function buildToolDeclarations(tools: ProviderToolDefinition[] | undefined): Array<{ functionDeclarations: Array<Record<string, unknown>> }> | undefined {
  if (!Array.isArray(tools) || tools.length === 0) {
    return undefined;
  }

  return [
    {
      functionDeclarations: tools.map((tool) => ({
        name: tool.function.name,
        description: tool.function.description,
        parameters: tool.function.parameters,
      })),
    },
  ];
}

export class GeminiVoiceProvider extends BaseVoiceProvider {
  name = 'gemini-voice';
  private readonly ai: GoogleGenAI;

  constructor(apiKey?: string) {
    super();
    const key = apiKey || process.env['GEMINI_KEY'];
    if (!key) {
      throw new Error('GEMINI_KEY is required for gemini-voice.');
    }
    this.ai = new GoogleGenAI({ apiKey: key });
  }

  override buildConnectRequest(config: VoiceSessionConfig): any {
    return this.buildLiveConnectParams(config);
  }

  override async connect(config: VoiceSessionConfig): Promise<VoiceSession> {
    this.validateConfig(config);

    const queue = new AsyncEventQueue<VoiceSessionEvent>();
    const liveConfig = this.buildLiveConnectParams(config);
    logGeminiVoice(
      'Opening Gemini Live session',
      `model=${config.model || 'gemini-3.1-flash-live-preview'}, tools=${config.tools?.length || 0}, reasoning=${config.reasoning || 'medium'}`,
    );

    const session = await this.ai.live.connect({
      ...liveConfig,
      callbacks: {
        onopen: () => {
          logGeminiVoice('WebSocket opened');
          queue.push({ type: 'session.open' });
        },
        onmessage: (message: any) => {
          if (message?.setupComplete) {
            logGeminiVoice('Setup complete', message.setupComplete.sessionId || 'session id unavailable');
            queue.push({ type: 'session.open', sessionId: message.setupComplete.sessionId });
          }

          const content = message?.serverContent;
          if (content?.inputTranscription?.text) {
            queue.push({ type: 'transcript.input', text: String(content.inputTranscription.text) });
          }
          if (content?.outputTranscription?.text) {
            queue.push({ type: 'transcript.output', text: String(content.outputTranscription.text) });
          }
          if (content?.modelTurn?.parts) {
            const audioParts = content.modelTurn.parts.filter((part: any) => part?.inlineData?.data).length;
            if (audioParts > 0) {
              logGeminiVoice('Received model audio parts', String(audioParts));
            }
            for (const part of content.modelTurn.parts) {
              if (part?.inlineData?.data) {
                queue.push({
                  type: 'audio.output',
                  data: part.inlineData.data,
                  mimeType: String(part.inlineData.mimeType || 'audio/pcm;rate=24000'),
                });
              }
            }
          }
          if (content?.waitingForInput) {
            logGeminiVoice('Model waiting for input');
            queue.push({ type: 'turn.waiting_for_input' });
          }
          if (content?.turnComplete) {
            logGeminiVoice('Model turn complete', content.turnCompleteReason || 'no reason');
            queue.push({ type: 'turn.complete', reason: content.turnCompleteReason });
          }
          if (content?.interrupted) {
            logGeminiVoice('Model turn interrupted');
            queue.push({ type: 'turn.interrupted' });
          }
          if (message?.sessionResumptionUpdate) {
            logGeminiVoice(
              'Session resumption update',
              `resumable=${message.sessionResumptionUpdate.resumable}, lastClientIndex=${message.sessionResumptionUpdate.lastConsumedClientMessageIndex ?? 'n/a'}`,
            );
            queue.push({
              type: 'session.resumption',
              handle: message.sessionResumptionUpdate.newHandle,
              resumable: message.sessionResumptionUpdate.resumable,
              lastConsumedClientMessageIndex: message.sessionResumptionUpdate.lastConsumedClientMessageIndex,
            });
          }
          if (message?.toolCall?.functionCalls) {
            logGeminiVoice(
              'Received tool calls',
              normalizeToolCalls(message.toolCall.functionCalls).map((tool) => tool.name).join(', ') || 'unknown',
            );
            queue.push({
              type: 'tool.call',
              toolCalls: normalizeToolCalls(message.toolCall.functionCalls),
            });
          }
          if (message?.toolCallCancellation?.ids) {
            logGeminiVoice(
              'Received tool call cancellation',
              message.toolCallCancellation.ids.map((id: unknown) => String(id)).join(', '),
            );
            queue.push({
              type: 'tool.call.cancel',
              ids: message.toolCallCancellation.ids.map((id: unknown) => String(id)),
            });
          }
        },
        onerror: (event: any) => {
          logGeminiVoice(
            'Gemini Live error',
            event?.error instanceof Error ? event.error.message : event?.message || 'Unknown Gemini Live error',
          );
          queue.push({
            type: 'error',
            error: event?.error instanceof Error ? event.error : new Error(event?.message || 'Unknown Gemini Live error'),
          });
        },
        onclose: () => {
          logGeminiVoice('WebSocket closed');
          queue.push({ type: 'session.close' });
          queue.close();
        },
      },
    });

    return new GeminiLiveSession(session, queue);
  }

  private buildLiveConnectParams(config: VoiceSessionConfig): any {
    const model = config.model || 'gemini-3.1-flash-live-preview';
    const providerOptions = { ...(config.providerOptions || {}) };
    const speechConfig = providerOptions['speechConfig'];
    const inputAudioTranscription = providerOptions['inputAudioTranscription'] ?? {};
    const outputAudioTranscription = providerOptions['outputAudioTranscription'] ?? {};
    const realtimeInputConfig = this.normalizeRealtimeInputConfig(providerOptions['realtimeInputConfig']);
    const sessionResumption = this.normalizeSessionResumption(providerOptions['sessionResumption']);
    const contextWindowCompression = providerOptions['contextWindowCompression'];
    const proactivity = providerOptions['proactivity'];
    const explicitVadSignal = this.normalizeExplicitVadSignal(providerOptions['explicitVadSignal']);
    logGeminiVoice(
      'Prepared live config',
      `model=${model}, speech=${speechConfig ? 'on' : 'off'}, inputTx=${inputAudioTranscription ? 'on' : 'off'}, outputTx=${outputAudioTranscription ? 'on' : 'off'}, vad=${this.describeVadConfig(realtimeInputConfig)}`,
    );

    return {
      model,
      config: {
        responseModalities: [Modality.AUDIO],
        systemInstruction: config.systemInstruction
          ? { parts: [{ text: config.systemInstruction }] }
          : undefined,
        temperature: config.temperature,
        topP: config.top_p,
        topK: config.top_k,
        maxOutputTokens: config.maxTokens,
        seed: config.seed,
        speechConfig: speechConfig as Record<string, unknown> | undefined,
        inputAudioTranscription,
        outputAudioTranscription,
        realtimeInputConfig: realtimeInputConfig as Record<string, unknown> | undefined,
        sessionResumption: sessionResumption as Record<string, unknown> | undefined,
        contextWindowCompression: contextWindowCompression as Record<string, unknown> | undefined,
        proactivity: proactivity as Record<string, unknown> | undefined,
        explicitVadSignal: explicitVadSignal as boolean | undefined,
        tools: buildToolDeclarations(config.tools),
        thinkingConfig: {
          thinkingLevel: this.mapThinkingLevel(config.reasoning || 'medium'),
        },
      },
    };
  }

  private normalizeRealtimeInputConfig(value: unknown): Record<string, unknown> | undefined {
    const defaultAutomaticActivityDetection = {
      disabled: false,
      startOfSpeechSensitivity: 'START_SENSITIVITY_LOW',
      endOfSpeechSensitivity: 'END_SENSITIVITY_LOW',
      prefixPaddingMs: 80,
      silenceDurationMs: 400,
    };

    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return {
        automaticActivityDetection: defaultAutomaticActivityDetection,
      };
    }

    const source = value as Record<string, unknown>;
    const sourceAutomaticActivityDetection =
      source['automaticActivityDetection'] && typeof source['automaticActivityDetection'] === 'object' && !Array.isArray(source['automaticActivityDetection'])
        ? source['automaticActivityDetection'] as Record<string, unknown>
        : {};

    return {
      ...source,
      automaticActivityDetection: {
        ...defaultAutomaticActivityDetection,
        ...sourceAutomaticActivityDetection,
      },
    };
  }

  private describeVadConfig(realtimeInputConfig: Record<string, unknown> | undefined): string {
    const detection =
      realtimeInputConfig?.['automaticActivityDetection']
      && typeof realtimeInputConfig['automaticActivityDetection'] === 'object'
      && !Array.isArray(realtimeInputConfig['automaticActivityDetection'])
        ? realtimeInputConfig['automaticActivityDetection'] as Record<string, unknown>
        : undefined;

    if (!detection) {
      return 'off';
    }

    return [
      `disabled=${String(detection['disabled'] ?? false)}`,
      `start=${String(detection['startOfSpeechSensitivity'] ?? 'default')}`,
      `end=${String(detection['endOfSpeechSensitivity'] ?? 'default')}`,
      `prefix=${String(detection['prefixPaddingMs'] ?? 'default')}`,
      `silence=${String(detection['silenceDurationMs'] ?? 'default')}`,
    ].join(',');
  }

  private normalizeSessionResumption(value: unknown): Record<string, unknown> | undefined {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return undefined;
    }

    const source = value as Record<string, unknown>;
    const normalized: Record<string, unknown> = {};

    if (typeof source['handle'] === 'string' && source['handle'].trim()) {
      normalized['handle'] = source['handle'].trim();
    }

    if (source['transparent'] !== undefined) {
      logGeminiVoice('Ignoring unsupported option', 'sessionResumption.transparent');
    }

    return Object.keys(normalized).length > 0 ? normalized : undefined;
  }

  private normalizeExplicitVadSignal(value: unknown): boolean | undefined {
    if (value === undefined) {
      return undefined;
    }

    logGeminiVoice('Ignoring unsupported option', 'explicitVadSignal');
    return undefined;
  }

  private mapThinkingLevel(reasoning: NonNullable<VoiceSessionConfig['reasoning']>): 'minimal' | 'low' | 'medium' | 'high' {
    switch (reasoning) {
      case 'off':
        return 'minimal';
      case 'low':
        return 'low';
      case 'high':
        return 'high';
      case 'medium':
      default:
        return 'medium';
    }
  }
}

registerVoiceProvider('gemini-voice', () => new GeminiVoiceProvider());
