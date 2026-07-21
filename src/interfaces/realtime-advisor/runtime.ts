import express from 'express';
import multer from 'multer';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import { networkInterfaces } from 'os';
import { spawn, type ChildProcess } from 'child_process';
import path from 'path';
import { copyFile, mkdir, readdir, rm, stat, unlink, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import open from 'open';
import localtunnel, { type LocalTunnel } from 'localtunnel';
import { AgentLoader } from '../../loaders/AgentLoader.js';
import { ToolLoader } from '../../loaders/ToolLoader.js';
import { createSandbox } from '../../sandbox/index.js';
import type { ISandbox } from '../../sandbox/interfaces.js';
import {
  TelosLinkCommunicationHub,
  type TelosLinkAudioChunkInput,
  type TelosLinkPublishInput,
} from '../../services/telos-link/index.js';
import { runWithAgentContext } from '../../core/AgentContext.js';
import { actionContext } from '../../core/ActionContext.js';
import { getGlobalDisplay } from '../../core/GlobalDisplay.js';
import { Executor, type ExecutorCallbacks } from '../../core/Executor.js';
import { Session, type SessionSnapshot } from '../../core/Session.js';
import { buildTextSessionComponents } from '../../core/SessionFactory.js';
import { StreamDisplay } from '../../cli/display.js';
import type { AgentInterfaceRuntime, InterfaceRouteHandler, InterfaceRuntimeContext } from '../base.js';
import type { LoadedAgent } from '../../types/index.js';
import { AssemblyAiClient } from './assemblyai.js';
import { RealtimeAdvisorStore } from './store.js';
import { renderRealtimeAdvisorClientHtml } from './client-html.js';
import { getContentMemoryService } from '../../content_memory/service.js';
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
  type AutomaticTriggerState,
  type AdvisorInstructionsState,
  type ConversationLogRecord,
  type ConversationRecord,
  type DiarizationSegment,
  type PendingSpeakerProposal,
  type AssemblyAiDiarizationOutput,
  type RealtimeAdvisorConfig,
  type RealtimeAdvisorTunnelProvider,
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

interface PendingTelosResponse {
  resolve: (value: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
  startedAt: number;
}

interface CachedTelosResponse {
  payload: Record<string, unknown>;
  receivedAt: number;
  requestId: string;
}

interface AdvisorSessionCacheEntry {
  session: Session;
}

interface AdviceTriggerContext {
  kind: 'manual' | 'automatic';
  condition?: string;
  queuedAt?: number;
}

const ADVISOR_INSTRUCTIONS_HEADER = '## Current Realtime Advisor Situation And Instructions';

const UNKNOWN_BUFFER_MATCH_SCORE = 0.35;
const UNKNOWN_COHERENCE_MIN_PAIRWISE = 0.18;
const UNKNOWN_COHERENCE_MEAN_PAIRWISE = 0.30;
const UNKNOWN_COHERENCE_WINDOW_SECONDS = 3.5;
const UNKNOWN_COHERENCE_MIN_WINDOW_SECONDS = 2.0;
const UNKNOWN_COHERENCE_MAX_WINDOWS = 8;
const CONVERSATION_RETENTION_MS = 31 * 24 * 60 * 60 * 1000;
const UTF8_MOJIBAKE_MARKER_RE = /[ÃÂÐÑ][\u0080-\u00ff]/;
const CYRILLIC_RE = /[\u0400-\u04ff]/;

interface RegisteredIncomingChunk {
  chunk: StoredAudioChunk;
  conversation: ConversationRecord;
  triggerState: AutomaticTriggerState;
  metadata: RealtimeChunkMetadata;
  quickAlreadyHandled?: boolean;
}

function repairUtf8Mojibake(text: string): string {
  if (!UTF8_MOJIBAKE_MARKER_RE.test(text)) {
    return text;
  }

  const repaired = Buffer.from(text, 'latin1').toString('utf8');
  if (!CYRILLIC_RE.test(repaired)) {
    return text;
  }

  const originalMarkerCount = (text.match(UTF8_MOJIBAKE_MARKER_RE) || []).length;
  const repairedMarkerCount = (repaired.match(UTF8_MOJIBAKE_MARKER_RE) || []).length;
  return repairedMarkerCount <= originalMarkerCount ? repaired : text;
}

function isExpectedHttpAbort(error: unknown): boolean {
  const err = error as { code?: unknown; type?: unknown; message?: unknown };
  const code = typeof err?.code === 'string' ? err.code : '';
  const type = typeof err?.type === 'string' ? err.type : '';
  const message = String(err?.message || '').toLowerCase();
  return code === 'ECONNRESET'
    || type === 'request.aborted'
    || message === 'aborted'
    || message.includes('request aborted')
    || message.includes('socket hang up');
}

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

function readTunnelProvider(): RealtimeAdvisorTunnelProvider {
  const raw = (process.env.TELOS_REALTIME_ADVISOR_TUNNEL
    || process.env.TELOS_REALTIME_ADVISOR_TUNNEL_PROVIDER
    || '').trim().toLowerCase();
  if (raw === 'localhost-run' || raw === 'localhost.run' || raw === 'ssh') {
    return 'localhost-run';
  }
  if (raw === 'localtunnel' || raw === 'locatunnel' || raw === 'lt' || raw === 'auto') {
    return 'localtunnel';
  }
  if (raw === 'off' || raw === 'disabled' || raw === 'false' || raw === '0') {
    return 'off';
  }
  return 'off';
}

function isPrivateIpv4(address: string): boolean {
  const parts = address.split('.').map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false;
  }
  const a = parts[0]!;
  const b = parts[1]!;
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

function detectLanIpv4(): string | undefined {
  const candidates: string[] = [];
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries || []) {
      if (entry.family !== 'IPv4' || entry.internal) {
        continue;
      }
      candidates.push(entry.address);
    }
  }
  return candidates.find((address) => address.startsWith('192.168.'))
    || candidates.find((address) => address.startsWith('10.'))
    || candidates.find((address) => {
      const second = Number(address.split('.')[1]);
      return address.startsWith('172.') && Number.isInteger(second) && second >= 16 && second <= 31;
    })
    || candidates.find(isPrivateIpv4)
    || candidates[0];
}

