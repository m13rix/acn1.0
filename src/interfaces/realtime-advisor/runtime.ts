import express from 'express';
import multer from 'multer';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import { spawn, type ChildProcess } from 'child_process';
import path from 'path';
import { copyFile, mkdir, readdir, rm, stat, unlink, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import open from 'open';
import { AgentLoader } from '../../loaders/AgentLoader.js';
import { ToolLoader } from '../../loaders/ToolLoader.js';
import { createSandbox } from '../../sandbox/index.js';
import type { ISandbox } from '../../sandbox/interfaces.js';
import { runWithAgentContext } from '../../core/AgentContext.js';
import { getGlobalDisplay } from '../../core/GlobalDisplay.js';
import { Executor, type ExecutorCallbacks } from '../../core/Executor.js';
import { Session, type SessionSnapshot } from '../../core/Session.js';
import { buildTextSessionComponents } from '../../core/SessionFactory.js';
import { StreamDisplay } from '../../cli/display.js';
import type { AgentInterfaceRuntime, InterfaceRouteHandler, InterfaceRuntimeContext } from '../base.js';
import type { LoadedAgent } from '../../types/index.js';
import { PyannoteClient } from './pyannote.js';
import { RealtimeAdvisorStore } from './store.js';
import { renderRealtimeAdvisorClientHtml } from './client-html.js';
import {
  appendAndTrimVoiceSample,
  concatAudioFilesToWav,
  convertToSpeakerSampleWav,
  extractSegmentsToWav,
  getAudioDurationSeconds,
  splitAudioIntoWindowsToWav,
  type AudioSegment,
} from './audio.js';
import {
  ECAPA_MODEL_ID,
  EcapaEmbeddingService,
  compareEcapaEmbeddings,
  readEcapaEmbeddingFile,
  writeEcapaEmbeddingFile,
  type EcapaEmbeddingResult,
} from './ecapa.js';
import {
  calculateAdaptiveThresholds,
  isConfirmedKnownSpeaker,
  isUnknownSpeakerCandidate,
  listSpeakerEmbeddingCandidates,
} from './speaker-selection.js';
import {
  REALTIME_ADVISOR_INTERFACE,
  REALTIME_ADVISOR_ROUTE_ID,
  type ConversationRecord,
  type DiarizationSegment,
  type PendingSpeakerProposal,
  type PyannoteDiarizationOutput,
  type RealtimeAdvisorConfig,
  type RealtimeChunkMetadata,
  type SpeakerConfidenceSummary,
  type SpeakerEmbeddingCandidate,
  type SpeakerRecord,
  type SpeakerResolutionRequest,
  type StoredAudioChunk,
  type TranscriptEntry,
  type TurnLevelTranscript,
  type UnknownCandidateBuffer,
} from './types.js';

type MaybeMulterFile = Express.Multer.File | undefined;

interface ResolvedSpeakerSummary {
  diarizationSpeaker: string;
  speakerId?: string;
  summary: SpeakerConfidenceSummary;
}

interface AdvisorSessionCacheEntry {
  session: Session;
}

const UNKNOWN_BUFFER_MATCH_SCORE = 0.35;
const UNKNOWN_COHERENCE_MIN_PAIRWISE = 0.18;
const UNKNOWN_COHERENCE_MEAN_PAIRWISE = 0.30;
const UNKNOWN_COHERENCE_WINDOW_SECONDS = 3.5;
const UNKNOWN_COHERENCE_MIN_WINDOW_SECONDS = 2.0;
const UNKNOWN_COHERENCE_MAX_WINDOWS = 8;

function logRealtime(message: string, details?: string): void {
  console.log(`[realtime-advisor] ${message}${details ? `: ${details}` : ''}`);
}

function warnRealtime(message: string, details?: string): void {
  console.warn(`[realtime-advisor] ${message}${details ? `: ${details}` : ''}`);
}

function readBooleanEnv(name: string, fallback = false): boolean {
  const raw = (process.env[name] || '').trim().toLowerCase();
  if (!raw) {
    return fallback;
  }
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

function readNumberEnv(name: string, fallback: number): number {
  const raw = (process.env[name] || '').trim();
  if (!raw) {
    return fallback;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseImmediateAdvice(value: unknown): boolean {
  if (typeof value === 'boolean') {
    return value;
  }
  const raw = String(value || '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

function toRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value) {
    return undefined;
  }
  if (typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value === 'string' && value.trim()) {
    try {
      const parsed = JSON.parse(value) as unknown;
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : undefined;
    } catch {
      return { raw: value };
    }
  }
  return undefined;
}

function addSecondsToIso(iso: string, seconds: number): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return iso;
  }
  return new Date(date.getTime() + Math.max(0, seconds) * 1000).toISOString();
}

function formatTimecode(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return iso;
  }
  return date.toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC');
}

function sanitizeFileName(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 90) || 'audio';
}

function extractTranscriptTurns(output: PyannoteDiarizationOutput | undefined): TurnLevelTranscript[] {
  const turns = output?.turnLevelTranscription;
  if (Array.isArray(turns) && turns.length > 0) {
    return turns
      .filter((turn) => turn && typeof turn.text === 'string' && turn.text.trim())
      .map((turn) => ({
        speaker: String(turn.speaker || '[...]'),
        start: Number(turn.start) || 0,
        end: Number(turn.end) || Number(turn.start) || 0,
        text: turn.text.trim(),
      }));
  }
  return [];
}

function extractDiarizationSegments(output: PyannoteDiarizationOutput | undefined): DiarizationSegment[] {
  const exclusive = output?.exclusiveDiarization;
  if (Array.isArray(exclusive) && exclusive.length > 0) {
    return exclusive;
  }
  return Array.isArray(output?.diarization) ? output!.diarization! : [];
}

function sumSpeechSeconds(segments: DiarizationSegment[], speaker: string): number {
  return segments
    .filter((segment) => segment.speaker === speaker)
    .reduce((sum, segment) => sum + Math.max(0, (Number(segment.end) || 0) - (Number(segment.start) || 0)), 0);
}

function createDefaultConfig(): RealtimeAdvisorConfig {
  const dataDir = path.resolve(process.cwd(), 'data', 'realtime-advisor');
  return {
    port: Math.max(0, Math.floor(readNumberEnv('TELOS_REALTIME_ADVISOR_PORT', 0))),
    host: process.env.TELOS_REALTIME_ADVISOR_HOST || '0.0.0.0',
    publicBaseUrl: process.env.TELOS_REALTIME_ADVISOR_BASE_URL,
    dataDir: process.env.TELOS_REALTIME_ADVISOR_DATA_DIR || dataDir,
    agentName: process.env.TELOS_REALTIME_ADVISOR_AGENT || 'realtime_advisor',
    conversationGapMs: readNumberEnv('TELOS_REALTIME_CONVERSATION_GAP_MS', 5 * 60 * 1000),
    unknownGapMs: readNumberEnv('TELOS_REALTIME_UNKNOWN_GAP_MS', 5 * 60 * 1000),
    unknownMinSpeechSeconds: readNumberEnv('TELOS_REALTIME_UNKNOWN_MIN_SPEECH_SECONDS', 20),
    speakerSampleMaxSeconds: readNumberEnv('TELOS_REALTIME_SPEAKER_SAMPLE_MAX_SECONDS', 30),
    ecapaPythonPath: process.env.TELOS_REALTIME_ECAPA_PYTHON || process.env.PYTHON || 'python',
    ecapaModelCache: process.env.TELOS_REALTIME_ECAPA_MODEL_CACHE
      || path.resolve(process.cwd(), 'models', 'speechbrain-spkrec-ecapa-voxceleb'),
    ecapaSampleRate: Math.max(1, Math.floor(readNumberEnv('TELOS_REALTIME_ECAPA_SAMPLE_RATE', 16000))),
    ecapaBatchSize: Math.max(1, Math.floor(readNumberEnv('TELOS_REALTIME_ECAPA_BATCH_SIZE', 32))),
    ecapaChunkSeconds: Math.max(0, readNumberEnv('TELOS_REALTIME_ECAPA_CHUNK_SECONDS', 0)),
    ecapaOverlapSeconds: Math.max(0, readNumberEnv('TELOS_REALTIME_ECAPA_OVERLAP_SECONDS', 0)),
    ecapaFp16: readBooleanEnv('TELOS_REALTIME_ECAPA_FP16', false),
    ecapaDevice: process.env.TELOS_REALTIME_ECAPA_DEVICE || 'cuda:0',
    pyannoteApiKey: process.env.PYANNOTE_API_KEY,
    pyannoteApiBaseUrl: process.env.PYANNOTE_API_BASE_URL || 'https://api.pyannote.ai',
    mockPyannote: readBooleanEnv('TELOS_REALTIME_ADVISOR_MOCK_PYANNOTE', false),
    autoOpenClient: readBooleanEnv('TELOS_REALTIME_ADVISOR_OPEN_CLIENT', false),
    maxUploadBytes: Math.max(1, readNumberEnv('TELOS_REALTIME_ADVISOR_MAX_UPLOAD_BYTES', 24 * 1024 * 1024)),
    localhostRunEnabled: readBooleanEnv('TELOS_REALTIME_ADVISOR_LOCALHOST_RUN', true),
    localhostRunHost: process.env.TELOS_REALTIME_ADVISOR_LOCALHOST_RUN_HOST || 'nokey@localhost.run',
  };
}

