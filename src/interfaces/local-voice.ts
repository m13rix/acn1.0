import { spawn, type ChildProcess } from 'child_process';
import { once } from 'events';
import { existsSync } from 'fs';
import path from 'path';
import { createRequire } from 'module';
import ffmpegStatic from '@ffmpeg-installer/ffmpeg';
import { AgentLoader } from '../loaders/AgentLoader.js';
import type { LoadedAgent } from '../types/index.js';
import type {
  AgentInterfaceRuntime,
  InterfaceAgentInvocationOptions,
  InterfaceRouteHandler,
  InterfaceRuntimeContext,
} from './base.js';
import { VoiceAgentSessionController } from '../core/VoiceAgentSessionController.js';
import { createSandbox } from '../sandbox/index.js';
import type { ISandbox } from '../sandbox/interfaces.js';

const DEFAULT_ROUTE_ID = 'local-voice:default';
const DEFAULT_HOTKEY = 'CTRL+L';
const require = createRequire(import.meta.url);

function logLocalVoice(message: string, details?: string): void {
  console.log(`[local-voice] ${message}${details ? `: ${details}` : ''}`);
}

function warnLocalVoice(message: string, details?: string): void {
  console.warn(`[local-voice] ${message}${details ? `: ${details}` : ''}`);
}

async function detectWindowsDshowAudioDevice(ffmpegPath: string): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn(
      ffmpegPath,
      ['-hide_banner', '-list_devices', 'true', '-f', 'dshow', '-i', 'dummy'],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      },
    );

    let output = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });

    child.on('error', () => resolve(null));
    child.on('exit', () => {
      const lines = output.split(/\r?\n/);
      let inAudioSection = false;

      for (const line of lines) {
        if (line.includes('DirectShow audio devices')) {
          inAudioSection = true;
          continue;
        }

        if (inAudioSection && line.includes('DirectShow ') && !line.includes('DirectShow audio devices')) {
          break;
        }

        if (!inAudioSection) {
          continue;
        }

        const match = line.match(/"([^"]+)"/);
        if (match?.[1]) {
          resolve(`audio=${match[1]}`);
          return;
        }
      }

      resolve(null);
    });
  });
}

async function resolveMicrophoneCaptureConfig(
  agent: LoadedAgent,
  ffmpegPath: string,
): Promise<{ format: string; input: string; description: string }> {
  const configuredInputDevice = agent.config.interfaceOptions?.['inputDeviceId'];
  if (typeof configuredInputDevice === 'string' && configuredInputDevice.trim()) {
    return {
      format: 'dshow',
      input: configuredInputDevice.trim(),
      description: `custom dshow device ${configuredInputDevice.trim()}`,
    };
  }

  if (process.platform === 'win32') {
    const detectedDevice = await detectWindowsDshowAudioDevice(ffmpegPath);
    if (detectedDevice) {
      logLocalVoice('Auto-detected Windows microphone', detectedDevice);
      return {
        format: 'dshow',
        input: detectedDevice,
        description: `auto-detected Windows dshow input ${detectedDevice}`,
      };
    }

    warnLocalVoice('Windows microphone auto-detect failed', 'falling back to audio=default');
    return {
      format: 'dshow',
      input: 'audio=default',
      description: 'fallback Windows dshow input audio=default',
    };
  }

  return {
    format: 'avfoundation',
    input: ':0',
    description: 'default platform input device',
  };
}

type HotkeyListenerInstance = {
  addListener(listener: (event: { state: string; name: string; ctrlKey?: boolean }) => void): void;
  removeAllListeners?(): void;
  kill?(): void;
};

async function loadHotkeyListener(): Promise<HotkeyListenerInstance | null> {
  try {
    if (process.platform === 'win32') {
      const packageJsonPath = require.resolve('node-global-key-listener/package.json');
      const packageDir = path.dirname(packageJsonPath);
      const windowsServerPath = path.join(packageDir, 'bin', 'WinKeyServer.exe');
      if (!existsSync(windowsServerPath)) {
        warnLocalVoice('Global hotkey disabled', `missing helper binary at ${windowsServerPath}`);
        return null;
      }
    }

    const module = await import('node-global-key-listener');
    const ListenerCtor = (module as any).GlobalKeyboardListener;
    if (!ListenerCtor) {
      return null;
    }
    return new ListenerCtor();
  } catch {
    return null;
  }
}

async function loadSpeaker(): Promise<any | null> {
  try {
    const module = await import('speaker');
    return (module as any).default || module;
  } catch {
    return null;
  }
}

