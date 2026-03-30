import { actionContext } from './ActionContext.js';
import { ToolExecutionEngine } from './ToolExecutionEngine.js';
import { buildProviderToolRequest } from './providerTools.js';
import { ToolLoader } from '../loaders/ToolLoader.js';
import { Session } from './Session.js';
import { getLoop } from '../loops/index.js';
import { getSyntax } from '../syntax/index.js';
import { getAgentVoiceProvider } from '../providers/runtime.js';
import type { LoadedAgent, ProviderToolResult } from '../types/index.js';
import type { ISandbox } from '../sandbox/interfaces.js';
import { loadAgentTools } from './SessionFactory.js';

function logVoiceSession(message: string, details?: string): void {
  console.log(`[voice-session] ${message}${details ? `: ${details}` : ''}`);
}

function previewText(text: string, max = 180): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length <= max) {
    return normalized;
  }
  return `${normalized.slice(0, max - 3)}...`;
}

export interface VoiceAgentSessionCallbacks {
  onAudioOutput?: (payload: { data: Buffer | string; mimeType: string }) => Promise<void> | void;
  onInputTranscript?: (text: string) => void;
  onOutputTranscript?: (text: string) => void;
  onSessionOpen?: (sessionId?: string) => void;
  onTurnComplete?: (reason?: string) => void;
  onTurnInterrupted?: () => void;
  onClose?: () => void;
}

export interface VoiceAgentSessionControllerOptions {
  agent: LoadedAgent;
  sandbox: ISandbox;
  toolLoader?: ToolLoader;
  routeEnv?: Record<string, string>;
  callbacks?: VoiceAgentSessionCallbacks;
}

export class VoiceAgentSessionController {
  private readonly agent: LoadedAgent;
  private readonly sandbox: ISandbox;
  private readonly toolLoader: ToolLoader;
  private readonly callbacks: VoiceAgentSessionCallbacks;
  private readonly routeEnv: Record<string, string>;
  private sessionPromise: Promise<import('../types/index.js').VoiceSession> | null = null;
  private receiveLoopPromise: Promise<void> | null = null;
  private readonly transcripts: Array<{ role: 'user' | 'assistant'; text: string }> = [];
  private closed = false;
  private inputAudioChunkCount = 0;
  private outputAudioChunkCount = 0;

  constructor(options: VoiceAgentSessionControllerOptions) {
    this.agent = options.agent;
    this.sandbox = options.sandbox;
    this.toolLoader = options.toolLoader || new ToolLoader();
    this.callbacks = options.callbacks || {};
    this.routeEnv = { ...(options.routeEnv || {}) };
  }

  async start(): Promise<void> {
    if (this.sessionPromise) {
      logVoiceSession('Start requested but session already exists', this.agent.config.name);
      return;
    }

    logVoiceSession('Creating voice session', this.agent.config.name);
    this.sessionPromise = this.createVoiceSession();
    const session = await this.sessionPromise;
    logVoiceSession('Voice session created', this.agent.config.name);
    this.receiveLoopPromise = this.consumeEvents(session);
  }

  async sendRealtimeInput(input: import('../types/index.js').VoiceRealtimeInput): Promise<void> {
    const session = await this.requireSession();
    if (input.audio) {
      this.inputAudioChunkCount += 1;
      const size = typeof input.audio.data === 'string'
        ? Buffer.byteLength(input.audio.data, 'base64')
        : input.audio.data.length;
      if (this.inputAudioChunkCount <= 3 || this.inputAudioChunkCount % 25 === 0) {
        logVoiceSession(
          'Streaming microphone audio',
          `chunk=${this.inputAudioChunkCount}, bytes=${size}, mime=${input.audio.mimeType}`,
        );
      }
    }
    if (typeof input.text === 'string' && input.text.trim()) {
      logVoiceSession('Streaming realtime text', previewText(input.text));
    }
    if (input.audioStreamEnd) {
      logVoiceSession('Audio input stream ended');
    }
    await session.sendRealtimeInput(input);
  }

  async sendTextInstruction(text: string, turnComplete = true): Promise<void> {
    const session = await this.requireSession();
    logVoiceSession('Sending text instruction', `${previewText(text)} | turnComplete=${turnComplete}`);
    await session.sendTextTurn({ text, turnComplete });
  }

  async waitForTranscript(): Promise<string> {
    logVoiceSession('Waiting for final transcript');
    if (this.receiveLoopPromise) {
      await this.receiveLoopPromise;
    }
    logVoiceSession('Transcript ready', `${this.transcripts.length} entries`);
    return this.transcripts
      .map((entry) => `${entry.role === 'user' ? 'User' : 'Assistant'}: ${entry.text}`)
      .join('\n');
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    logVoiceSession('Closing session', this.agent.config.name);
    if (this.sessionPromise) {
      const session = await this.sessionPromise;
      await session.close();
    }
  }

  private async requireSession(): Promise<import('../types/index.js').VoiceSession> {
    if (!this.sessionPromise) {
      await this.start();
    }
    return this.sessionPromise!;
  }