function readTelosLinkAdvertiseHost(): string | undefined {
  return (process.env.TELOS_LINK_ADVERTISE_HOST
    || process.env.TELOS_REALTIME_ADVISOR_LINK_HOST
    || '').trim() || undefined;
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

function extractTranscriptTurns(output: AssemblyAiDiarizationOutput | undefined): TurnLevelTranscript[] {
  const turns = output?.utterances;
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

function extractDiarizationSegments(output: AssemblyAiDiarizationOutput | undefined): DiarizationSegment[] {
  return Array.isArray(output?.utterances)
    ? output.utterances.map((utterance) => ({
      speaker: utterance.speaker,
      start: utterance.start,
      end: utterance.end,
    }))
    : [];
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
    assemblyAiApiKey: process.env.ASSEMBLYAI_API_KEY || process.env.ASSEMBLY_AI_API_KEY,
    assemblyAiApiBaseUrl: process.env.ASSEMBLYAI_API_BASE_URL || 'https://api.assemblyai.com',
    mockAssemblyAi: readBooleanEnv('TELOS_REALTIME_ADVISOR_MOCK_ASSEMBLYAI', false),
    autoOpenClient: readBooleanEnv('TELOS_REALTIME_ADVISOR_OPEN_CLIENT', false),
    maxUploadBytes: Math.max(1, readNumberEnv('TELOS_REALTIME_ADVISOR_MAX_UPLOAD_BYTES', 24 * 1024 * 1024)),
    localhostRunEnabled: readBooleanEnv('TELOS_REALTIME_ADVISOR_LOCALHOST_RUN', false),
    localhostRunHost: process.env.TELOS_REALTIME_ADVISOR_LOCALHOST_RUN_HOST || 'nokey@localhost.run',
    tunnelProvider: readTunnelProvider(),
    localtunnelHost: process.env.TELOS_REALTIME_ADVISOR_LOCALTUNNEL_HOST || 'https://localtunnel.me',
    localtunnelSubdomain: process.env.TELOS_REALTIME_ADVISOR_LOCALTUNNEL_SUBDOMAIN,
    localtunnelLocalHost: process.env.TELOS_REALTIME_ADVISOR_LOCALTUNNEL_LOCAL_HOST || '127.0.0.1',
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
  private readonly communication: TelosLinkCommunicationHub;
  private readonly assemblyAi: AssemblyAiClient;
  private readonly ecapa: EcapaEmbeddingService;
  private readonly app = express();
  private readonly upload: multer.Multer;
  private server: Server | null = null;
  private baseUrl = '';
  private localBaseUrl = '';
  private linkBaseUrl = '';
  private publicUrl = '';
  private tunnelStatus: 'disabled' | 'starting' | 'online' | 'failed' | 'stopped' = 'disabled';
  private tunnelError = '';
  private tunnelProcess: ChildProcess | null = null;
  private localTunnel: LocalTunnel | null = null;
  private tunnelGeneration = 0;
  private routeRegistered = false;
  private agent: LoadedAgent | null = null;
  private agentSandbox: ISandbox | null = null;
  private agentSessions = new Map<string, AdvisorSessionCacheEntry>();
  private agentQueue: Promise<unknown> = Promise.resolve();
  private debounceTimer: NodeJS.Timeout | null = null;
  private debounceTimerConversationId: string | null = null;
  private debounceTimerChunkId: string | null = null;
  private automaticTriggerInFlightKey: string | null = null;
  private activeChunkProcessingCount = 0;
  private readonly pendingChunkProcessingIds: string[] = [];
  private readonly queuedChunkProcessingIds = new Set<string>();
  private readonly adviceInFlightConversations = new Set<string>();
  private readonly coalescedAdviceTriggers = new Map<string, AdviceTriggerContext>();
  private readonly pendingSmartphoneDataReads = new Map<string, PendingTelosResponse>();
  private readonly pendingMusicHistoryReads = new Map<string, PendingTelosResponse>();
  private readonly duplicateAudioLogTimes = new Map<string, number>();
  private latestSmartphoneDataResponse: CachedTelosResponse | null = null;

  constructor(config: Partial<RealtimeAdvisorConfig> = {}) {
    this.config = {
      ...createDefaultConfig(),
      ...config,
    };
    if (config.localhostRunEnabled === false && config.tunnelProvider === undefined) {
      this.config.tunnelProvider = 'off';
    }
    this.store = new RealtimeAdvisorStore(this.config.dataDir);
    this.communication = new TelosLinkCommunicationHub(path.join(this.config.dataDir, 'telos-link'), {
      onAudioChunk: (input) => this.acceptTelosLinkAudioChunk(input),
      onQuickTranscript: (input) => this.acceptTelosLinkQuickTranscript(input),
      onSpeakerResolution: async (input) => {
        const resolutions = Array.isArray(input.resolutions)
          ? input.resolutions as SpeakerResolutionRequest[]
          : input.resolution
            ? [input.resolution as SpeakerResolutionRequest]
            : [];
        for (const resolution of resolutions) {
          await this.resolvePendingSpeaker(resolution);
        }
      },
      onAdviceTrigger: async () => {
        const conversation = this.store.getCurrentConversation();
        if (conversation) {
          this.queueAdviceTrigger(conversation.id, { kind: 'manual' });
        }
      },
      onSmartphoneDataResponse: async (input) => {
        this.resolveSmartphoneDataRead(input);
      },
      onMusicHistoryResponse: async (input) => {
        this.resolveMusicHistoryRead(input);
      },
    });
    this.assemblyAi = new AssemblyAiClient({
      apiKey: this.config.assemblyAiApiKey,
      apiBaseUrl: this.config.assemblyAiApiBaseUrl,
      mock: this.config.mockAssemblyAi,
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
    await this.communication.initialize();
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
    this.scheduleDebounceTriggerFromCurrentState();
  }

  async stop(): Promise<void> {
    this.clearDebounceTimer();
    await this.stopLocalhostRunTunnel();
    await this.communication.close();
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

  private buildAdvisorAgentForCurrentInstructions(): LoadedAgent {
    if (!this.agent) {
      throw new Error('Realtime advisor agent is not ready.');
    }
    const instructions = this.store.getAdvisorInstructions().text.trim();
    if (!instructions) {
      return this.agent;
    }
    return {
      ...this.agent,
      config: {
        ...this.agent.config,
      },
      systemPromptContent: [
        this.agent.systemPromptContent.trim(),
        ADVISOR_INSTRUCTIONS_HEADER,
        instructions,
      ].filter(Boolean).join('\n\n'),
    };
  }

  private rebuildCachedAgentSessions(): void {
    if (!this.agent) {
      return;
    }
    const advisorAgent = this.buildAdvisorAgentForCurrentInstructions();
    for (const entry of this.agentSessions.values()) {
      entry.session.rebuildPrompt(advisorAgent);
    }
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

    const advisorAgent = this.buildAdvisorAgentForCurrentInstructions();
    const components = await buildTextSessionComponents(advisorAgent, this.toolLoader);
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
    await this.runAgentWithConversation(
      conversation.id,
      this.formatAdviceMessage(conversation, [syntheticEntry], { kind: 'manual' }),
      [],
    );
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
    this.communication.mount(this.app);
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
        assemblyAiEnabled: this.assemblyAi.isEnabled() && !this.assemblyAi.isMock(),
        mockAssemblyAi: this.assemblyAi.isMock(),
        ecapa: {
          model: ECAPA_MODEL_ID,
          available: this.ecapa.isAvailable(),
          device: this.config.ecapaDevice,
          modelCache: this.config.ecapaModelCache,
        },
        baseUrl: this.baseUrl,
        localUrl: this.localBaseUrl,
        linkUrl: this.linkBaseUrl || undefined,
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
        automaticTrigger: this.publicAutomaticTriggerPayload(this.store.getAutomaticTrigger()),
        advisorInstructions: this.publicAdvisorInstructionsPayload(this.store.getAdvisorInstructions()),
        logs: this.store.listLogs(20),
        baseUrl: this.baseUrl,
        localUrl: this.localBaseUrl,
        linkUrl: this.linkBaseUrl || undefined,
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

    this.app.get('/v1/context/trigger', (_req, res) => {
      const trigger = this.store.getAutomaticTrigger();
      res.json({
        success: true,
        trigger,
        formatted: this.formatAutomaticTriggerState(trigger),
      });
    });

    this.app.post('/v1/context/trigger', async (req, res): Promise<void> => {
      try {
        const type = String(req.body?.type || '').trim();
        const value = Number(req.body?.value);
        const trigger = await this.store.setAutomaticTrigger(type, value);
        this.scheduleDebounceTriggerFromCurrentState();
        res.json({
          success: true,
          trigger,
          formatted: this.formatAutomaticTriggerState(trigger),
        });
      } catch (error) {
        res.status(400).json({ success: false, error: error instanceof Error ? error.message : String(error) });
      }
    });

    this.app.get('/v1/context/logs', (req, res) => {
      const maxResults = Number(req.query.maxResults);
      const logs = this.store.listLogs(Number.isFinite(maxResults) ? maxResults : 20);
      res.json({
        success: true,
        logs,
        formatted: this.formatConversationLogs(logs),
      });
    });

    this.app.post('/v1/context/logs', async (req, res): Promise<void> => {
      try {
        const record = await this.store.addLog(String(req.body?.text || req.body?.log || ''));
        void this.persistAdvisorContextLog(record).catch((error) => {
          warnRealtime('Advisor context content-memory persist failed', error instanceof Error ? error.message : String(error));
        });
        res.json({ success: true, log: record });
      } catch (error) {
        res.status(400).json({ success: false, error: error instanceof Error ? error.message : String(error) });
      }
    });

    this.app.get('/v1/context/instructions', (_req, res) => {
      const instructions = this.store.getAdvisorInstructions();
      res.json({
        success: true,
        instructions,
        text: instructions.text,
        formatted: this.formatAdvisorInstructions(instructions),
      });
    });

    this.app.post('/v1/context/instructions', async (req, res): Promise<void> => {
      try {
        const text = String(req.body?.text ?? req.body?.instructions ?? '');
        const instructions = await this.store.setAdvisorInstructions(text);
        this.rebuildCachedAgentSessions();
        res.json({
          success: true,
          instructions,
          text: instructions.text,
          formatted: this.formatAdvisorInstructions(instructions),
        });
      } catch (error) {
        res.status(400).json({ success: false, error: error instanceof Error ? error.message : String(error) });
      }
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
        const registered = await this.registerIncomingAudioChunk({
          file: req.file,
          body: req.body || {},
        });
        res.json({ success: true });
        if (registered) {
          void this.afterIncomingAudioChunk(registered)
            .catch((error) => warnRealtime('Post-response audio chunk work failed', error instanceof Error ? error.message : String(error)));
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (res.headersSent) {
          warnRealtime('Post-response chunk work failed', message);
          return;
        }
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

    this.app.post('/v1/telos/smartphone/automation', async (req, res): Promise<void> => {
      try {
        const xml = String(req.body?.xml || '').trim();
        if (!xml) {
          res.status(400).json({ success: false, error: 'xml is required.' });
          return;
        }
        const kind = String(req.body?.kind || '').trim() === 'project' ? 'project' : 'task';
        const requestId = String(req.body?.requestId || `automation_${Date.now()}`);
        await this.emitCommunicationEvent({
          type: 'telos.smartphone.automation.request',
          priority: 'high',
          payload: {
            requestId,
            kind,
            xml,
            fileName: typeof req.body?.fileName === 'string' ? req.body.fileName : undefined,
          },
        });
        res.json({ success: true, requestId, kind });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        res.status(500).json({ success: false, error: message });
      }
    });

    this.app.post('/v1/telos/smartphone/read-data', async (req, res): Promise<void> => {
      const requestId = String(req.body?.requestId || `read_${Date.now()}_${Math.random().toString(16).slice(2)}`);
      const timeoutMs = Math.max(1_000, Math.min(120_000, Number(req.body?.timeoutMs) || 60_000));
      try {
        const resultPromise = this.waitForSmartphoneDataRead(requestId, timeoutMs);
        await this.emitCommunicationEvent({
          type: 'telos.smartphone.data.read.request',
          priority: 'high',
          payload: { requestId },
          ttlMs: timeoutMs,
        });
        const result = await resultPromise;
        res.json({ success: true, requestId, ...result });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        res.status(504).json({ success: false, requestId, error: message });
      }
    });

    this.app.post('/v1/telos/music/start', async (req, res): Promise<void> => {
      try {
        const moodInstruction = String(req.body?.moodInstruction || req.body?.mood || '').trim();
        if (!moodInstruction) {
          res.status(400).json({ success: false, error: 'moodInstruction is required.' });
          return;
        }
        const requestId = String(req.body?.requestId || `music_start_${Date.now()}`);
        await this.emitCommunicationEvent({
          type: 'telos.music.start.request',
          priority: 'high',
          payload: { requestId, moodInstruction },
        });
        res.json({ success: true, requestId, accepted: true });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        res.status(500).json({ success: false, error: message });
      }
    });

    this.app.post('/v1/telos/music/history', async (req, res): Promise<void> => {
      const requestId = String(req.body?.requestId || `music_history_${Date.now()}_${Math.random().toString(16).slice(2)}`);
      const timeoutMs = Math.max(1_000, Math.min(120_000, Number(req.body?.timeoutMs) || 30_000));
      const limit = Math.max(1, Math.min(200, Number(req.body?.limit) || 25));
      try {
        const resultPromise = this.waitForMusicHistoryRead(requestId, timeoutMs);
        await this.emitCommunicationEvent({
          type: 'telos.music.history.request',
          priority: 'high',
          payload: { requestId, limit },
          ttlMs: timeoutMs,
        });
        const result = await resultPromise;
        res.json({ success: true, requestId, ...result });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        res.status(504).json({ success: false, requestId, error: message });
      }
    });

    this.app.post('/v1/telos/advisor/call', async (req, res): Promise<void> => {
      try {
        const instruction = String(req.body?.instruction || req.body?.message || req.body?.text || '').trim();
        if (!instruction) {
          res.status(400).json({ success: false, error: 'instruction is required.' });
          return;
        }
        const response = await this.callAdvisorFromTelos(instruction);
        res.json({ success: true, response });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        res.status(500).json({ success: false, error: message });
      }
    });

    this.app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      if (isExpectedHttpAbort(error)) {
        if (!res.headersSent) {
          res.status(499).json({ success: false, error: 'Client closed request.' });
        }
        return;
      }

      const message = error instanceof Error ? error.message : String(error);
      warnRealtime('HTTP request failed', message);
      if (!res.headersSent) {
        res.status(500).json({ success: false, error: message });
      }
    });
  }

  private waitForSmartphoneDataRead(requestId: string, timeoutMs: number): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const startedAt = Date.now();
      const timeout = setTimeout(() => {
        this.pendingSmartphoneDataReads.delete(requestId);
        const recovered = this.getRecentSmartphoneDataResponse(startedAt);
        if (recovered) {
          resolve({
            ...recovered.payload,
            recoveredFromLateResponse: true,
            recoveredRequestId: recovered.requestId,
          });
          return;
        }
        reject(new Error(`Timed out waiting for smartphone data response after ${timeoutMs}ms.`));
      }, timeoutMs);
      this.pendingSmartphoneDataReads.set(requestId, { resolve, reject, timeout, startedAt });
    });
  }

  private resolveSmartphoneDataRead(input: Record<string, unknown>): void {
    const payload = input.payload && typeof input.payload === 'object'
      ? input.payload as Record<string, unknown>
      : input;
    const requestId = String(payload.requestId || input.requestId || '').trim();
    if (!requestId) return;
    this.latestSmartphoneDataResponse = {
      payload,
      receivedAt: Date.now(),
      requestId,
    };
    const pending = this.pendingSmartphoneDataReads.get(requestId);
    if (!pending) {
      this.resolveCompatibleSmartphoneDataRead(requestId, payload);
      return;
    }
    this.pendingSmartphoneDataReads.delete(requestId);
    clearTimeout(pending.timeout);
    if (payload.error) {
      pending.reject(new Error(String(payload.error)));
      return;
    }
    pending.resolve(payload);
  }

  private resolveCompatibleSmartphoneDataRead(responseRequestId: string, payload: Record<string, unknown>): void {
    if (payload.error || this.pendingSmartphoneDataReads.size !== 1) {
      return;
    }

    const [requestId, pending] = Array.from(this.pendingSmartphoneDataReads.entries())
      .sort(([, a], [, b]) => a.startedAt - b.startedAt)[0] || [];
    if (!requestId || !pending) {
      return;
    }

    this.pendingSmartphoneDataReads.delete(requestId);
    clearTimeout(pending.timeout);
    pending.resolve({
      ...payload,
      recoveredFromMismatchedRequestId: true,
      recoveredRequestId: responseRequestId,
    });
  }

  private getRecentSmartphoneDataResponse(startedAt: number): CachedTelosResponse | null {
    const cached = this.latestSmartphoneDataResponse;
    if (!cached) {
      return null;
    }
    if (cached.payload.error) {
      return null;
    }
    const now = Date.now();
    if (cached.receivedAt < startedAt - 2_000) {
      return null;
    }
    if (now - cached.receivedAt > 15_000) {
      return null;
    }
    return cached;
  }

  private waitForMusicHistoryRead(requestId: string, timeoutMs: number): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const startedAt = Date.now();
      const timeout = setTimeout(() => {
        this.pendingMusicHistoryReads.delete(requestId);
        reject(new Error(`Timed out waiting for Telos Music history response after ${timeoutMs}ms.`));
      }, timeoutMs);
      this.pendingMusicHistoryReads.set(requestId, { resolve, reject, timeout, startedAt });
    });
  }

  private resolveMusicHistoryRead(input: Record<string, unknown>): void {
    const payload = input.payload && typeof input.payload === 'object'
      ? input.payload as Record<string, unknown>
      : input;
    const requestId = String(payload.requestId || input.requestId || '').trim();
    if (!requestId) return;
    const pending = this.pendingMusicHistoryReads.get(requestId);
    if (!pending) return;
    this.pendingMusicHistoryReads.delete(requestId);
    clearTimeout(pending.timeout);
    if (payload.error) {
      pending.reject(new Error(String(payload.error)));
      return;
    }
    pending.resolve(payload);
  }

  private async startServer(): Promise<void> {
    if (this.server) {
      return;
    }

    const startedServer = this.app.listen(this.config.port, this.config.host);
    this.server = startedServer;
    startedServer.on('clientError', (error, socket) => {
      if (!isExpectedHttpAbort(error)) {
        warnRealtime('HTTP client error', error instanceof Error ? error.message : String(error));
      }
      socket.destroy();
    });
    await new Promise<void>((resolve) => {
      startedServer.once('listening', () => resolve());
    });
    const address = startedServer.address() as AddressInfo;
    const localBase = `http://localhost:${address.port}`;
    this.localBaseUrl = localBase;
    this.baseUrl = this.config.publicBaseUrl || localBase;
    this.linkBaseUrl = this.resolveTelosLinkBaseUrl(address.port);
    this.communication.setEndpointBaseUrl(this.linkBaseUrl);
    process.env.TELOS_REALTIME_ADVISOR_URL = this.baseUrl;
    logRealtime('Server listening', `${this.baseUrl} (client: ${this.baseUrl}/client)`);
    logRealtime('Telos Link endpoint', this.linkBaseUrl);
    if (this.config.tunnelProvider !== 'off') {
      this.startPublicTunnel(address.port);
    } else {
      this.tunnelStatus = 'disabled';
    }
    if (this.config.autoOpenClient) {
      await open(`${this.baseUrl}/client`).catch((error) => {
        warnRealtime('Could not open client', error instanceof Error ? error.message : String(error));
      });
    }
  }

  private resolveTelosLinkBaseUrl(port: number): string {
    if (this.config.publicBaseUrl) {
      return this.config.publicBaseUrl.replace(/\/+$/, '');
    }
    const explicitHost = readTelosLinkAdvertiseHost();
    const host = explicitHost || detectLanIpv4() || '127.0.0.1';
    if (/^https?:\/\//i.test(host)) {
      return host.replace(/\/+$/, '');
    }
    const bracketedHost = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
    return `http://${bracketedHost}:${port}`;
  }

  private startPublicTunnel(port: number): void {
    if (this.config.publicBaseUrl || this.config.tunnelProvider === 'off') {
      this.tunnelStatus = 'disabled';
      return;
    }
    if (this.tunnelProcess || this.localTunnel) {
      return;
    }

    if (this.config.tunnelProvider === 'localhost-run') {
      this.startLocalhostRunTunnel(port);
      return;
    }

    this.startLocaltunnelTunnel(port);
  }

  private startLocaltunnelTunnel(port: number): void {
    const generation = ++this.tunnelGeneration;
    this.tunnelStatus = 'starting';
    this.tunnelError = '';
    logRealtime(
      'Starting tunnel',
      `localtunnel: host=${this.config.localtunnelHost}, port=${port}, localHost=${this.config.localtunnelLocalHost}`,
    );

    void this.openValidatedLocaltunnel(port, generation);
  }

  private async openValidatedLocaltunnel(port: number, generation: number): Promise<void> {
    let attempt = 0;
    while (this.tunnelGeneration === generation && !this.localTunnel) {
      attempt += 1;
      let tunnel: LocalTunnel | null = null;
      try {
        tunnel = await this.createLocaltunnel(port, 45_000);
        if (this.tunnelGeneration !== generation) {
          tunnel.close();
          return;
        }
        this.attachLocaltunnelEvents(tunnel);
        const publicUrl = tunnel.url.replace(/\/+$/, '');
        const valid = await this.validatePublicTunnelUrl(publicUrl, 4);
        if (!valid) {
          tunnel.close();
          this.tunnelError = `localtunnel URL did not forward /health: ${publicUrl}`;
          warnRealtime('localtunnel tunnel validation failed', `${this.tunnelError}; retrying`);
          await this.sleep(2_000);
          continue;
        }

        this.localTunnel = tunnel;
        this.publicUrl = publicUrl;
        this.baseUrl = publicUrl;
        process.env.TELOS_REALTIME_ADVISOR_URL = publicUrl;
        this.tunnelStatus = 'online';
        this.tunnelError = '';
        logRealtime('localtunnel tunnel online', `${publicUrl}/client`);
        return;
      } catch (error) {
        tunnel?.close();
        if (this.tunnelGeneration !== generation) {
          return;
        }
        this.tunnelStatus = 'starting';
        this.tunnelError = error instanceof Error ? error.message : String(error);
        warnRealtime('localtunnel tunnel attempt failed', `attempt=${attempt}: ${this.tunnelError}`);
        await this.sleep(Math.min(10_000, 1_000 + attempt * 1_000));
      }
    }
  }

  private createLocaltunnel(port: number, timeoutMs: number): Promise<LocalTunnel> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const tunnel = localtunnel({
        port,
        host: this.config.localtunnelHost,
        subdomain: this.config.localtunnelSubdomain,
        local_host: this.config.localtunnelLocalHost,
      }, (error) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        if (error) {
          reject(error);
          return;
        }
        resolve(tunnel);
      });
      const timer = setTimeout(() => {
        if (settled) {
          return;
        }
        settled = true;
        tunnel.close();
        reject(new Error(`localtunnel did not return a URL within ${Math.round(timeoutMs / 1000)} seconds`));
      }, timeoutMs);
      timer.unref?.();
    });
  }

  private attachLocaltunnelEvents(tunnel: LocalTunnel): void {
    tunnel.on('request', (info: { method?: string; path?: string }) => {
      logRealtime('localtunnel request', `${info.method || '?'} ${info.path || '/'}`);
    });
    tunnel.on('error', (error: Error) => {
      if (this.localTunnel !== tunnel) {
        return;
      }
      this.tunnelStatus = 'failed';
      this.tunnelError = error.message;
      warnRealtime('localtunnel tunnel failed', error.message);
    });
    tunnel.on('close', () => {
      if (this.localTunnel === tunnel) {
        this.localTunnel = null;
      }
      if (this.tunnelStatus === 'online') {
        this.tunnelStatus = 'stopped';
      }
      warnRealtime('localtunnel tunnel stopped');
    });
  }

  private async validatePublicTunnelUrl(publicUrl: string, attempts: number): Promise<boolean> {
    for (let index = 0; index < attempts; index += 1) {
      try {
        const response = await fetch(`${publicUrl}/health`, {
          headers: {
            accept: 'application/json',
            'bypass-tunnel-reminder': 'true',
          },
        });
        if (response.ok) {
          const body = await response.json().catch(() => null) as { success?: unknown } | null;
          if (body?.success === true) {
            return true;
          }
        }
      } catch {
        // Try again below; tunnel servers often need a short warm-up.
      }
      await this.sleep(2_500);
    }
    return false;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private startLocalhostRunTunnel(port: number): void {
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
    logRealtime('Starting tunnel', `localhost-run: ssh ${args.join(' ')}`);
    let child: ChildProcess;
    try {
      child = spawn('ssh', args, {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      this.tunnelStatus = 'failed';
      this.tunnelError = error instanceof Error ? error.message : String(error);
      this.tunnelProcess = null;
      warnRealtime('localhost.run tunnel failed', this.tunnelError);
      return;
    }
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
    this.tunnelGeneration += 1;
    if (this.localTunnel) {
      const tunnel = this.localTunnel;
      this.localTunnel = null;
      tunnel.close();
      this.tunnelStatus = 'stopped';
    }
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
        ? repairUtf8Mojibake(body['quickTranscript'])
        : typeof body['transcript'] === 'string'
          ? repairUtf8Mojibake(body['transcript'])
          : undefined,
      immediateAdvice: parseImmediateAdvice(body['immediateAdvice']),
      timestamp: typeof body['timestamp'] === 'string' || typeof body['timestamp'] === 'number'
        ? body['timestamp']
        : undefined,
      language: typeof body['language'] === 'string' ? body['language'] : undefined,
      metadata: toRecord(body['metadata']),
    };
  }

  private async acceptTelosLinkAudioChunk(input: TelosLinkAudioChunkInput): Promise<void> {
    const registered = await this.registerIncomingAudioChunk({
      body: {
        ...input.metadata,
        mimeType: input.mimeType || input.metadata.mimeType,
        metadata: {
          ...toRecord(input.metadata.metadata),
          telosLink: {
            envelopeId: input.envelopeId,
            originPeerId: input.originPeerId,
            originUserId: input.originUserId,
          },
        },
      },
      audioBuffer: input.audioBuffer,
      mimeType: input.mimeType,
      fileName: input.fileName,
    });
    if (registered) {
      void this.afterIncomingAudioChunk(registered)
        .catch((error) => warnRealtime('Telos Link audio chunk work failed', error instanceof Error ? error.message : String(error)));
    }
  }

  private async acceptTelosLinkQuickTranscript(input: TelosLinkAudioChunkInput): Promise<void> {
    const registered = await this.registerIncomingQuickTranscript({
      ...input.metadata,
      metadata: {
        ...toRecord(input.metadata.metadata),
        telosLink: {
          envelopeId: input.envelopeId,
          originPeerId: input.originPeerId,
          originUserId: input.originUserId,
        },
      },
    });
    if (registered) {
      await this.afterIncomingQuickTranscript(registered);
    }
  }

  private async registerIncomingQuickTranscript(body: Record<string, unknown>): Promise<RegisteredIncomingChunk | null> {
    const metadata = this.parseChunkMetadata(body || {});
    if (!metadata.quickTranscript?.trim()) {
      return null;
    }
    const requestedChunkId = metadata.chunkId?.trim();
    if (requestedChunkId && this.store.getStateSnapshot().chunks[requestedChunkId]) {
      logRealtime('Duplicate quick transcript ignored', requestedChunkId);
      return null;
    }
    const { chunk, conversation, created } = await this.store.registerQuickChunk({
      metadata,
      conversationGapMs: this.config.conversationGapMs,
    });
    if (!created) return null;
    const triggerState = await this.store.recordVoiceLineForAutomaticTrigger();
    this.scheduleDebounceTriggerFromCurrentState(conversation.id, chunk.id);
    return { chunk, conversation, triggerState, metadata };
  }

  private logDuplicateAudioChunk(chunkId: string | undefined): void {
    const key = chunkId || '(unknown)';
    const now = Date.now();
    const last = this.duplicateAudioLogTimes.get(key) || 0;
    if (now - last < 30_000) {
      return;
    }
    this.duplicateAudioLogTimes.set(key, now);
    if (this.duplicateAudioLogTimes.size > 2048) {
      const cutoff = now - 5 * 60_000;
      for (const [entry, seenAt] of this.duplicateAudioLogTimes) {
        if (seenAt < cutoff) {
          this.duplicateAudioLogTimes.delete(entry);
        }
      }
    }
    logRealtime('Duplicate audio chunk ignored', key);
  }

  private async registerIncomingAudioChunk(input: {
    file?: MaybeMulterFile;
    body: Record<string, unknown>;
    audioBuffer?: Buffer;
    mimeType?: string;
    fileName?: string;
  }): Promise<RegisteredIncomingChunk | null> {
    const metadata = this.parseChunkMetadata(input.body || {});
    const requestedChunkId = metadata.chunkId?.trim();
    const existingBeforePersist = requestedChunkId ? this.store.getStateSnapshot().chunks[requestedChunkId] : undefined;
    if (existingBeforePersist?.audioPath) {
      this.logDuplicateAudioChunk(requestedChunkId);
      return null;
    }
    const mimeType = input.file?.mimetype
      || input.mimeType
      || String(input.body?.['mimeType'] || 'application/octet-stream');
    const audioPath = input.audioBuffer
      ? await this.persistIncomingAudioBuffer(input.audioBuffer, input.fileName || 'chunk', mimeType)
      : await this.persistIncomingAudio(input.file, input.body);
    const existing = existingBeforePersist || (requestedChunkId ? this.store.getStateSnapshot().chunks[requestedChunkId] : undefined);
    if (existing?.audioPath) {
      await rm(audioPath, { force: true }).catch(() => undefined);
      this.logDuplicateAudioChunk(requestedChunkId);
      return null;
    }
    if (existing && requestedChunkId) {
      const { chunk, conversation } = await this.store.attachAudioToChunk({
        chunkId: requestedChunkId,
        audioPath,
        mimeType,
        metadata,
      });
      return {
        chunk,
        conversation,
        triggerState: this.store.getAutomaticTrigger(),
        metadata,
        quickAlreadyHandled: true,
      };
    }
    const { chunk, conversation } = await this.store.registerChunk({
      audioPath,
      mimeType,
      metadata,
      conversationGapMs: this.config.conversationGapMs,
    });
    const triggerState = await this.store.recordVoiceLineForAutomaticTrigger();
    this.scheduleDebounceTriggerFromCurrentState(conversation.id, chunk.id);
    return { chunk, conversation, triggerState, metadata };
  }

  private async afterIncomingQuickTranscript(registered: RegisteredIncomingChunk): Promise<void> {
    const { chunk, conversation, triggerState, metadata } = registered;
    const receivedAt = Date.now();
    logRealtime('Quick transcript received', `${chunk.id}: ${chunk.quickTranscript.slice(0, 80)}`);
    if (metadata.immediateAdvice) {
      this.queueAdviceTrigger(conversation.id, { kind: 'manual' });
      logRealtime('Advice trigger queued', `${chunk.id} in ${Date.now() - receivedAt}ms`);
    } else if (this.shouldFireEveryTrigger(triggerState)) {
      void this.fireAutomaticTrigger(
        conversation.id,
        chunk.id,
        this.describeEveryTrigger(triggerState),
      ).catch((error) => warnRealtime('Automatic trigger failed', error instanceof Error ? error.message : String(error)));
      logRealtime('Automatic advice trigger queued', `${chunk.id} in ${Date.now() - receivedAt}ms`);
    }

    void this.emitCommunicationEvent({
      type: 'transcript.quick',
      priority: 'normal',
      conversationId: conversation.id,
      payload: {
        chunkId: chunk.id,
        conversationId: conversation.id,
        quickTranscript: chunk.quickTranscript,
        timestamp: chunk.clientTimestamp,
      },
    });
  }

  private async afterIncomingAudioChunk(registered: RegisteredIncomingChunk): Promise<void> {
    const { chunk, conversation, triggerState, metadata } = registered;
    if (!registered.quickAlreadyHandled) {
      void this.emitCommunicationEvent({
        type: 'transcript.quick',
        priority: 'normal',
        conversationId: conversation.id,
        payload: {
          chunkId: chunk.id,
          conversationId: conversation.id,
          quickTranscript: chunk.quickTranscript,
          timestamp: chunk.clientTimestamp,
        },
      });
    }
    this.queueChunkProcessing(chunk.id);

    if (!registered.quickAlreadyHandled && metadata.immediateAdvice) {
      this.queueAdviceTrigger(conversation.id, { kind: 'manual' });
    } else if (!registered.quickAlreadyHandled && this.shouldFireEveryTrigger(triggerState)) {
      void this.fireAutomaticTrigger(
        conversation.id,
        chunk.id,
        this.describeEveryTrigger(triggerState),
      ).catch((error) => warnRealtime('Automatic trigger failed', error instanceof Error ? error.message : String(error)));
    }
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

  private async persistIncomingAudioBuffer(buffer: Buffer, originalName: string, mimeType: string): Promise<string> {
    if (buffer.length === 0) {
      throw new Error('Missing Telos Link audio bytes.');
    }
    const targetPath = this.store.createChunkAudioPath(originalName, mimeType);
    await mkdir(path.dirname(targetPath), { recursive: true });
    await writeFile(targetPath, buffer);
    return targetPath;
  }

  private shouldFireEveryTrigger(trigger: AutomaticTriggerState): boolean {
    return trigger.type === 'every'
      && trigger.lineCountSinceLastTrigger >= Math.max(1, Math.floor(trigger.value));
  }

  private describeEveryTrigger(trigger: AutomaticTriggerState): string {
    const value = Math.max(1, Math.floor(trigger.value));
    return `every ${value} new audio voice line${value === 1 ? '' : 's'}`;
  }

  private describeDebounceTrigger(trigger: AutomaticTriggerState): string {
    return `debounce: no new audio voice lines for ${trigger.value} minute${trigger.value === 1 ? '' : 's'}`;
  }

  private clearDebounceTimer(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    this.debounceTimerConversationId = null;
    this.debounceTimerChunkId = null;
  }

  private scheduleDebounceTriggerFromCurrentState(conversationId?: string, chunkId?: string): void {
    const trigger = this.store.getAutomaticTrigger();
    if (trigger.type !== 'debounce') {
      this.clearDebounceTimer();
      return;
    }

    const conversation = conversationId
      ? this.store.getConversation(conversationId)
      : this.store.getCurrentConversation();
    if (!conversation) {
      this.clearDebounceTimer();
      return;
    }

    const lastChunkId = chunkId || conversation.chunkIds.at(-1);
    if (trigger.lastTriggerConversationId === conversation.id && trigger.lastTriggerChunkId === lastChunkId) {
      this.clearDebounceTimer();
      return;
    }

    const lastChunkMs = new Date(conversation.lastChunkAt).getTime();
    if (!Number.isFinite(lastChunkMs)) {
      this.clearDebounceTimer();
      return;
    }

    this.clearDebounceTimer();
    this.debounceTimerConversationId = conversation.id;
    this.debounceTimerChunkId = lastChunkId || null;
    const delayMs = Math.max(0, lastChunkMs + trigger.value * 60_000 - Date.now());
    this.debounceTimer = setTimeout(() => {
      const targetConversationId = this.debounceTimerConversationId;
      const targetChunkId = this.debounceTimerChunkId || undefined;
      this.debounceTimer = null;
      this.debounceTimerConversationId = null;
      this.debounceTimerChunkId = null;
      if (!targetConversationId) {
        return;
      }
      void this.fireAutomaticTrigger(
        targetConversationId,
        targetChunkId,
        this.describeDebounceTrigger(this.store.getAutomaticTrigger()),
      ).catch((error) => {
        warnRealtime('Automatic debounce trigger failed', error instanceof Error ? error.message : String(error));
        this.scheduleDebounceTriggerFromCurrentState(targetConversationId, targetChunkId);
      });
    }, delayMs);
    this.debounceTimer.unref?.();
  }

  private async fireAutomaticTrigger(
    conversationId: string,
    chunkId: string | undefined,
    condition: string,
  ): Promise<string | null> {
    const conversation = this.store.getConversation(conversationId);
    if (!conversation) {
      return null;
    }
    const latestChunkId = conversation.chunkIds.at(-1);
    if (chunkId && latestChunkId && chunkId !== latestChunkId) {
      return null;
    }
    const triggerKey = `${conversationId}:${chunkId || latestChunkId || 'none'}`;
    if (this.automaticTriggerInFlightKey === triggerKey) {
      return null;
    }

    this.automaticTriggerInFlightKey = triggerKey;
    try {
      const advice = await this.sendNewTranscriptToAgent(conversation, {
        kind: 'automatic',
        condition,
      });
      await this.store.markAutomaticTriggerFired({
        conversationId,
        chunkId: chunkId || latestChunkId,
        reason: condition,
      });
      this.scheduleDebounceTriggerFromCurrentState(conversationId, chunkId || latestChunkId);
      return advice;
    } finally {
      if (this.automaticTriggerInFlightKey === triggerKey) {
        this.automaticTriggerInFlightKey = null;
      }
    }
  }

  private queueAdviceTrigger(conversationId: string, trigger: AdviceTriggerContext): void {
    if (this.adviceInFlightConversations.has(conversationId)) {
      this.coalescedAdviceTriggers.set(conversationId, {
        ...trigger,
        queuedAt: Date.now(),
      });
      logRealtime('Advice trigger coalesced', conversationId);
      return;
    }

    const queuedAt = Date.now();
    this.adviceInFlightConversations.add(conversationId);
    void (async () => {
      const conversation = this.store.getConversation(conversationId);
      if (!conversation) {
        return;
      }
      await this.sendNewTranscriptToAgent(conversation, {
        ...trigger,
        queuedAt,
      });
    })().catch((error) => {
      warnRealtime('Advice trigger failed', error instanceof Error ? error.message : String(error));
      void this.emitCommunicationEvent({
        type: 'advisor.failed',
        priority: 'high',
        conversationId,
        payload: {
          conversationId,
          trigger,
          error: error instanceof Error ? error.message : String(error),
        },
      });
    }).finally(() => {
      this.adviceInFlightConversations.delete(conversationId);
      const next = this.coalescedAdviceTriggers.get(conversationId);
      if (!next) {
        return;
      }
      this.coalescedAdviceTriggers.delete(conversationId);
      this.queueAdviceTrigger(conversationId, next);
    });
  }

  private queueChunkProcessing(chunkId: string): void {
    if (this.queuedChunkProcessingIds.has(chunkId)) {
      return;
    }
    const chunk = this.store.getStateSnapshot().chunks[chunkId];
    if (!chunk || chunk.assemblyAi?.status === 'running' || chunk.assemblyAi?.status === 'succeeded') {
      return;
    }
    this.queuedChunkProcessingIds.add(chunkId);
    this.pendingChunkProcessingIds.push(chunkId);
    this.drainChunkProcessingQueue();
  }

  private drainChunkProcessingQueue(): void {
    const maxConcurrent = Math.max(1, Math.min(3, Math.floor(readNumberEnv('TELOS_REALTIME_AUDIO_PROCESSING_CONCURRENCY', 1))));
    while (this.activeChunkProcessingCount < maxConcurrent && this.pendingChunkProcessingIds.length > 0) {
      const chunkId = this.pendingChunkProcessingIds.shift()!;
      this.activeChunkProcessingCount += 1;
      void this.processChunk(chunkId)
        .catch((error) => warnRealtime('Chunk processing failed', error instanceof Error ? error.message : String(error)))
        .finally(() => {
          this.activeChunkProcessingCount = Math.max(0, this.activeChunkProcessingCount - 1);
          this.queuedChunkProcessingIds.delete(chunkId);
          this.drainChunkProcessingQueue();
        });
    }
  }

  private async processChunk(chunkId: string): Promise<void> {
    const state = this.store.getStateSnapshot();
    const chunk = state.chunks[chunkId];
    if (!chunk) {
      return;
    }
    if (!this.assemblyAi.isEnabled()) {
      await this.store.markChunkProcessing(chunk.id, 'skipped', { error: 'ASSEMBLYAI_API_KEY is not configured.' });
      return;
    }

    await this.store.markChunkProcessing(chunk.id, 'running');

    try {
      const mediaUrl = await this.assemblyAi.uploadMedia(chunk.audioPath);
      const transcriptJob = await this.assemblyAi.transcribe(mediaUrl);
      await this.store.markChunkProcessing(chunk.id, 'running', {
        transcriptId: transcriptJob.jobId,
      });

      const transcriptResult = await this.assemblyAi.waitForJob(transcriptJob);

      if (transcriptResult.status !== 'completed') {
        throw new Error(transcriptResult.error || `AssemblyAI transcript ${transcriptResult.jobId} ended with ${transcriptResult.status}`);
      }

      await this.applyProcessedChunk(
        chunk,
        transcriptResult.output,
      );
      await this.store.markChunkProcessing(chunk.id, 'succeeded', {
        transcriptId: transcriptResult.jobId,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.store.markChunkProcessing(chunk.id, 'failed', { error: message });
      throw error;
    }
  }

  private async applyProcessedChunk(
    chunk: StoredAudioChunk,
    diarization: AssemblyAiDiarizationOutput | undefined,
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
          source: 'assemblyai' as const,
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
      void this.persistFinalTranscriptChunk(chunk, replacement.insertedEntries).catch((error) => {
        warnRealtime('Transcript content-memory persist failed', error instanceof Error ? error.message : String(error));
      });
      await this.emitCommunicationEvent({
        type: 'transcript.final',
        priority: 'normal',
        conversationId: conversation.id,
        payload: {
          chunkId: chunk.id,
          conversationId: conversation.id,
          entries: replacement.insertedEntries,
          removedEntryIds: replacement.removedQuickEntries.map((entry) => entry.id),
        },
      });
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

    await this.cleanupChunkAudioIfDisposable(chunk).catch((error) => {
      warnRealtime('Chunk audio cleanup failed', error instanceof Error ? error.message : String(error));
    });
  }

  private async persistFinalTranscriptChunk(
    chunk: StoredAudioChunk,
    entries: TranscriptEntry[],
  ): Promise<void> {
    const finalEntries = entries.filter((entry) => entry.text.trim());
    if (finalEntries.length === 0) {
      return;
    }
    const transcript = finalEntries
      .map((entry) => `${entry.speakerLabel}: ${entry.text}`)
      .join('\n');
    const labels = Array.from(new Set(finalEntries.map((entry) => entry.speakerLabel).filter(Boolean)));
    await getContentMemoryService().upsertText({
      collection: 'conversation_transcripts',
      id: `conversation_transcripts:${chunk.id}`,
      text: transcript,
      summary: transcript.split('\n').slice(0, 2).join(' ').slice(0, 260),
      labels,
      createdAt: chunk.clientTimestamp,
      updatedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + CONVERSATION_RETENTION_MS).toISOString(),
      transcript: finalEntries,
    });
  }

  private async persistAdvisorContextLog(record: ConversationLogRecord): Promise<void> {
    const text = record.text.trim();
    if (!text) {
      return;
    }
    await getContentMemoryService().upsertText({
      collection: 'advisor_context',
      id: `advisor_context:${record.id}`,
      text,
      summary: text.split('\n').join(' ').slice(0, 260),
      createdAt: record.createdAt,
      updatedAt: record.createdAt,
      expiresAt: new Date(Date.now() + CONVERSATION_RETENTION_MS).toISOString(),
    });
  }

  private async cleanupChunkAudioIfDisposable(chunk: StoredAudioChunk): Promise<void> {
    if (!chunk.audioPath || !existsSync(chunk.audioPath)) {
      return;
    }
    await unlink(chunk.audioPath);
  }

  private async resolveSpeakerSummaries(
    chunk: StoredAudioChunk,
    diarization: AssemblyAiDiarizationOutput | undefined,
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
        const proposal = await this.store.addPendingSpeaker({
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
        await this.emitCommunicationEvent({
          type: 'speaker.proposal',
          priority: 'high',
          conversationId: buffer.conversationId,
          payload: {
            proposal: this.publicPendingSpeakerPayload(proposal),
            chunkIds: buffer.chunkIds,
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
        const proposal = await this.store.addPendingSpeaker({
          conversationId: conversation.id,
          diarizationSpeaker,
          samplePath,
          speechSeconds: Math.min(duration, this.config.speakerSampleMaxSeconds),
          confidenceSummary: {
            cleanSpeechSeconds: duration,
            agreeingSegments: 1,
          },
        });
        await this.emitCommunicationEvent({
          type: 'speaker.proposal',
          priority: 'high',
          conversationId: conversation.id,
          payload: {
            proposal: this.publicPendingSpeakerPayload(proposal),
            recovered: true,
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

  private async sendNewTranscriptToAgent(
    conversation: ConversationRecord,
    trigger: AdviceTriggerContext,
  ): Promise<string> {
    const newEntries = conversation.entries.filter((entry) =>
      conversation.agent.sentEntryRevisions[entry.id] !== entry.revision
    );
    if (newEntries.length === 0) {
      const response = await this.runAgentWithConversation(
        conversation.id,
        `${this.formatAdviceTriggerHeader(trigger)}\n\nNo new transcript lines are available. Use the current conversation context.`,
        [],
        trigger.queuedAt,
      );
      await this.emitAdvisorResponse(conversation.id, response, trigger, []);
      return response;
    }

    const message = this.formatAdviceMessage(conversation, newEntries, trigger);
    const response = await this.runAgentWithConversation(conversation.id, message, newEntries, trigger.queuedAt);
    await this.emitAdvisorResponse(conversation.id, response, trigger, newEntries);
    return response;
  }

  private async callAdvisorFromTelos(instruction: string): Promise<string> {
    const conversation = this.store.getCurrentConversation();
    const trigger: AdviceTriggerContext = {
      kind: 'automatic',
      condition: 'telos.advisor.call',
      queuedAt: Date.now(),
    };
    const message = [
      this.formatAdviceTriggerHeader(trigger),
      '',
      'Another Telos agent is calling you directly with this instruction:',
      '"""',
      instruction,
      '"""',
      '',
      conversation
        ? `Current transcript context:\n${this.formatConversationTranscript(conversation)}`
        : 'No live transcript conversation is currently available.',
      '',
      'Use the current realtime advisor situation instructions from your system prompt. Reply with the shortest useful response for the calling agent or for immediate user delivery.',
    ].join('\n');
    return this.runAgentWithConversation(conversation?.id, message, [], trigger.queuedAt);
  }

  private async runAgentWithConversation(
    conversationId: string | undefined,
    message: string,
    sentEntries: TranscriptEntry[],
    queuedAt?: number,
  ): Promise<string> {
    const run = this.agentQueue.then(async () => {
      if (queuedAt) {
        logRealtime('Advice run starting', `queue wait ${Date.now() - queuedAt}ms`);
      }
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
        const activeAgent = session.agent;
        const activeSandbox = this.agentSandbox;
        const env = {
          TELOS_REALTIME_ADVISOR_API_URL: this.localBaseUrl || this.baseUrl,
        };
        response = await actionContext.run({ env }, () => runWithAgentContext(
          activeAgent.config.name,
          () => executor.execute(executionMessage, { continueActiveTurn: continuingActiveTurn }),
          callbacks,
          false,
          activeSandbox,
          activeAgent.config.modelSwitching,
          activeAgent,
        ));
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

  private formatAdviceMessage(
    conversation: ConversationRecord,
    entries: TranscriptEntry[],
    trigger: AdviceTriggerContext,
  ): string {
    const header = [
      this.formatAdviceTriggerHeader(trigger),
      `Conversation: ${conversation.id}`,
      `Conversation started: ${formatTimecode(conversation.startedAt)}`,
      'Only the transcript entries below are new or changed; earlier entries are already in this session context.',
      '',
      '<telos-live-transcript>',
    ].join('\n');
    const body = entries.map((entry) => this.formatEntryBlock(entry)).join('\n');
    return `${header}\n${body}\n</telos-live-transcript>\n\nRespond with the shortest useful advice for the current moment.`;
  }

  private formatAdviceTriggerHeader(trigger: AdviceTriggerContext): string {
    if (trigger.kind === 'automatic') {
      return `Automatic trigger after ${trigger.condition || 'configured condition'}:`;
    }
    return 'The user has requested your immediate advice:';
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
      const result = { tempId, dismissed: true };
      await this.emitCommunicationEvent({
        type: 'speaker.resolved',
        priority: 'normal',
        conversationId: proposal.conversationId,
        payload: result,
      });
      return result;
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
      const result = { tempId, speaker: speaker ? this.publicSpeakerPayload(speaker) : undefined, merged: true };
      await this.emitCommunicationEvent({
        type: 'speaker.resolved',
        priority: 'normal',
        conversationId: proposal.conversationId,
        payload: result,
      });
      return result;
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
    const result = { tempId, speaker: this.publicSpeakerPayload(speaker), merged: false };
    await this.emitCommunicationEvent({
      type: 'speaker.resolved',
      priority: 'normal',
      conversationId: proposal.conversationId,
      payload: result,
    });
    return result;
  }

  private async emitAdvisorResponse(
    conversationId: string,
    advice: string,
    trigger: AdviceTriggerContext,
    entries: TranscriptEntry[],
  ): Promise<void> {
    await this.emitCommunicationEvent({
      type: 'advisor.response',
      priority: 'high',
      conversationId,
      payload: {
        conversationId,
        advice,
        trigger,
        entryIds: entries.map((entry) => entry.id),
      },
    });
  }

  private async emitCommunicationEvent<TPayload>(input: TelosLinkPublishInput<TPayload>): Promise<void> {
    try {
      await this.communication.publish({
        source: REALTIME_ADVISOR_INTERFACE,
        ...input,
      });
    } catch (error) {
      warnRealtime('Communication event publish failed', error instanceof Error ? error.message : String(error));
    }
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

  private publicAutomaticTriggerPayload(trigger: AutomaticTriggerState): Record<string, unknown> {
    return {
      ...trigger,
      formatted: this.formatAutomaticTriggerState(trigger),
    };
  }

  private publicAdvisorInstructionsPayload(instructions: AdvisorInstructionsState): Record<string, unknown> {
    return {
      ...instructions,
      formatted: this.formatAdvisorInstructions(instructions),
    };
  }

  private formatAdvisorInstructions(instructions: AdvisorInstructionsState): string {
    const text = instructions.text.trim();
    const lines = [
      'Realtime advisor instructions:',
      text || '(none)',
      instructions.updatedAt ? `Updated: ${formatTimecode(instructions.updatedAt)}` : '',
    ].filter(Boolean);
    return lines.join('\n');
  }

  private formatAutomaticTriggerState(trigger: AutomaticTriggerState): string {
    const lines = [
      `Automatic trigger: ${trigger.type} = ${trigger.value}`,
      trigger.type === 'debounce'
        ? `Next debounce fires after ${trigger.value} minute${trigger.value === 1 ? '' : 's'} without a new audio voice line.`
        : `Progress: ${trigger.lineCountSinceLastTrigger}/${Math.max(1, Math.floor(trigger.value))} new audio voice lines since the last automatic trigger.`,
      trigger.lastTriggeredAt ? `Last automatic trigger: ${formatTimecode(trigger.lastTriggeredAt)}` : 'Last automatic trigger: never',
      trigger.lastTriggerReason ? `Last reason: ${trigger.lastTriggerReason}` : '',
    ].filter(Boolean);
    return lines.join('\n');
  }

  private formatConversationLogs(logs: ConversationLogRecord[]): string {
    if (logs.length === 0) {
      return 'No realtime advisor logs yet.';
    }
    return logs
      .map((log) => `[${formatTimecode(log.createdAt)}] ${log.text}`)
      .join('\n\n');
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