class LocalVoiceRouteHandler implements InterfaceRouteHandler {
  routeId = DEFAULT_ROUTE_ID;
  interfaceName = 'local-voice';

  constructor(private readonly runtime: LocalVoiceInterfaceRuntime) {}

  getAgentName(): string | null {
    return this.runtime.getActiveAgentName();
  }

  async ensureAgent(preferredAgentName?: string): Promise<void> {
    await this.runtime.ensureSession(preferredAgentName);
  }

  async ask(question: string): Promise<string> {
    return this.runtime.ask(question);
  }

  async sendText(text: string): Promise<void> {
    await this.runtime.sendInstruction(text);
  }

  async sendVoice(filePath: string): Promise<void> {
    await this.runtime.sendInstruction(`System note: a local voice file is available at ${filePath}. Refer to it if needed.`);
  }

  async sendFiles(files: string[]): Promise<void> {
    await this.runtime.sendInstruction(`System note: files were shared with the session: ${files.join(', ')}`);
  }
}

export class LocalVoiceInterfaceRuntime implements AgentInterfaceRuntime {
  name = 'local-voice';

  private context: InterfaceRuntimeContext | null = null;
  private readonly agentLoader = new AgentLoader();
  private hotkeyListener: HotkeyListenerInstance | null = null;
  private defaultAgentName: string | null = null;
  private activeAgentName: string | null = null;
  private activeController: VoiceAgentSessionController | null = null;
  private activeSandbox: ISandbox | null = null;
  private activeSandboxOwned = false;
  private activeCaptureProcess: ChildProcess | null = null;
  private activeSpeaker: any = null;
  private pendingQuestionResolvers: Array<(value: string) => void> = [];
  private routeRegistered = false;
  private terminalHotkeyFallbackActive = false;
  private speakerGuardUntil = 0;
  private micSuppressedForSpeaker = false;
  private assistantSpeaking = false;
  private speakerReleaseTimer: NodeJS.Timeout | null = null;
  private speakerClosing = false;
  private armTailOnSpeakerClose = false;

  supportsModality(modality: 'text' | 'voice'): boolean {
    return modality === 'voice';
  }

  async start(context: InterfaceRuntimeContext): Promise<void> {
    this.context = context;
    this.defaultAgentName = await this.resolveDefaultAgentName();
    logLocalVoice('Runtime starting', `default agent: ${this.defaultAgentName || 'none'}`);

    if (!this.routeRegistered) {
      context.registerRoute(new LocalVoiceRouteHandler(this));
      this.routeRegistered = true;
      logLocalVoice('Route registered', DEFAULT_ROUTE_ID);
    }

    this.hotkeyListener = await loadHotkeyListener();
    if (this.hotkeyListener) {
      try {
        logLocalVoice('Global hotkey listener ready', DEFAULT_HOTKEY);
        this.hotkeyListener.addListener((event) => {
          if (event.state !== 'DOWN') {
            return;
          }
          if (!event.ctrlKey || String(event.name || '').toUpperCase() !== 'L') {
            return;
          }
          logLocalVoice('Global hotkey detected', 'Ctrl+L');
          void this.toggleDefaultSession();
        });
      } catch (error) {
        warnLocalVoice(
          'Failed to start global hotkey listener. Programmatic local-voice calls will still work',
          error instanceof Error ? error.message : String(error),
        );
        this.hotkeyListener = null;
      }
    } else {
      logLocalVoice('Global hotkey unavailable', 'terminal Ctrl+L fallback can be used for testing');
    }
  }

  async stop(): Promise<void> {
    logLocalVoice('Runtime stopping');
    await this.stopActiveSession();
    this.hotkeyListener?.removeAllListeners?.();
    this.hotkeyListener?.kill?.();
    this.hotkeyListener = null;
  }

    async invokeAgent(options: InterfaceAgentInvocationOptions): Promise<string> {
        await this.startSession(options.agent, {
            request: options.request,
            routeEnv: options.routeEnv,
      sandbox: options.sandbox,
    });
    return this.activeController?.waitForTranscript() || '';
  }

  getActiveAgentName(): string | null {
    return this.activeAgentName;
  }

  isTerminalHotkeyFallbackNeeded(): boolean {
    return !this.hotkeyListener;
  }

  setTerminalHotkeyFallbackActive(active: boolean): void {
    this.terminalHotkeyFallbackActive = active;
    logLocalVoice('Terminal hotkey fallback', active ? 'enabled' : 'disabled');
  }

  async toggleFromConsoleHotkey(): Promise<void> {
    logLocalVoice('Terminal hotkey detected', 'Ctrl+L');
    await this.toggleDefaultSession();
  }