  private async createVoiceSession(): Promise<import('../types/index.js').VoiceSession> {
    const provider = getAgentVoiceProvider(this.agent);
    const tools = buildProviderToolRequest().tools;
    logVoiceSession(
      'Connecting provider',
      `provider=${provider.name}, model=${this.agent.config.model || 'gemini-3.1-flash-live-preview'}, tools=${tools.length}`,
    );

    return provider.connect({
      model: this.agent.config.model || 'gemini-3.1-flash-live-preview',
      temperature: this.agent.config.temperature,
      maxTokens: this.agent.config.maxTokens,
      top_p: this.agent.config.top_p,
      top_k: this.agent.config.top_k,
      seed: this.agent.config.seed,
      reasoning: this.agent.config.reasoning,
      providerOptions: this.agent.config.providerOptions,
      systemInstruction: this.agent.systemPromptContent,
      tools,
    });
  }

  private async consumeEvents(session: import('../types/index.js').VoiceSession): Promise<void> {
    const toolExecutor = await this.createToolExecutor();
    logVoiceSession('Event loop started', this.agent.config.name);

    for await (const event of session.receive()) {
      if (event.type === 'session.open') {
        logVoiceSession('Provider session open', event.sessionId || 'session id unavailable');
        this.callbacks.onSessionOpen?.(event.sessionId);
        continue;
      }

      if (event.type === 'audio.output') {
        this.outputAudioChunkCount += 1;
        const size = typeof event.data === 'string'
          ? Buffer.byteLength(event.data, 'base64')
          : event.data.length;
        if (this.outputAudioChunkCount <= 3 || this.outputAudioChunkCount % 25 === 0) {
          logVoiceSession(
            'Received model audio',
            `chunk=${this.outputAudioChunkCount}, bytes=${size}, mime=${event.mimeType}`,
          );
        }
        await this.callbacks.onAudioOutput?.({ data: event.data, mimeType: event.mimeType });
        continue;
      }

      if (event.type === 'transcript.input') {
        logVoiceSession('User transcript', previewText(event.text));
        this.transcripts.push({ role: 'user', text: event.text });
        this.callbacks.onInputTranscript?.(event.text);
        continue;
      }

      if (event.type === 'transcript.output') {
        logVoiceSession('Assistant transcript', previewText(event.text));
        this.transcripts.push({ role: 'assistant', text: event.text });
        this.callbacks.onOutputTranscript?.(event.text);
        continue;
      }

      if (event.type === 'tool.call') {
        logVoiceSession(
          'Provider requested tool calls',
          event.toolCalls.map((toolCall) => toolCall.name).join(', ') || 'unknown',
        );
        const toolResults: ProviderToolResult[] = [];

        for (const toolCall of event.toolCalls) {
          logVoiceSession('Executing tool call', `${toolCall.name} (${toolCall.id})`);
          const result = await toolExecutor.executeProviderToolCall(toolCall);
          if (result.finishMessage) {
            logVoiceSession('Tool requested finish', `${toolCall.name} -> ${previewText(result.finishMessage)}`);
            await session.sendToolResults([
              {
                id: toolCall.id,
                name: toolCall.name,
                response: { output: result.finishMessage },
              },
            ]);
            continue;
          }

          logVoiceSession('Tool result ready', `${toolCall.name} (${toolCall.id})`);
          toolResults.push({
            id: toolCall.id,
            name: toolCall.name,
            response: result.observation.startsWith('Error:')
              ? { error: result.observation }
              : { output: result.observation },
          });
        }

        if (toolResults.length > 0) {
          logVoiceSession('Sending tool results back to provider', String(toolResults.length));
          await session.sendToolResults(toolResults);
        }
        continue;
      }

      if (event.type === 'turn.complete') {
        logVoiceSession('Model turn complete', event.reason || 'no reason');
        this.callbacks.onTurnComplete?.(event.reason);
        continue;
      }

      if (event.type === 'turn.interrupted') {
        logVoiceSession('Model turn interrupted');
        this.callbacks.onTurnInterrupted?.();
        continue;
      }

      if (event.type === 'turn.waiting_for_input') {
        logVoiceSession('Model is waiting for input');
        continue;
      }

      if (event.type === 'session.resumption') {
        logVoiceSession(
          'Session resumption update',
          `resumable=${event.resumable}, lastClientIndex=${event.lastConsumedClientMessageIndex ?? 'n/a'}`,
        );
        continue;
      }

      if (event.type === 'tool.call.cancel') {
        logVoiceSession('Tool call cancellation received', event.ids.join(', '));
        continue;
      }

      if (event.type === 'session.close') {
        logVoiceSession('Provider session closed');
        this.callbacks.onClose?.();
        break;
      }

      if (event.type === 'error') {
        logVoiceSession('Provider session error', event.error instanceof Error ? event.error.message : String(event.error));
        throw event.error;
      }
    }

    logVoiceSession('Event loop finished', this.agent.config.name);
  }

  private async createToolExecutor(): Promise<ToolExecutionEngine> {
    const tools = await loadAgentTools(this.agent, this.toolLoader, ['message']);
    const session = new Session({
      agent: this.agent,
      provider: {
        name: 'voice-tool-executor',
        complete: async () => ({
          content: '',
          finishReason: 'stop',
        }),
      },
      syntax: getSyntax(this.agent.config.syntax),
      loop: getLoop(this.agent.config.loop),
      tools,
      sandbox: this.sandbox,
    });
    await session.initialize();

    const env = {
      ...this.routeEnv,
      ACN_AGENT_NAME: this.agent.config.name,
    };

    return new class extends ToolExecutionEngine {
      override async executeAction(code: string) {
        return actionContext.run({ env }, () => super.executeAction(code));
      }
      override async executeCli(command: string) {
        return actionContext.run({ env }, () => super.executeCli(command));
      }
    }(session);
  }
}