class RealtimeAdvisorRouteHandler implements InterfaceRouteHandler {
  routeId = REALTIME_ADVISOR_ROUTE_ID;
  interfaceName = REALTIME_ADVISOR_INTERFACE;

  constructor(private readonly runtime: RealtimeAdvisorInterfaceRuntime) {}

  getAgentName(): string | null {
    return this.runtime.getAgentName();
  }

  async ensureAgent(): Promise<void> {
    await this.runtime.ensureAgentReady();
  }

  async ask(question: string): Promise<string> {
    return this.runtime.askDirect(question);
  }

  async sendText(text: string): Promise<void> {
    await this.runtime.sendTranscriptNote(text);
  }

  async sendVoice(filePath: string): Promise<void> {
    await this.runtime.sendTranscriptNote(`Voice file received: ${filePath}`);
  }

  async sendFiles(files: string[]): Promise<void> {
    await this.runtime.sendTranscriptNote(`Files received: ${files.join(', ')}`);
  }
}

export class RealtimeAdvisorInterfaceRuntime implements AgentInterfaceRuntime {
  name = REALTIME_ADVISOR_INTERFACE;

  private context: InterfaceRuntimeContext | null = null;
  private readonly agentLoader = new AgentLoader();
  private readonly toolLoader = new ToolLoader();
  private readonly config: RealtimeAdvisorConfig;
  private readonly store: RealtimeAdvisorStore;
  private readonly pyannote: PyannoteClient;
  private readonly ecapa: EcapaEmbeddingService;
  private readonly app = express();
  private readonly upload: multer.Multer;
  private server: Server | null = null;
  private baseUrl = '';
  private localBaseUrl = '';
  private publicUrl = '';
  private tunnelStatus: 'disabled' | 'starting' | 'online' | 'failed' | 'stopped' = 'disabled';
  private tunnelError = '';
  private tunnelProcess: ChildProcess | null = null;
  private routeRegistered = false;
  private agent: LoadedAgent | null = null;
  private agentSandbox: ISandbox | null = null;
  private agentSessions = new Map<string, AdvisorSessionCacheEntry>();
  private agentQueue: Promise<unknown> = Promise.resolve();

  constructor(config: Partial<RealtimeAdvisorConfig> = {}) {
    this.config = {
      ...createDefaultConfig(),
      ...config,
    };
    this.store = new RealtimeAdvisorStore(this.config.dataDir);
    this.pyannote = new PyannoteClient({
      apiKey: this.config.pyannoteApiKey,
      apiBaseUrl: this.config.pyannoteApiBaseUrl,
      mock: this.config.mockPyannote,
    });
    this.ecapa = new EcapaEmbeddingService({
      pythonPath: this.config.ecapaPythonPath,
      modelCache: this.config.ecapaModelCache,
      sampleRate: this.config.ecapaSampleRate,
      batchSize: this.config.ecapaBatchSize,
      chunkSeconds: this.config.ecapaChunkSeconds,
      overlapSeconds: this.config.ecapaOverlapSeconds,
      fp16: this.config.ecapaFp16,
      device: this.config.ecapaDevice,
    });
    this.upload = multer({
      storage: multer.memoryStorage(),
      limits: {
        fileSize: this.config.maxUploadBytes,
      },
    });
    this.configureExpress();
  }

  supportsModality(modality: 'text' | 'voice'): boolean {
    return modality === 'text';
  }

  async start(context: InterfaceRuntimeContext): Promise<void> {
    this.context = context;
    await this.store.initialize();
    await this.ensureAgentReady();
    await this.getOrCreateAgentSession(undefined, undefined);
    if (!this.routeRegistered) {
      context.registerRoute(new RealtimeAdvisorRouteHandler(this));
      this.routeRegistered = true;
    }
    void this.ecapa.warmup()
      .then(() => this.refreshSpeakerEmbeddingsAtStartup())
      .catch((error) => {
        warnRealtime('ECAPA warmup failed', error instanceof Error ? error.message : String(error));
      });
    void this.recoverUnknownBuffersAtStartup();
    void this.recoverOrphanUnknownSamplesAtStartup();
    await this.startServer();
  }