  async ensureSession(preferredAgentName?: string): Promise<void> {
    if (this.activeController) {
      logLocalVoice('Session already active', this.activeAgentName || 'unknown agent');
      return;
    }

    const agentName = preferredAgentName || this.defaultAgentName;
    if (!agentName) {
      throw new Error('No default local-voice agent configured.');
    }

    const loadedAgent = await this.agentLoader.loadByName(agentName);
    if (!loadedAgent) {
      throw new Error(`Local voice agent "${agentName}" not found.`);
    }

    logLocalVoice('Ensuring session', `agent=${agentName}`);
    await this.startSession(loadedAgent, {
      request: '',
      routeEnv: {},
      sandbox: createSandbox(loadedAgent.config.sandbox),
      ownsSandbox: true,
    });
  }

  async ask(question: string): Promise<string> {
    if (!this.activeController) {
      throw new Error('No active local-voice session.');
    }

    logLocalVoice('Voice question queued', question);
    const answerPromise = new Promise<string>((resolve) => {
      this.pendingQuestionResolvers.push(resolve);
    });

    await this.sendInstruction(`System: ask the user this question and wait for their answer: ${question}`);
    return answerPromise;
  }

  async sendInstruction(text: string): Promise<void> {
    if (!this.activeController) {
      throw new Error('No active local-voice session.');
    }
    logLocalVoice('Sending text instruction', text);
    await this.activeController.sendTextInstruction(text, true);
  }

  private async toggleDefaultSession(): Promise<void> {
    if (this.activeController) {
      logLocalVoice('Toggle requested', 'stopping active session');
      await this.stopActiveSession();
      return;
    }

    const defaultAgentName = this.defaultAgentName || await this.resolveDefaultAgentName();
    if (!defaultAgentName) {
      throw new Error('No default local-voice agent configured.');
    }

    const loadedAgent = await this.agentLoader.loadByName(defaultAgentName);
    if (!loadedAgent) {
      throw new Error(`Local voice agent "${defaultAgentName}" not found.`);
    }

    logLocalVoice('Toggle requested', `starting default session for ${defaultAgentName}`);
    await this.startSession(loadedAgent, {
      request: '',
      routeEnv: {},
      sandbox: createSandbox(loadedAgent.config.sandbox),
      ownsSandbox: true,
    });
  }

  private async startSession(
    agent: LoadedAgent,
    options: { request: string; routeEnv?: Record<string, string>; sandbox: ISandbox; ownsSandbox?: boolean }
  ): Promise<void> {
    logLocalVoice('Starting session', `agent=${agent.config.name}, request=${options.request ? 'present' : 'empty'}`);
    await this.stopActiveSession();

    const controller = new VoiceAgentSessionController({
      agent,
      sandbox: options.sandbox,
      routeEnv: {
        ACN_INTERFACE_API_URL: process.env.ACN_INTERFACE_API_URL || process.env.ACN_API_URL || '',
        ACN_INTERFACE_ROUTE: DEFAULT_ROUTE_ID,
        ACN_API_URL: process.env.ACN_INTERFACE_API_URL || process.env.ACN_API_URL || '',
        ACN_CHAT_ID: DEFAULT_ROUTE_ID,
        ...(options.routeEnv || {}),
      },
      callbacks: {
        onAudioOutput: async (payload) => {
          this.markSpeakerPlaybackActive();
          await this.playAudioChunk(agent, payload.data);
        },
        onInputTranscript: (text) => {
          logLocalVoice('Input transcript', text);
          const waiter = this.pendingQuestionResolvers.shift();
          if (waiter) {
            logLocalVoice('Resolving pending voice question', text);
            waiter(text);
          }
        },
        onOutputTranscript: (text) => {
          logLocalVoice('Assistant transcript', text);
        },
        onSessionOpen: (sessionId) => {
          logLocalVoice('Voice session opened', sessionId || 'session id unavailable');
        },
        onTurnComplete: (reason) => {
          logLocalVoice('Model turn complete', reason || 'no reason');
          this.finishSpeakerPlayback(agent);
        },
        onTurnInterrupted: () => {
          logLocalVoice('Model turn interrupted');
          this.resetSpeakerPlayback('provider interruption');
        },
        onClose: () => {
          logLocalVoice('Voice session closed by provider');
          void this.stopActiveSession();
        },
      },
    });

    this.activeAgentName = agent.config.name;
    this.activeController = controller;
    this.activeSandbox = options.sandbox;
    this.activeSandboxOwned = options.ownsSandbox === true;
    await controller.start();
    logLocalVoice('Voice session controller started', agent.config.name);
    await this.startMicrophoneCapture(controller, agent);

    if (options.request.trim()) {
      logLocalVoice('Sending initial programmatic instruction', options.request);
      await controller.sendTextInstruction(`[System: ${options.request}]`, true);
    }
  }