  async stop(): Promise<void> {
    await this.stopLocalhostRunTunnel();
    if (this.server) {
      await new Promise<void>((resolve, reject) => {
        this.server?.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
      this.server = null;
    }
    await this.ecapa.stop();
    if (this.routeRegistered) {
      this.context?.unregisterRoute(REALTIME_ADVISOR_ROUTE_ID);
      this.routeRegistered = false;
    }
    this.agentSessions.clear();
    if (this.agentSandbox) {
      await this.agentSandbox.cleanup().catch((error) => {
        warnRealtime('Agent sandbox cleanup failed', error instanceof Error ? error.message : String(error));
      });
      this.agentSandbox = null;
    }
  }

  getAgentName(): string | null {
    return this.agent?.config.name || this.config.agentName;
  }

  getBaseUrl(): string {
    return this.baseUrl;
  }

  async ensureAgentReady(): Promise<void> {
    if (this.agent && this.agentSandbox) {
      return;
    }
    const loaded = await this.agentLoader.loadByName(this.config.agentName);
    if (!loaded) {
      throw new Error(`Realtime advisor agent "${this.config.agentName}" not found.`);
    }
    this.agent = loaded;
    this.agentSandbox = createSandbox(
      loaded.config.sandbox,
      loaded.config.runPath ? { existingPath: loaded.config.runPath } : undefined,
    );
  }

  private getAgentSessionKey(conversationId: string | undefined): string {
    return conversationId || '__direct__';
  }

  private invalidateAgentSession(conversationId: string | undefined): void {
    this.agentSessions.delete(this.getAgentSessionKey(conversationId));
  }

  private async getOrCreateAgentSession(
    conversationId: string | undefined,
    restoreSnapshot: SessionSnapshot | undefined,
  ): Promise<Session> {
    await this.ensureAgentReady();
    if (!this.agent || !this.agentSandbox) {
      throw new Error('Realtime advisor agent is not ready.');
    }

    const key = this.getAgentSessionKey(conversationId);
    const cached = this.agentSessions.get(key);
    if (cached) {
      return cached.session;
    }

    const components = await buildTextSessionComponents(this.agent, this.toolLoader);
    const session = new Session({
      ...components,
      sandbox: this.agentSandbox,
    });
    await session.initialize();
    if (restoreSnapshot) {
      session.applySnapshot(restoreSnapshot);
    }
    this.agentSessions.set(key, { session });
    return session;
  }

  async askDirect(question: string): Promise<string> {
    const conversation = this.store.getCurrentConversation();
    const message = conversation
      ? `${question}\n\nCurrent transcript context:\n${this.formatConversationTranscript(conversation)}`
      : question;
    return this.runAgentWithConversation(conversation?.id, message, []);
  }

  async sendTranscriptNote(text: string): Promise<void> {
    const conversation = this.store.getCurrentConversation();
    if (!conversation) {
      return;
    }
    const syntheticEntry: TranscriptEntry = {
      id: `manual_${Date.now()}`,
      chunkId: 'manual',
      conversationId: conversation.id,
      source: 'quick',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      startTime: new Date().toISOString(),
      speakerLabel: '[system]',
      text,
      final: true,
      revision: 1,
      agentMarker: `manual_${Date.now()}`,
    };
    await this.runAgentWithConversation(conversation.id, this.formatAdviceMessage(conversation, [syntheticEntry]), []);
  }

  private configureExpress(): void {
    this.app.use((req, res, next) => {
      res.header('Access-Control-Allow-Origin', '*');
      res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      if (req.method === 'OPTIONS') {
        res.sendStatus(204);
        return;
      }
      next();
    });
    this.app.use(express.json({ limit: '8mb' }));
    this.app.use('/samples/pending', express.static(this.store.pendingSamplesDir));
    this.app.use('/samples/speakers', express.static(this.store.speakerSamplesDir));

    this.app.get('/', (_req, res) => {
      res.type('html').send(renderRealtimeAdvisorClientHtml());
    });
    this.app.get('/client', (_req, res) => {
      res.type('html').send(renderRealtimeAdvisorClientHtml());
    });
    this.app.get('/health', (_req, res) => {
      res.json({
        success: true,
        interface: REALTIME_ADVISOR_INTERFACE,
        routeId: REALTIME_ADVISOR_ROUTE_ID,
        agentName: this.config.agentName,
        pyannoteEnabled: this.pyannote.isEnabled() && !this.pyannote.isMock(),
        mockPyannote: this.pyannote.isMock(),
        ecapa: {
          model: ECAPA_MODEL_ID,
          available: this.ecapa.isAvailable(),
          device: this.config.ecapaDevice,
          modelCache: this.config.ecapaModelCache,
        },
        baseUrl: this.baseUrl,
        localUrl: this.localBaseUrl,
        publicUrl: this.publicUrl || undefined,
        tunnel: {
          enabled: this.config.localhostRunEnabled,
          status: this.tunnelStatus,
          error: this.tunnelError || undefined,
        },
      });
    });

    this.app.get('/v1/state', (_req, res) => {
      const currentConversation = this.store.getCurrentConversation();
      res.json({
        success: true,
        currentConversation,
        pendingSpeakers: this.pendingSpeakerPayloads(currentConversation?.id),
        speakers: this.store.listSpeakers().map((speaker) => this.publicSpeakerPayload(speaker)),
        baseUrl: this.baseUrl,
        localUrl: this.localBaseUrl,
        publicUrl: this.publicUrl || undefined,
        tunnel: {
          enabled: this.config.localhostRunEnabled,
          status: this.tunnelStatus,
          error: this.tunnelError || undefined,
        },
      });
    });

    this.app.get('/v1/conversations/:id', (req, res) => {
      const conversation = this.store.getConversation(req.params.id);
      if (!conversation) {
        res.status(404).json({ error: 'Conversation not found.' });
        return;
      }
      res.json({ success: true, conversation });
    });

    this.app.get('/v1/speakers', (_req, res) => {
      res.json({
        success: true,
        speakers: this.store.listSpeakers().map((speaker) => this.publicSpeakerPayload(speaker)),
        pendingSpeakers: this.pendingSpeakerPayloads(),
      });
    });

    this.app.post('/v1/chunks', this.upload.single('audio'), async (req, res): Promise<void> => {
      try {
        const file = req.file;
        const metadata = this.parseChunkMetadata(req.body || {});
        const audioPath = await this.persistIncomingAudio(file, req.body);
        const mimeType = file?.mimetype || String(req.body?.mimeType || 'application/octet-stream');
        const { chunk, conversation } = await this.store.registerChunk({
          audioPath,
          mimeType,
          metadata,
          conversationGapMs: this.config.conversationGapMs,
        });

        this.queueChunkProcessing(chunk.id);
        const responsePayload: Record<string, unknown> = {
          success: true,
          chunkId: chunk.id,
          conversationId: conversation.id,
          transcript: this.formatConversationTranscript(this.store.getConversation(conversation.id) || conversation),
          newSpeakers: this.pendingSpeakerPayloads(conversation.id, true),
        };

        if (metadata.immediateAdvice) {
          const latestConversation = this.store.getConversation(conversation.id) || conversation;
          const advice = await this.sendNewTranscriptToAgent(latestConversation);
          responsePayload['advice'] = advice;
        }

        const deliveredIds = (responsePayload['newSpeakers'] as Array<{ id: string }> | undefined)?.map((item) => item.id) || [];
        if (deliveredIds.length > 0) {
          await this.store.markPendingSpeakerDelivered(conversation.id, deliveredIds);
        }

        res.json(responsePayload);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        res.status(500).json({ success: false, error: message });
      }
    });

    this.app.post('/v1/speakers', this.upload.single('audio'), async (req, res): Promise<void> => {
      try {
        const file = req.file;
        if (!file) {
          res.status(400).json({ error: 'Missing audio file.' });
          return;
        }
        const name = String(req.body?.name || '').trim();
        if (!name) {
          res.status(400).json({ error: 'Missing speaker name.' });
          return;
        }
        const description = String(req.body?.description || '').trim();
        const speaker = await this.createSpeakerFromSample({
          name,
          description,
          sourceBuffer: file.buffer,
          sourceName: file.originalname,
        });
        res.json({ success: true, speaker: this.publicSpeakerPayload(speaker) });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        res.status(500).json({ success: false, error: message });
      }
    });

    this.app.post('/v1/speakers/resolve', async (req, res): Promise<void> => {
      try {
        const resolutions = Array.isArray(req.body?.resolutions)
          ? req.body.resolutions as SpeakerResolutionRequest[]
          : [];
        if (resolutions.length === 0) {
          res.status(400).json({ error: 'Missing resolutions array.' });
          return;
        }
        const results = [];
        for (const resolution of resolutions) {
          results.push(await this.resolvePendingSpeaker(resolution));
        }
        res.json({ success: true, results });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        res.status(500).json({ success: false, error: message });
      }
    });
  }

  private async startServer(): Promise<void> {
    if (this.server) {
      return;
    }

    const startedServer = this.app.listen(this.config.port, this.config.host);
    this.server = startedServer;
    await new Promise<void>((resolve) => {
      startedServer.once('listening', () => resolve());
    });
    const address = startedServer.address() as AddressInfo;
    const localBase = `http://localhost:${address.port}`;
    this.localBaseUrl = localBase;
    this.baseUrl = this.config.publicBaseUrl || localBase;
    process.env.TELOS_REALTIME_ADVISOR_URL = this.baseUrl;
    logRealtime('Server listening', `${this.baseUrl} (client: ${this.baseUrl}/client)`);
    this.startLocalhostRunTunnel(address.port);
    if (this.config.autoOpenClient) {
      await open(`${this.baseUrl}/client`).catch((error) => {
        warnRealtime('Could not open client', error instanceof Error ? error.message : String(error));
      });
    }
  }

  private startLocalhostRunTunnel(port: number): void {
    if (!this.config.localhostRunEnabled || this.config.publicBaseUrl) {
      this.tunnelStatus = this.config.localhostRunEnabled ? 'disabled' : 'disabled';
      return;
    }
    if (this.tunnelProcess) {
      return;
    }

    this.tunnelStatus = 'starting';
    this.tunnelError = '';
    const args = [
      '-o', 'StrictHostKeyChecking=no',
      '-o', 'ServerAliveInterval=60',
      '-o', 'ExitOnForwardFailure=yes',
      '-R', `80:127.0.0.1:${port}`,
      this.config.localhostRunHost,
    ];
    const child = spawn('ssh', args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.tunnelProcess = child;

    const handleOutput = (chunk: Buffer): void => {
      const text = chunk.toString();
      const url = this.extractLocalhostRunUrl(text);
      if (url) {
        this.publicUrl = url;
        this.baseUrl = url;
        process.env.TELOS_REALTIME_ADVISOR_URL = url;
        this.tunnelStatus = 'online';
        this.tunnelError = '';
        logRealtime('localhost.run tunnel online', `${url}/client`);
      }
    };

    child.stdout?.on('data', handleOutput);
    child.stderr?.on('data', (chunk: Buffer) => {
      handleOutput(chunk);
      const text = chunk.toString().trim();
      if (text && !this.extractLocalhostRunUrl(text)) {
        this.tunnelError = text.split(/\r?\n/).slice(-2).join('\n');
      }
    });
    child.on('error', (error) => {
      this.tunnelStatus = 'failed';
      this.tunnelError = error.message;
      this.tunnelProcess = null;
      warnRealtime('localhost.run tunnel failed', error.message);
    });
    child.on('close', (code) => {
      if (this.tunnelProcess === child) {
        this.tunnelProcess = null;
      }
      if (this.tunnelStatus === 'online') {
        this.tunnelStatus = 'stopped';
      } else if (this.tunnelStatus !== 'failed') {
        this.tunnelStatus = 'failed';
      }
      if (code !== 0 && !this.tunnelError) {
        this.tunnelError = `ssh exited with code ${code}`;
      }
      if (!this.publicUrl) {
        warnRealtime('localhost.run tunnel stopped', this.tunnelError || `ssh exited with code ${code}`);
      }
    });
  }

  private async stopLocalhostRunTunnel(): Promise<void> {
    const child = this.tunnelProcess;
    if (!child) {
      return;
    }
    this.tunnelProcess = null;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => resolve(), 1500);
      child.once('close', () => {
        clearTimeout(timer);
        resolve();
      });
      child.kill();
    });
    this.tunnelStatus = 'stopped';
  }

  private extractLocalhostRunUrl(text: string): string | null {
    const matches = text.match(/https:\/\/[^\s"'<>]+/ig) || [];
    for (const raw of matches) {
      const url = raw.replace(/\/+$/, '');
      if (/^https:\/\/admin\.localhost\.run\b/i.test(url)) {
        continue;
      }
      if (/\.(?:lhr\.life|lhrtunnel\.link)\b/i.test(url) || /\.localhost\.run\b/i.test(url)) {
        return url;
      }
    }
    return null;
  }

  private parseChunkMetadata(body: Record<string, unknown>): RealtimeChunkMetadata {
    return {
      chunkId: typeof body['chunkId'] === 'string' ? body['chunkId'] : undefined,
      quickTranscript: typeof body['quickTranscript'] === 'string'
        ? body['quickTranscript']
        : typeof body['transcript'] === 'string'
          ? body['transcript']
          : undefined,
      immediateAdvice: parseImmediateAdvice(body['immediateAdvice']),
      timestamp: typeof body['timestamp'] === 'string' || typeof body['timestamp'] === 'number'
        ? body['timestamp']
        : undefined,
      language: typeof body['language'] === 'string' ? body['language'] : undefined,
      metadata: toRecord(body['metadata']),
    };
  }

  private async persistIncomingAudio(file: MaybeMulterFile, body: Record<string, unknown>): Promise<string> {
    if (file) {
      const targetPath = this.store.createChunkAudioPath(file.originalname, file.mimetype);
      await mkdir(path.dirname(targetPath), { recursive: true });
      await writeFile(targetPath, file.buffer);
      return targetPath;
    }

    const base64 = typeof body?.['audioBase64'] === 'string' ? body['audioBase64'] : '';
    if (!base64) {
      throw new Error('Missing audio file or audioBase64 field.');
    }
    const mimeType = typeof body?.['mimeType'] === 'string' ? body['mimeType'] : 'application/octet-stream';
    const targetPath = this.store.createChunkAudioPath('chunk', mimeType);
    await mkdir(path.dirname(targetPath), { recursive: true });
    await writeFile(targetPath, Buffer.from(base64, 'base64'));
    return targetPath;
  }

  private queueChunkProcessing(chunkId: string): void {
    void this.processChunk(chunkId).catch((error) => {
      warnRealtime('Chunk processing failed', error instanceof Error ? error.message : String(error));
    });
  }

  private async processChunk(chunkId: string): Promise<void> {
    const state = this.store.getStateSnapshot();
    const chunk = state.chunks[chunkId];
    if (!chunk) {
      return;
    }
    if (!this.pyannote.isEnabled()) {
      await this.store.markChunkProcessing(chunk.id, 'skipped', { error: 'PYANNOTE_API_KEY is not configured.' });
      return;
    }

    await this.store.markChunkProcessing(chunk.id, 'running');

    try {
      const mediaUrl = await this.pyannote.uploadMedia(chunk.audioPath);
      const diarizeJob = await this.pyannote.diarize(mediaUrl);
      await this.store.markChunkProcessing(chunk.id, 'running', {
        diarizationJobId: diarizeJob.jobId,
      });

      const diarizeResult = await this.pyannote.waitForJob<PyannoteDiarizationOutput>(diarizeJob);

      if (diarizeResult.status !== 'succeeded') {
        throw new Error(diarizeResult.error || `Diarization job ${diarizeResult.jobId} ended with ${diarizeResult.status}`);
      }

      await this.applyProcessedChunk(
        chunk,
        diarizeResult.output,
      );
      await this.store.markChunkProcessing(chunk.id, 'succeeded', {
        diarizationJobId: diarizeResult.jobId,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.store.markChunkProcessing(chunk.id, 'failed', { error: message });
      throw error;
    }
  }

  private async applyProcessedChunk(
    chunk: StoredAudioChunk,
    diarization: PyannoteDiarizationOutput | undefined,
  ): Promise<void> {
    const conversation = this.store.getConversation(chunk.conversationId);
    if (!conversation) {
      return;
    }

    const speakerSummaries = await this.resolveSpeakerSummaries(chunk, diarization);
    const knownSpeakerIds = speakerSummaries
      .map((summary) => summary.speakerId)
      .filter((speakerId): speakerId is string => !!speakerId);
    await this.store.recordRecognizedSpeakers(conversation.id, knownSpeakerIds);

    const speakerByTrack = new Map<string, SpeakerRecord>();
    for (const summary of speakerSummaries) {
      if (!summary.speakerId) {
        continue;
      }
      const speaker = this.store.getSpeaker(summary.speakerId);
      if (speaker) {
        speakerByTrack.set(summary.diarizationSpeaker, speaker);
      }
    }

    const turns = extractTranscriptTurns(diarization);
    if (turns.length > 0) {
      const entries = turns.map((turn) => {
        const speaker = speakerByTrack.get(turn.speaker);
        return {
          source: 'pyannote' as const,
          startTime: addSecondsToIso(chunk.clientTimestamp, turn.start),
          endTime: addSecondsToIso(chunk.clientTimestamp, turn.end),
          speakerLabel: speaker?.name || '[...]',
          diarizationSpeaker: turn.speaker,
          text: turn.text,
          final: true,
        };
      });
      const replacement = await this.store.replaceChunkTranscript({
        conversationId: conversation.id,
        chunkId: chunk.id,
        entries,
      });
      await this.replaceAgentContextEntries(conversation.id, replacement.removedQuickEntries, replacement.insertedEntries);
    }

    const unknownSummaries = speakerSummaries.filter((summary) =>
      !summary.speakerId && isUnknownSpeakerCandidate(
        summary.summary,
        calculateAdaptiveThresholds(this.store.getStateSnapshot().scoreStats),
      )
    );
    const diarSegments = extractDiarizationSegments(diarization);
    const hasKnownSpeakerEmbeddings = this.store.listSpeakers().some((speaker) => !!speaker.embeddingPath);
    if (unknownSummaries.length === 0 && !hasKnownSpeakerEmbeddings) {
      const unknownSpeakers = Array.from(new Set(diarSegments.map((segment) => segment.speaker)));
      for (const speaker of unknownSpeakers) {
        unknownSummaries.push({
          diarizationSpeaker: speaker,
          summary: {
            cleanSpeechSeconds: sumSpeechSeconds(diarSegments, speaker),
            margin: Number.POSITIVE_INFINITY,
            topScore: 0,
            agreeingSegments: diarSegments.filter((segment) => segment.speaker === speaker).length,
          },
        });
      }
    }

    for (const unknown of unknownSummaries) {
      const speakerSegments: AudioSegment[] = diarSegments
        .filter((segment) => segment.speaker === unknown.diarizationSpeaker)
        .map((segment) => ({ start: segment.start, end: segment.end }));
      const speechSeconds = unknown.summary.cleanSpeechSeconds || sumSpeechSeconds(diarSegments, unknown.diarizationSpeaker);
      if (speechSeconds <= 0) {
        continue;
      }

      let speakerOnlyPath = chunk.audioPath;
      let extractedSeconds = speechSeconds;
      if (speakerSegments.length > 0) {
        speakerOnlyPath = this.store.getTempPath(`unknown-part-${chunk.id}-${unknown.diarizationSpeaker}.wav`);
        try {
          extractedSeconds = await extractSegmentsToWav(
            chunk.audioPath,
            speakerSegments,
            speakerOnlyPath,
            this.store.tempDir,
            this.config.speakerSampleMaxSeconds,
          );
        } catch (error) {
          warnRealtime(
            'Could not extract unknown speaker-only snippet',
            error instanceof Error ? error.message : String(error),
          );
          speakerOnlyPath = chunk.audioPath;
        }
      }

      const unknownEmbedding = await this.embedAudioToFile(
        speakerOnlyPath,
        this.store.getTempEmbeddingPath(`unknown-part-${chunk.id}-${unknown.diarizationSpeaker}`),
      ).catch((error) => {
        warnRealtime('Unknown speaker embedding failed', error instanceof Error ? error.message : String(error));
        return null;
      });
      const matchingBufferId = unknownEmbedding
        ? await this.findMatchingUnknownBuffer(conversation.id, unknownEmbedding.embedding)
        : undefined;

      const buffer = await this.store.upsertUnknownBuffer({
        bufferId: matchingBufferId,
        conversationId: conversation.id,
        diarizationSpeaker: unknown.diarizationSpeaker,
        chunkId: chunk.id,
        audioPath: speakerOnlyPath,
        embeddingPath: unknownEmbedding?.path,
        embeddingModel: unknownEmbedding?.model,
        speechSeconds: extractedSeconds,
        chunkAt: chunk.clientTimestamp,
        unknownGapMs: this.config.unknownGapMs,
      });
      if (buffer.speechSeconds >= this.config.unknownMinSpeechSeconds) {
        await this.evaluateUnknownBuffer(buffer.id).catch((error) => {
          warnRealtime(
            'Unknown speaker proposal generation failed',
            error instanceof Error ? error.message : String(error),
          );
        });
      }
    }
  }

  private async resolveSpeakerSummaries(
    chunk: StoredAudioChunk,
    diarization: PyannoteDiarizationOutput | undefined,
  ): Promise<ResolvedSpeakerSummary[]> {
    const diarSegments = extractDiarizationSegments(diarization);
    const speakerNames = Array.from(new Set(diarSegments.map((segment) => segment.speaker).filter(Boolean)));
    if (speakerNames.length === 0) {
      return [];
    }

    const extractionInputs = speakerNames.map((diarizationSpeaker) => ({
      diarizationSpeaker,
      segments: diarSegments
        .filter((segment) => segment.speaker === diarizationSpeaker)
        .map((segment) => ({ start: segment.start, end: segment.end })),
      speechSeconds: sumSpeechSeconds(diarSegments, diarizationSpeaker),
      path: this.store.getTempPath(`speaker-${chunk.id}-${diarizationSpeaker}.wav`),
    }));

    const extracted = (await Promise.all(extractionInputs.map(async (input) => {
      try {
        const seconds = await extractSegmentsToWav(
          chunk.audioPath,
          input.segments,
          input.path,
          this.store.tempDir,
          this.config.speakerSampleMaxSeconds,
        );
        return { ...input, speechSeconds: seconds };
      } catch (error) {
        warnRealtime('Could not extract speaker track', `${input.diarizationSpeaker}: ${error instanceof Error ? error.message : String(error)}`);
        return null;
      }
    }))).filter((item): item is NonNullable<typeof item> => !!item);

    if (extracted.length === 0) {
      return [];
    }

    let embeddings: EcapaEmbeddingResult[] = [];
    try {
      embeddings = await this.ecapa.embedFiles(extracted.map((item) => item.path));
    } catch (error) {
      warnRealtime('ECAPA chunk embedding failed', error instanceof Error ? error.message : String(error));
    }

    const embeddingByPath = new Map(embeddings.map((embedding) => [path.resolve(embedding.path).toLowerCase(), embedding]));
    const candidates = await this.loadSpeakerEmbeddingCandidates();
    const candidateIds = new Set(candidates.map((candidate) => candidate.speakerId));
    const thresholds = calculateAdaptiveThresholds(this.store.getStateSnapshot().scoreStats);
    const results: ResolvedSpeakerSummary[] = [];

    for (const extractedSpeaker of extracted) {
      const embedding = embeddingByPath.get(path.resolve(extractedSpeaker.path).toLowerCase());
      const scores = embedding
        ? this.scoreEmbeddingAgainstCandidates(embedding.embedding, candidates)
        : {};
      const agreeingSegments = diarSegments.filter((segment) => segment.speaker === extractedSpeaker.diarizationSpeaker).length;
      const summary: SpeakerConfidenceSummary = {
        ...scores,
        cleanSpeechSeconds: extractedSpeaker.speechSeconds,
        agreeingSegments,
      };
      const isKnown = isConfirmedKnownSpeaker(summary, thresholds) && !!summary.topLabel && candidateIds.has(summary.topLabel);
      if (isKnown && summary.topLabel) {
        void this.store.recordKnownScore(summary.topScore || 0, summary.margin || 0);
      } else if (summary.topScore !== undefined) {
        void this.store.recordUnknownScore(summary.topScore, summary.margin || 0);
      }
      results.push({
        diarizationSpeaker: extractedSpeaker.diarizationSpeaker,
        speakerId: isKnown ? summary.topLabel : undefined,
        summary,
      });
    }

    return results;
  }

  private async loadSpeakerEmbeddingCandidates(): Promise<SpeakerEmbeddingCandidate[]> {
    const candidates = listSpeakerEmbeddingCandidates(this.store.listSpeakers());
    const loaded = await Promise.all(candidates.map(async (candidate) => {
      const embedding = await readEcapaEmbeddingFile(candidate.embeddingPath).catch(() => null);
      return embedding ? { ...candidate, embedding } : null;
    }));
    return loaded.filter((candidate): candidate is SpeakerEmbeddingCandidate => !!candidate);
  }

  private scoreEmbeddingAgainstCandidates(
    embedding: number[],
    candidates: SpeakerEmbeddingCandidate[],
  ): Pick<SpeakerConfidenceSummary, 'topLabel' | 'topScore' | 'secondLabel' | 'secondScore' | 'margin'> {
    const sorted = candidates
      .map((candidate) => ({
        label: candidate.speakerId,
        score: compareEcapaEmbeddings(embedding, candidate.embedding),
      }))
      .filter((entry) => Number.isFinite(entry.score))
      .sort((a, b) => b.score - a.score);
    const top = sorted[0];
    const second = sorted[1];
    return {
      topLabel: top?.label,
      topScore: top?.score,
      secondLabel: second?.label,
      secondScore: second?.score,
      margin: top ? top.score - (second?.score ?? 0) : undefined,
    };
  }

  private getUnknownBufferEmbeddingPaths(buffer: UnknownCandidateBuffer): string[] {
    return Array.from(new Set([
      ...(buffer.embeddingPaths || []),
      ...(buffer.embeddingPath ? [buffer.embeddingPath] : []),
    ]));
  }

  private pairwiseEmbeddingStats(embeddings: number[][]): {
    count: number;
    min: number;
    mean: number;
  } {
    const scores: number[] = [];
    for (let left = 0; left < embeddings.length; left += 1) {
      for (let right = left + 1; right < embeddings.length; right += 1) {
        scores.push(compareEcapaEmbeddings(embeddings[left]!, embeddings[right]!));
      }
    }
    if (scores.length === 0) {
      return { count: 0, min: 1, mean: 1 };
    }
    return {
      count: scores.length,
      min: Math.min(...scores),
      mean: scores.reduce((sum, score) => sum + score, 0) / scores.length,
    };
  }

  private async embedAudioToFile(audioPath: string, embeddingPath: string): Promise<{
    path: string;
    embedding: number[];
    model: string;
    durationSec: number;
  } | null> {
    const [result] = await this.ecapa.embedFiles([audioPath]);
    if (!result) {
      return null;
    }
    await writeEcapaEmbeddingFile(embeddingPath, result, audioPath);
    return {
      path: embeddingPath,
      embedding: result.embedding,
      model: result.model,
      durationSec: result.durationSec,
    };
  }

  private async findMatchingUnknownBuffer(conversationId: string, embedding: number[]): Promise<string | undefined> {
    const buffers = Object.values(this.store.getStateSnapshot().unknownBuffers)
      .filter((buffer) => buffer.conversationId === conversationId && this.getUnknownBufferEmbeddingPaths(buffer).length > 0)
      .sort((a, b) => b.lastChunkAt.localeCompare(a.lastChunkAt));

    let best: { buffer: UnknownCandidateBuffer; score: number; meanScore: number } | undefined;
    for (const buffer of buffers) {
      const candidateEmbeddings = (await Promise.all(
        this.getUnknownBufferEmbeddingPaths(buffer).map((embeddingPath) => readEcapaEmbeddingFile(embeddingPath).catch(() => null)),
      )).filter((item): item is number[] => !!item);
      if (candidateEmbeddings.length === 0) {
        continue;
      }
      const scores = candidateEmbeddings.map((candidateEmbedding) => compareEcapaEmbeddings(embedding, candidateEmbedding));
      const score = Math.max(...scores);
      const meanScore = scores.reduce((sum, item) => sum + item, 0) / scores.length;
      if (!best || score > best.score) {
        best = { buffer, score, meanScore };
      }
    }

    if (!best) {
      return undefined;
    }
    return best.score >= UNKNOWN_BUFFER_MATCH_SCORE && best.meanScore >= UNKNOWN_BUFFER_MATCH_SCORE - 0.05
      ? best.buffer.id
      : undefined;
  }

  private async validateUnknownSampleCoherence(compiledPath: string, buffer: UnknownCandidateBuffer): Promise<{
    ok: boolean;
    minPairwise: number;
    meanPairwise: number;
    windows: number;
    reason?: string;
  }> {
    const snippetEmbeddings = (await Promise.all(
      this.getUnknownBufferEmbeddingPaths(buffer).map((embeddingPath) => readEcapaEmbeddingFile(embeddingPath).catch(() => null)),
    )).filter((item): item is number[] => !!item);
    const snippetStats = this.pairwiseEmbeddingStats(snippetEmbeddings);
    if (snippetStats.count > 0 && (
      snippetStats.min < UNKNOWN_COHERENCE_MIN_PAIRWISE
      || snippetStats.mean < UNKNOWN_COHERENCE_MEAN_PAIRWISE
    )) {
      return {
        ok: false,
        minPairwise: snippetStats.min,
        meanPairwise: snippetStats.mean,
        windows: snippetEmbeddings.length,
        reason: 'unknown snippets do not sound like the same speaker',
      };
    }

    const windows = await splitAudioIntoWindowsToWav(compiledPath, this.store.tempDir, {
      windowSeconds: UNKNOWN_COHERENCE_WINDOW_SECONDS,
      minWindowSeconds: UNKNOWN_COHERENCE_MIN_WINDOW_SECONDS,
      maxWindows: UNKNOWN_COHERENCE_MAX_WINDOWS,
    });
    const windowDir = windows[0] ? path.dirname(windows[0].path) : undefined;

    try {
      if (windows.length < 2) {
        return {
          ok: true,
          minPairwise: snippetStats.min,
          meanPairwise: snippetStats.mean,
          windows: windows.length,
        };
      }

      const embeddings = await this.ecapa.embedFiles(windows.map((window) => window.path));
      const stats = this.pairwiseEmbeddingStats(embeddings.map((embedding) => embedding.embedding));
      const minPairwise = Math.min(snippetStats.min, stats.min);
      const meanPairwise = snippetStats.count > 0
        ? (snippetStats.mean + stats.mean) / 2
        : stats.mean;
      const ok = minPairwise >= UNKNOWN_COHERENCE_MIN_PAIRWISE
        && meanPairwise >= UNKNOWN_COHERENCE_MEAN_PAIRWISE;
      return {
        ok,
        minPairwise,
        meanPairwise,
        windows: embeddings.length,
        reason: ok ? undefined : 'compiled sample windows do not sound like the same speaker',
      };
    } finally {
      if (windowDir) {
        await rm(windowDir, { recursive: true, force: true }).catch(() => undefined);
      }
    }
  }

  private async evaluateUnknownBuffer(bufferId: string): Promise<void> {
    const buffer = this.store.getStateSnapshot().unknownBuffers[bufferId];
    if (!buffer) {
      return;
    }
    const compiledPath = this.store.getTempPath(`unknown-${buffer.id}.wav`);
    await concatAudioFilesToWav(buffer.audioPaths, compiledPath, this.store.tempDir);
    let completed = false;

    try {
      const embeddingPath = this.store.getPendingEmbeddingPath(buffer.diarizationSpeaker || buffer.id);
      const embedded = await this.embedAudioToFile(compiledPath, embeddingPath);
      const thresholds = calculateAdaptiveThresholds(this.store.getStateSnapshot().scoreStats);
      const candidates = await this.loadSpeakerEmbeddingCandidates();
      const scores = embedded ? this.scoreEmbeddingAgainstCandidates(embedded.embedding, candidates) : {};
      const summary: SpeakerConfidenceSummary = {
        ...scores,
        cleanSpeechSeconds: buffer.speechSeconds,
        agreeingSegments: buffer.chunkIds.length,
      };

      if (isConfirmedKnownSpeaker(summary, thresholds) && summary.topLabel) {
        await this.store.recordRecognizedSpeakers(buffer.conversationId, [summary.topLabel]);
        const speaker = this.store.getSpeaker(summary.topLabel);
        if (speaker) {
          const updatedEntries = await this.store.updateTranscriptSpeakerLabels({
            conversationId: buffer.conversationId,
            chunkIds: buffer.chunkIds,
            diarizationSpeaker: buffer.diarizationSpeaker,
            speakerLabel: speaker.name,
          });
          await this.refreshAgentContextEntries(buffer.conversationId, updatedEntries);
        }
        completed = true;
        return;
      }

      if (buffer.speechSeconds >= this.config.unknownMinSpeechSeconds) {
        const coherence = await this.validateUnknownSampleCoherence(compiledPath, buffer);
        summary.coherenceMinPairwise = coherence.minPairwise;
        summary.coherenceMeanPairwise = coherence.meanPairwise;
        summary.coherenceWindows = coherence.windows;
        if (!coherence.ok) {
          summary.rejectedReason = coherence.reason;
          warnRealtime(
            'Rejected mixed unknown speaker sample',
            `${buffer.id}: ${coherence.reason}; min=${coherence.minPairwise.toFixed(3)} mean=${coherence.meanPairwise.toFixed(3)} windows=${coherence.windows}`,
          );
          completed = true;
          return;
        }

        const diarizationSpeaker = buffer.diarizationSpeaker || 'UNKNOWN';
        const samplePath = this.store.getPendingSamplePath(diarizationSpeaker);
        await convertToSpeakerSampleWav(compiledPath, samplePath, this.config.speakerSampleMaxSeconds);
        const finalEmbedding = await this.embedAudioToFile(samplePath, embeddingPath).catch(() => embedded);
        await this.store.addPendingSpeaker({
          conversationId: buffer.conversationId,
          diarizationSpeaker,
          samplePath,
          embeddingPath: finalEmbedding?.path,
          embeddingModel: finalEmbedding?.model,
          speechSeconds: Math.min(buffer.speechSeconds, this.config.speakerSampleMaxSeconds),
          confidenceSummary: {
            ...summary,
            cleanSpeechSeconds: buffer.speechSeconds,
            agreeingSegments: buffer.chunkIds.length,
          },
        });
      }
      completed = true;
    } finally {
      if (completed) {
        await this.store.removeUnknownBuffer(buffer.id);
      }
    }
  }

  private async recoverUnknownBuffersAtStartup(): Promise<void> {
    const buffers = Object.values(this.store.getStateSnapshot().unknownBuffers)
      .filter((buffer) => buffer.speechSeconds >= this.config.unknownMinSpeechSeconds);

    for (const buffer of buffers) {
      await this.evaluateUnknownBuffer(buffer.id).catch((error) => {
        warnRealtime(
          'Startup unknown speaker recovery failed',
          `${buffer.id}: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    }
  }

  private async recoverOrphanUnknownSamplesAtStartup(): Promise<void> {
    const conversation = this.store.getCurrentConversation();
    if (!conversation) {
      return;
    }

    const snapshot = this.store.getStateSnapshot();
    const referencedPaths = new Set<string>();
    for (const buffer of Object.values(snapshot.unknownBuffers)) {
      for (const audioPath of buffer.audioPaths) {
        referencedPaths.add(path.resolve(audioPath).toLowerCase());
      }
    }
    for (const proposal of Object.values(snapshot.pendingSpeakers)) {
      referencedPaths.add(path.resolve(proposal.samplePath).toLowerCase());
    }

    let names: string[] = [];
    try {
      names = await readdir(this.store.tempDir);
    } catch {
      return;
    }

    for (const name of names) {
      if (!/^unknown-.+\.wav$/i.test(name)) {
        continue;
      }

      const sourcePath = path.join(this.store.tempDir, name);
      if (referencedPaths.has(path.resolve(sourcePath).toLowerCase())) {
        continue;
      }

      try {
        const info = await stat(sourcePath);
        if (!info.isFile()) {
          continue;
        }

        const duration = await getAudioDurationSeconds(sourcePath);
        if (duration < this.config.unknownMinSpeechSeconds) {
          continue;
        }

        const diarizationSpeaker = path.parse(name).name.replace(/^unknown-/, '') || 'recovered_unknown';
        const samplePath = this.store.getPendingSamplePath(diarizationSpeaker);
        await convertToSpeakerSampleWav(sourcePath, samplePath, this.config.speakerSampleMaxSeconds);
        await this.store.addPendingSpeaker({
          conversationId: conversation.id,
          diarizationSpeaker,
          samplePath,
          speechSeconds: Math.min(duration, this.config.speakerSampleMaxSeconds),
          confidenceSummary: {
            cleanSpeechSeconds: duration,
            agreeingSegments: 1,
          },
        });
        await unlink(sourcePath).catch(() => undefined);
        logRealtime('Recovered orphan unknown speaker sample', `${name} -> ${path.basename(samplePath)}`);
      } catch (error) {
        warnRealtime(
          'Orphan unknown speaker recovery failed',
          `${name}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  private async sendNewTranscriptToAgent(conversation: ConversationRecord): Promise<string> {
    const newEntries = conversation.entries.filter((entry) =>
      conversation.agent.sentEntryRevisions[entry.id] !== entry.revision
    );
    if (newEntries.length === 0) {
      return this.runAgentWithConversation(
        conversation.id,
        'Immediate advice requested, but no new transcript lines are available. Use the current conversation context.',
        [],
      );
    }

    const message = this.formatAdviceMessage(conversation, newEntries);
    return this.runAgentWithConversation(conversation.id, message, newEntries);
  }

  private async runAgentWithConversation(
    conversationId: string | undefined,
    message: string,
    sentEntries: TranscriptEntry[],
  ): Promise<string> {
    const run = this.agentQueue.then(async () => {
      await this.ensureAgentReady();
      if (!this.agent || !this.agentSandbox) {
        throw new Error('Realtime advisor agent is not ready.');
      }

      const conversation = conversationId ? this.store.getConversation(conversationId) : undefined;
      let latestSnapshot: SessionSnapshot | undefined = conversation?.agent.snapshot;
      const sentEntryRevisions = {
        ...(conversation?.agent.sentEntryRevisions || {}),
      };
      for (const entry of sentEntries) {
        sentEntryRevisions[entry.id] = entry.revision;
      }

      const session = await this.getOrCreateAgentSession(conversationId, latestSnapshot);
      const continuingActiveTurn = session.hasActiveTurn();
      const executionMessage = continuingActiveTurn
        ? (session.getActiveTurnUserMessage() || message)
        : message;
      if (!continuingActiveTurn) {
        session.beginTurn(message, 'user');
      }

      const display = getGlobalDisplay() || new StreamDisplay();
      const displayDepth = 0;
      display.setDepth(displayDepth);
      display.showAgentStart(this.agent.config.name, displayDepth);

      const callbacks: ExecutorCallbacks = {
        onReasoningDelta: (delta) => {
          display.startReasoning();
          display.writeReasoning(delta);
        },
        onReasoningDone: () => {
          display.endReasoning();
        },
        onTextDelta: (delta) => {
          display.startText();
          display.writeText(delta);
        },
        onTextDone: (fullText) => {
          display.endText();
          session.recordVisibleAssistantOutput(fullText);
        },
        onAction: (code) => {
          display.showAction(code);
        },
        onCli: (command) => {
          display.showAction(command);
        },
        onFile: (filename, content) => {
          display.showAction(`file: ${filename}\n${content}`);
        },
        onObservation: (output) => {
          display.showObservation(output);
        },
        onBeforeProviderCall: () => {
          display.reset();
        },
        onResponse: (content) => {
          session.recordVisibleAssistantOutput(content);
        },
      };
      const executor = new Executor(session, {
        maxIterations: 500,
        stream: false,
        callbacks,
        requireFinish: this.agent.config.requireFinish,
        onCheckpoint: (snapshot) => {
          latestSnapshot = snapshot;
        },
      });

      let response: string;
      try {
        response = await runWithAgentContext(
          this.agent.config.name,
          () => executor.execute(executionMessage, { continueActiveTurn: continuingActiveTurn }),
          callbacks,
          false,
          this.agentSandbox,
          this.agent.config.modelSwitching,
          this.agent,
        );
        display.showAgentComplete(this.agent.config.name, response, displayDepth);
      } catch (error) {
        display.showAgentError(
          this.agent.config.name,
          error instanceof Error ? error.message : String(error),
          displayDepth,
        );
        throw error;
      } finally {
        session.endTurn();
        latestSnapshot = session.exportSnapshot();
      }

      if (conversationId) {
        await this.store.updateConversationAgent(conversationId, {
          snapshot: latestSnapshot,
          sentEntryRevisions,
          lastAdviceAt: new Date().toISOString(),
        });
      }
      return response;
    });

    this.agentQueue = run.catch(() => undefined);
    return run;
  }

  private async replaceAgentContextEntries(
    conversationId: string,
    removedQuickEntries: TranscriptEntry[],
    insertedEntries: TranscriptEntry[],
  ): Promise<void> {
    if (removedQuickEntries.length === 0 || insertedEntries.length === 0) {
      return;
    }
    const conversation = this.store.getConversation(conversationId);
    const snapshot = conversation?.agent.snapshot;
    if (!conversation || !snapshot) {
      return;
    }

    let changed = false;
    const sentEntryRevisions = { ...conversation.agent.sentEntryRevisions };
    for (const removed of removedQuickEntries) {
      if (!sentEntryRevisions[removed.id]) {
        continue;
      }
      const replacement = insertedEntries.map((entry) => this.formatEntryBlock(entry)).join('\n');
      for (const message of snapshot.messages) {
        if (message.role !== 'user') {
          continue;
        }
        const nextContent = this.replaceMarkedBlock(message.content, removed.agentMarker, replacement);
        if (nextContent !== message.content) {
          message.content = nextContent;
          changed = true;
        }
      }
      delete sentEntryRevisions[removed.id];
      for (const inserted of insertedEntries) {
        sentEntryRevisions[inserted.id] = inserted.revision;
      }
    }

    if (changed) {
      await this.store.updateConversationAgent(conversationId, {
        snapshot,
        sentEntryRevisions,
        lastAdviceAt: conversation.agent.lastAdviceAt,
      });
      this.invalidateAgentSession(conversationId);
    }
  }

  private async refreshAgentContextEntries(conversationId: string, updatedEntries: TranscriptEntry[]): Promise<void> {
    if (updatedEntries.length === 0) {
      return;
    }

    const conversation = this.store.getConversation(conversationId);
    const snapshot = conversation?.agent.snapshot;
    if (!conversation || !snapshot) {
      return;
    }

    let changed = false;
    const sentEntryRevisions = { ...conversation.agent.sentEntryRevisions };
    for (const entry of updatedEntries) {
      if (!sentEntryRevisions[entry.id]) {
        continue;
      }

      const replacement = this.formatEntryBlock(entry);
      for (const message of snapshot.messages) {
        if (message.role !== 'user') {
          continue;
        }
        const nextContent = this.replaceMarkedBlock(message.content, entry.agentMarker, replacement);
        if (nextContent !== message.content) {
          message.content = nextContent;
          changed = true;
        }
      }
      sentEntryRevisions[entry.id] = entry.revision;
    }

    if (changed) {
      await this.store.updateConversationAgent(conversationId, {
        snapshot,
        sentEntryRevisions,
        lastAdviceAt: conversation.agent.lastAdviceAt,
      });
      this.invalidateAgentSession(conversationId);
    }
  }

  private replaceMarkedBlock(content: string, marker: string, replacement: string): string {
    const start = `<!-- telos-live-entry:start ${marker} -->`;
    const end = `<!-- telos-live-entry:end ${marker} -->`;
    const startIndex = content.indexOf(start);
    const endIndex = content.indexOf(end, startIndex + start.length);
    if (startIndex < 0 || endIndex < 0) {
      return content;
    }
    const afterIndex = endIndex + end.length;
    return `${content.slice(0, startIndex)}${replacement}${content.slice(afterIndex)}`;
  }

  private formatAdviceMessage(conversation: ConversationRecord, entries: TranscriptEntry[]): string {
    const header = [
      'Live conversation update for immediate advice.',
      `Conversation: ${conversation.id}`,
      `Conversation started: ${formatTimecode(conversation.startedAt)}`,
      'Only the transcript entries below are new or changed; earlier entries are already in this session context.',
      '',
      '<telos-live-transcript>',
    ].join('\n');
    const body = entries.map((entry) => this.formatEntryBlock(entry)).join('\n');
    return `${header}\n${body}\n</telos-live-transcript>\n\nRespond with the shortest useful advice for the current moment.`;
  }

  private formatEntryBlock(entry: TranscriptEntry): string {
    return [
      `<!-- telos-live-entry:start ${entry.agentMarker} -->`,
      `[${formatTimecode(entry.startTime)}] ${entry.speakerLabel}: ${entry.text}`,
      `<!-- telos-live-entry:end ${entry.agentMarker} -->`,
    ].join('\n');
  }

  private formatConversationTranscript(conversation: ConversationRecord): string {
    const lines = [
      `[Conversation ${conversation.id}; started ${formatTimecode(conversation.startedAt)}]`,
      ...conversation.entries.map((entry) => `${entry.speakerLabel}: ${entry.text}`),
    ];
    return lines.join('\n');
  }

  private async refreshSpeakerEmbeddingsAtStartup(): Promise<void> {
    for (const speaker of this.store.listSpeakers()) {
      if (!speaker.samplePath || !existsSync(speaker.samplePath)) {
        warnRealtime('Speaker sample missing', `${speaker.name} (${speaker.id})`);
        continue;
      }
      if (speaker.embeddingPath && existsSync(speaker.embeddingPath)) {
        continue;
      }
      try {
        const embeddingPath = this.store.getSpeakerEmbeddingPathForName(speaker.name);
        const embedded = await this.embedAudioToFile(speaker.samplePath, embeddingPath);
        if (!embedded) {
          continue;
        }
        await this.store.updateSpeakerEmbedding({
          speakerId: speaker.id,
          embeddingPath: embedded.path,
          embeddingModel: embedded.model,
        });
        logRealtime('Speaker embedding refreshed', speaker.name);
      } catch (error) {
        warnRealtime('Speaker embedding refresh failed', `${speaker.name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  private async createSpeakerFromSample(input: {
    name: string;
    description?: string;
    sourceBuffer: Buffer;
    sourceName?: string;
  }): Promise<SpeakerRecord> {
    const rawPath = path.join(this.store.tempDir, `${Date.now()}-${sanitizeFileName(input.sourceName || input.name)}`);
    await mkdir(path.dirname(rawPath), { recursive: true });
    await writeFile(rawPath, input.sourceBuffer);
    const samplePath = this.store.getSpeakerSamplePathForName(input.name);
    await convertToSpeakerSampleWav(rawPath, samplePath, this.config.speakerSampleMaxSeconds);
    const embedded = await this.embedAudioToFile(samplePath, this.store.getSpeakerEmbeddingPathForName(input.name));
    return this.store.createSpeaker({
      name: input.name,
      description: input.description,
      samplePath,
      embeddingPath: embedded?.path,
      embeddingModel: embedded?.model,
    });
  }

  private async resolvePendingSpeaker(resolution: SpeakerResolutionRequest): Promise<Record<string, unknown>> {
    const tempId = String(resolution.tempId || '').trim();
    const proposal = this.store.getStateSnapshot().pendingSpeakers[tempId];
    if (!proposal) {
      throw new Error(`Unknown pending speaker temp id: ${tempId}`);
    }
    if (resolution.dismiss) {
      await this.store.resolvePendingSpeaker(tempId, undefined, true);
      return { tempId, dismissed: true };
    }

    const existing = this.findExistingSpeaker(resolution);
    if (existing) {
      const outputPath = this.store.getSpeakerSamplePathForName(existing.name);
      await appendAndTrimVoiceSample(
        existing.samplePath,
        proposal.samplePath,
        outputPath,
        this.store.tempDir,
        this.config.speakerSampleMaxSeconds,
      );
      const embedded = await this.embedAudioToFile(outputPath, this.store.getSpeakerEmbeddingPathForName(existing.name));
      const speaker = await this.store.updateSpeakerSampleAndEmbedding({
        speakerId: existing.id,
        samplePath: outputPath,
        embeddingPath: embedded?.path,
        embeddingModel: embedded?.model,
        description: resolution.description ?? existing.description,
      });
      await this.store.resolvePendingSpeaker(tempId, existing.id, false);
      return { tempId, speaker: speaker ? this.publicSpeakerPayload(speaker) : undefined, merged: true };
    }

    const name = String(resolution.name || '').trim();
    if (!name) {
      throw new Error(`Resolution ${tempId} must include name or existingSpeakerId.`);
    }
    const samplePath = this.store.getSpeakerSamplePathForName(name);
    await copyFile(proposal.samplePath, samplePath);
    const embedded = await this.embedAudioToFile(samplePath, this.store.getSpeakerEmbeddingPathForName(name));
    const speaker = await this.store.createSpeaker({
      name,
      description: resolution.description,
      samplePath,
      embeddingPath: embedded?.path,
      embeddingModel: embedded?.model,
    });
    await this.store.resolvePendingSpeaker(tempId, speaker.id, false);
    return { tempId, speaker: this.publicSpeakerPayload(speaker), merged: false };
  }

  private findExistingSpeaker(resolution: SpeakerResolutionRequest): SpeakerRecord | undefined {
    if (resolution.existingSpeakerId) {
      return this.store.getSpeaker(String(resolution.existingSpeakerId));
    }
    const requestedName = String(resolution.name || '').trim().toLowerCase();
    if (!requestedName) {
      return undefined;
    }
    return this.store.listSpeakers().find((speaker) => speaker.name.trim().toLowerCase() === requestedName);
  }

  private pendingSpeakerPayloads(conversationId?: string, onlyUndelivered = false): Array<Record<string, unknown>> {
    const conversation = conversationId ? this.store.getConversation(conversationId) : undefined;
    return this.store.listPendingSpeakers()
      .filter((proposal) => !conversationId || proposal.conversationId === conversationId)
      .filter((proposal) => !onlyUndelivered || !conversation?.deliveredProposalIds.includes(proposal.id))
      .map((proposal) => this.publicPendingSpeakerPayload(proposal));
  }

  private publicPendingSpeakerPayload(proposal: PendingSpeakerProposal): Record<string, unknown> {
    return {
      ...proposal,
      sampleUrl: this.sampleUrl(proposal.samplePath, 'pending'),
    };
  }

  private publicSpeakerPayload(speaker: SpeakerRecord): Record<string, unknown> {
    return {
      id: speaker.id,
      name: speaker.name,
      description: speaker.description,
      createdAt: speaker.createdAt,
      updatedAt: speaker.updatedAt,
      usageCount: speaker.usageCount,
      lastSeenAt: speaker.lastSeenAt,
      hasEmbedding: !!speaker.embeddingPath,
      embeddingCreatedAt: speaker.embeddingCreatedAt,
      embeddingModel: speaker.embeddingModel,
      sampleUrl: this.sampleUrl(speaker.samplePath, 'speakers'),
    };
  }

  private sampleUrl(samplePath: string, kind: 'pending' | 'speakers'): string {
    const fileName = encodeURIComponent(path.basename(samplePath));
    const base = this.baseUrl || `http://localhost:${this.config.port}`;
    return `${base}/samples/${kind}/${fileName}`;
  }
}