  private async startMicrophoneCapture(controller: VoiceAgentSessionController, agent: LoadedAgent): Promise<void> {
    const ffmpegPath = ffmpegStatic.path;
    const captureConfig = await resolveMicrophoneCaptureConfig(agent, ffmpegPath);
    const args = [
      '-hide_banner',
      '-loglevel', 'error',
      '-f', captureConfig.format,
      '-i', captureConfig.input,
      '-ac', '1',
      '-ar', '16000',
      '-f', 's16le',
      'pipe:1',
    ];

    logLocalVoice(
      'Starting microphone capture',
      `format=${captureConfig.format}, device=${captureConfig.input}, note=${captureConfig.description}, ffmpeg=${ffmpegPath}`,
    );
    const child = spawn(ffmpegPath, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    this.activeCaptureProcess = child;
    child.stdout.on('data', (chunk: Buffer) => {
      if (this.isSpeakerPlaybackGuardActive()) {
        if (!this.micSuppressedForSpeaker) {
          this.micSuppressedForSpeaker = true;
          logLocalVoice('Suppressing microphone stream', 'assistant audio is currently playing');
        }
        return;
      }

      if (this.micSuppressedForSpeaker) {
        this.micSuppressedForSpeaker = false;
        logLocalVoice('Resuming microphone stream', 'speaker playback guard released');
      }

      void controller.sendRealtimeInput({
        audio: {
          data: chunk,
          mimeType: 'audio/pcm;rate=16000',
        },
      });
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString().trim();
      if (text) {
        warnLocalVoice('ffmpeg stderr', text);
      }
    });
    child.on('spawn', () => {
      logLocalVoice('Microphone capture active');
    });
    child.on('exit', (code, signal) => {
      logLocalVoice('Microphone capture stopped', `code=${code ?? 'null'}, signal=${signal ?? 'null'}`);
    });
    child.on('error', (error) => {
      warnLocalVoice('Microphone capture failed', error instanceof Error ? error.message : String(error));
    });
  }

  private async playAudioChunk(agent: LoadedAgent, data: Buffer | string): Promise<void> {
    const Speaker = await loadSpeaker();
    if (!Speaker) {
      warnLocalVoice('Speaker module unavailable', 'audio playback is disabled');
      return;
    }

    if (this.activeSpeaker && this.speakerClosing) {
      this.resetSpeakerPlayback('new model audio arrived while previous speaker was closing');
    }

    if (!this.activeSpeaker) {
      this.activeSpeaker = new Speaker({
        channels: 1,
        bitDepth: 16,
        sampleRate: 24000,
      });
      this.speakerClosing = false;
      this.armTailOnSpeakerClose = false;
      logLocalVoice('Speaker initialized', '24kHz mono PCM');
      this.activeSpeaker.on?.('close', () => {
        logLocalVoice('Speaker playback finished');
        const shouldArmTail = this.armTailOnSpeakerClose;
        this.activeSpeaker = null;
        this.speakerClosing = false;
        this.assistantSpeaking = false;
        this.armTailOnSpeakerClose = false;
        if (shouldArmTail) {
          this.armSpeakerTail(agent);
        }
      });
      this.activeSpeaker.on?.('error', (error: Error) => {
        warnLocalVoice('Speaker playback error', error.message);
      });
    }

    const buffer = typeof data === 'string' ? Buffer.from(data, 'base64') : data;
    const canWrite = this.activeSpeaker.write(buffer);
    if (!canWrite) {
      await once(this.activeSpeaker, 'drain');
    }
  }

  private async stopActiveSession(): Promise<void> {
    const controller = this.activeController;
    const sandbox = this.activeSandbox;
    const sandboxOwned = this.activeSandboxOwned;
    this.activeController = null;
    this.activeAgentName = null;
    this.activeSandbox = null;
    this.activeSandboxOwned = false;

    if (controller || this.activeCaptureProcess || this.activeSpeaker) {
      logLocalVoice('Stopping active session');
    }
    this.speakerGuardUntil = 0;
    this.micSuppressedForSpeaker = false;
    this.assistantSpeaking = false;
    this.speakerClosing = false;
    this.armTailOnSpeakerClose = false;
    if (this.speakerReleaseTimer) {
      clearTimeout(this.speakerReleaseTimer);
      this.speakerReleaseTimer = null;
    }
    if (this.activeCaptureProcess) {
      this.activeCaptureProcess.kill();
      this.activeCaptureProcess = null;
    }
    if (this.activeSpeaker) {
      this.activeSpeaker.close?.(false);
      this.activeSpeaker = null;
    }

    if (controller) {
      await controller.close();
    }

    if (sandbox && sandboxOwned) {
      await sandbox.cleanup().catch((error) => {
        warnLocalVoice('Sandbox cleanup failed', error instanceof Error ? error.message : String(error));
      });
    }

    if (this.pendingQuestionResolvers.length > 0) {
      warnLocalVoice('Dropping pending voice questions', String(this.pendingQuestionResolvers.length));
      this.pendingQuestionResolvers = [];
    }
  }

  private async resolveDefaultAgentName(): Promise<string | null> {
    const agents = await this.agentLoader.loadAll();
    const localVoiceAgents = agents.filter((agent) =>
      (agent.config.interface || 'telegram') === 'local-voice'
      && (agent.config.modality || 'text') === 'voice'
    );

    if (localVoiceAgents.length === 0) {
      logLocalVoice('No local-voice agents found');
      return null;
    }
    if (localVoiceAgents.length === 1) {
      logLocalVoice('Resolved default local-voice agent', localVoiceAgents[0]!.config.name);
      return localVoiceAgents[0]!.config.name;
    }

    const defaults = localVoiceAgents.filter((agent) => agent.config.interfaceOptions?.['launchDefault'] === true);
    if (defaults.length !== 1) {
      throw new Error('Multiple local-voice agents detected; exactly one must set interfaceOptions.launchDefault: true.');
    }

    logLocalVoice('Resolved explicit local-voice default', defaults[0]!.config.name);
    return defaults[0]!.config.name;
  }

  private markSpeakerPlaybackActive(): void {
    this.assistantSpeaking = true;
    if (this.speakerReleaseTimer) {
      clearTimeout(this.speakerReleaseTimer);
      this.speakerReleaseTimer = null;
    }
    this.speakerGuardUntil = 0;
  }

  private isSpeakerPlaybackGuardActive(): boolean {
    return this.assistantSpeaking || this.speakerClosing || Date.now() < this.speakerGuardUntil;
  }

  private finishSpeakerPlayback(agent: LoadedAgent): void {
    if (!this.activeSpeaker) {
      this.assistantSpeaking = false;
      this.armSpeakerTail(agent);
      return;
    }
    if (this.speakerClosing) {
      return;
    }

    this.speakerClosing = true;
    this.armTailOnSpeakerClose = true;
    logLocalVoice('Finishing speaker playback', 'waiting for speaker close event');
    this.activeSpeaker.end?.();
  }

  private resetSpeakerPlayback(reason: string): void {
    if (this.speakerReleaseTimer) {
      clearTimeout(this.speakerReleaseTimer);
      this.speakerReleaseTimer = null;
    }
    this.speakerGuardUntil = 0;
    this.assistantSpeaking = false;
    this.speakerClosing = false;
    this.armTailOnSpeakerClose = false;
    if (this.activeSpeaker) {
      logLocalVoice('Resetting speaker playback', reason);
      this.activeSpeaker.close?.(false);
      this.activeSpeaker = null;
    }
  }

  private armSpeakerTail(agent: LoadedAgent): void {
    const tailMs = this.getSpeakerGuardMs(agent);
    this.speakerGuardUntil = Date.now() + tailMs;
    logLocalVoice('Speaker playback guard tail armed', `${tailMs}ms after actual speaker close`);
    this.armSpeakerReleaseTimer();
  }

  private armSpeakerReleaseTimer(): void {
    if (this.speakerReleaseTimer) {
      clearTimeout(this.speakerReleaseTimer);
      this.speakerReleaseTimer = null;
    }

    const delay = Math.max(this.speakerGuardUntil - Date.now(), 0);
    this.speakerReleaseTimer = setTimeout(() => {
      this.speakerReleaseTimer = null;
      if (!this.assistantSpeaking && !this.speakerClosing && Date.now() >= this.speakerGuardUntil && this.micSuppressedForSpeaker) {
        logLocalVoice('Speaker playback guard expired', 'microphone can stream again');
      }
    }, delay + 10);
  }

  private getSpeakerGuardMs(agent: LoadedAgent): number {
    const configured = agent.config.interfaceOptions?.['speakerGuardMs'];
    if (typeof configured === 'number' && Number.isFinite(configured) && configured >= 0) {
      return configured;
    }
    return 1400;
  }
}
