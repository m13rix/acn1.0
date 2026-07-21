import { mkdir, readFile, rename, rm, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import type {
  AdaptiveScoreStats,
  AgentContextState,
  AdvisorInstructionsState,
  AutomaticTriggerState,
  ConversationRecord,
  ConversationLogRecord,
  PendingSpeakerProposal,
  RealtimeAdvisorState,
  RealtimeAdvisorTriggerType,
  RealtimeChunkMetadata,
  SpeakerRecord,
  StoredAudioChunk,
  TranscriptEntry,
  UnknownCandidateBuffer,
} from './types.js';

const STATE_VERSION = 1;
const MAX_SCORE_SAMPLES = 500;
const STATE_WRITE_RETRIES = 8;
const STATE_WRITE_RETRY_BASE_MS = 25;
const DEFAULT_AUTOMATIC_TRIGGER_TYPE: RealtimeAdvisorTriggerType = 'debounce';
const DEFAULT_AUTOMATIC_TRIGGER_VALUE = 10;

function nowIso(): string {
  return new Date().toISOString();
}

function compactId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
}

function sanitizePathSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 80) || 'item';
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableFsError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }
  const code = (error as { code?: unknown }).code;
  return code === 'EPERM' || code === 'EACCES' || code === 'EBUSY';
}

function createEmptyScoreStats(): AdaptiveScoreStats {
  return {
    knownScores: [],
    knownMargins: [],
    unknownTopScores: [],
    unknownMargins: [],
  };
}

function createDefaultAutomaticTrigger(timestamp = nowIso()): AutomaticTriggerState {
  return {
    type: DEFAULT_AUTOMATIC_TRIGGER_TYPE,
    value: DEFAULT_AUTOMATIC_TRIGGER_VALUE,
    updatedAt: timestamp,
    lineCountSinceLastTrigger: 0,
  };
}

function createEmptyState(): RealtimeAdvisorState {
  return {
    version: STATE_VERSION,
    conversations: {},
    chunks: {},
    speakers: {},
    pendingSpeakers: {},
    unknownBuffers: {},
    scoreStats: createEmptyScoreStats(),
    automaticTrigger: createDefaultAutomaticTrigger(),
    logs: [],
    advisorInstructions: {
      text: '',
    },
  };
}

function normalizeState(raw: Partial<RealtimeAdvisorState> | null | undefined): RealtimeAdvisorState {
  const fallbackTrigger = createDefaultAutomaticTrigger();
  const rawTrigger = raw?.automaticTrigger;
  const triggerType = rawTrigger?.type === 'every' || rawTrigger?.type === 'debounce'
    ? rawTrigger.type
    : fallbackTrigger.type;
  const rawTriggerValue = Number(rawTrigger?.value);
  const triggerValue = Number.isFinite(rawTriggerValue) && rawTriggerValue > 0
    ? rawTriggerValue
    : fallbackTrigger.value;
  const lineCountSinceLastTrigger = Number.isFinite(Number(rawTrigger?.lineCountSinceLastTrigger))
    ? Math.max(0, Math.floor(Number(rawTrigger?.lineCountSinceLastTrigger)))
    : 0;

  const chunks = raw?.chunks ?? {};
  for (const chunk of Object.values(chunks) as Array<StoredAudioChunk & { pyannote?: { diarizationJobId?: string; status?: NonNullable<StoredAudioChunk['assemblyAi']>['status']; error?: string } }>) {
    if (!chunk.assemblyAi && chunk.pyannote) {
      chunk.assemblyAi = {
        transcriptId: chunk.pyannote.diarizationJobId,
        status: chunk.pyannote.status || 'queued',
        error: chunk.pyannote.error,
      };
      delete chunk.pyannote;
    }
  }

  return {
    version: STATE_VERSION,
    conversations: raw?.conversations ?? {},
    chunks,
    speakers: raw?.speakers ?? {},
    pendingSpeakers: raw?.pendingSpeakers ?? {},
    unknownBuffers: raw?.unknownBuffers ?? {},
    scoreStats: {
      ...createEmptyScoreStats(),
      ...(raw?.scoreStats ?? {}),
    },
    automaticTrigger: {
      type: triggerType,
      value: triggerValue,
      updatedAt: typeof rawTrigger?.updatedAt === 'string' ? rawTrigger.updatedAt : fallbackTrigger.updatedAt,
      lineCountSinceLastTrigger,
      lastTriggeredAt: typeof rawTrigger?.lastTriggeredAt === 'string' ? rawTrigger.lastTriggeredAt : undefined,
      lastTriggerConversationId: typeof rawTrigger?.lastTriggerConversationId === 'string' ? rawTrigger.lastTriggerConversationId : undefined,
      lastTriggerChunkId: typeof rawTrigger?.lastTriggerChunkId === 'string' ? rawTrigger.lastTriggerChunkId : undefined,
      lastTriggerReason: typeof rawTrigger?.lastTriggerReason === 'string' ? rawTrigger.lastTriggerReason : undefined,
    },
    logs: Array.isArray(raw?.logs)
      ? raw.logs
        .filter((log): log is ConversationLogRecord =>
          !!log
          && typeof log.id === 'string'
          && typeof log.createdAt === 'string'
          && typeof log.text === 'string'
        )
        .slice(-1000)
      : [],
    advisorInstructions: {
      text: typeof raw?.advisorInstructions?.text === 'string' ? raw.advisorInstructions.text : '',
      updatedAt: typeof raw?.advisorInstructions?.updatedAt === 'string' ? raw.advisorInstructions.updatedAt : undefined,
    },
  };
}

function validateTriggerInput(type: string, value: number): { type: RealtimeAdvisorTriggerType; value: number } {
  const normalizedType = type.trim().toLowerCase();
  if (normalizedType !== 'debounce' && normalizedType !== 'every') {
    throw new Error('Automatic trigger type must be "debounce" or "every".');
  }
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error('Automatic trigger value must be a positive number.');
  }
  return {
    type: normalizedType,
    value: normalizedType === 'every' ? Math.max(1, Math.floor(value)) : value,
  };
}

export class RealtimeAdvisorStore {
  readonly dataDir: string;
  readonly chunksDir: string;
  readonly speakerSamplesDir: string;
  readonly speakerEmbeddingsDir: string;
  readonly pendingSamplesDir: string;
  readonly pendingEmbeddingsDir: string;
  readonly debugDir: string;
  readonly tempDir: string;
  private readonly statePath: string;
  private state: RealtimeAdvisorState = createEmptyState();
  private saveQueue = Promise.resolve();

  constructor(dataDir: string) {
    this.dataDir = dataDir;
    this.chunksDir = path.join(dataDir, 'chunks');
    this.speakerSamplesDir = path.join(dataDir, 'speaker-samples');
    this.speakerEmbeddingsDir = path.join(dataDir, 'speaker-embeddings');
    this.pendingSamplesDir = path.join(dataDir, 'pending-speakers');
    this.pendingEmbeddingsDir = path.join(dataDir, 'pending-embeddings');
    this.debugDir = path.join(dataDir, 'debug');
    this.tempDir = path.join(dataDir, 'tmp');
    this.statePath = path.join(dataDir, 'state.json');
  }

  async initialize(): Promise<void> {
    await Promise.all([
      mkdir(this.dataDir, { recursive: true }),
      mkdir(this.chunksDir, { recursive: true }),
      mkdir(this.speakerSamplesDir, { recursive: true }),
      mkdir(this.speakerEmbeddingsDir, { recursive: true }),
      mkdir(this.pendingSamplesDir, { recursive: true }),
      mkdir(this.pendingEmbeddingsDir, { recursive: true }),
      mkdir(this.debugDir, { recursive: true }),
      mkdir(this.tempDir, { recursive: true }),
    ]);

    if (!existsSync(this.statePath)) {
      this.state = createEmptyState();
      await this.save();
      return;
    }

    const content = await readFile(this.statePath, 'utf8');
    this.state = normalizeState(JSON.parse(content) as Partial<RealtimeAdvisorState>);
  }

  getStateSnapshot(): RealtimeAdvisorState {
    return JSON.parse(JSON.stringify(this.state)) as RealtimeAdvisorState;
  }

  getAutomaticTrigger(): AutomaticTriggerState {
    return JSON.parse(JSON.stringify(this.state.automaticTrigger)) as AutomaticTriggerState;
  }

  async setAutomaticTrigger(type: string, value: number): Promise<AutomaticTriggerState> {
    const validated = validateTriggerInput(type, value);
    this.state.automaticTrigger = {
      ...this.state.automaticTrigger,
      type: validated.type,
      value: validated.value,
      updatedAt: nowIso(),
      lineCountSinceLastTrigger: 0,
    };
    await this.save();
    return this.getAutomaticTrigger();
  }

  async recordVoiceLineForAutomaticTrigger(): Promise<AutomaticTriggerState> {
    const trigger = this.state.automaticTrigger;
    trigger.lineCountSinceLastTrigger = Math.max(0, Math.floor(trigger.lineCountSinceLastTrigger || 0)) + 1;
    trigger.updatedAt = nowIso();
    await this.save();
    return this.getAutomaticTrigger();
  }

  async markAutomaticTriggerFired(input: {
    conversationId?: string;
    chunkId?: string;
    reason: string;
  }): Promise<AutomaticTriggerState> {
    const trigger = this.state.automaticTrigger;
    trigger.lineCountSinceLastTrigger = 0;
    trigger.lastTriggeredAt = nowIso();
    trigger.lastTriggerConversationId = input.conversationId;
    trigger.lastTriggerChunkId = input.chunkId;
    trigger.lastTriggerReason = input.reason;
    await this.save();
    return this.getAutomaticTrigger();
  }

  async addLog(text: string): Promise<ConversationLogRecord> {
    const normalized = String(text || '').trim();
    if (!normalized) {
      throw new Error('context.log.add(log): log must be a non-empty string.');
    }
    const timestamp = nowIso();
    const record: ConversationLogRecord = {
      id: compactId('log'),
      createdAt: timestamp,
      text: normalized,
    };
    this.state.logs.push(record);
    if (this.state.logs.length > 1000) {
      this.state.logs.splice(0, this.state.logs.length - 1000);
    }
    await this.save();
    return { ...record };
  }

  listLogs(maxResults = 20): ConversationLogRecord[] {
    const limit = Math.max(1, Math.min(200, Math.floor(maxResults)));
    return this.state.logs
      .slice(-limit)
      .reverse()
      .map((record) => ({ ...record }));
  }

  getAdvisorInstructions(): AdvisorInstructionsState {
    return { ...this.state.advisorInstructions };
  }

  async setAdvisorInstructions(text: string): Promise<AdvisorInstructionsState> {
    this.state.advisorInstructions = {
      text: String(text || '').trim(),
      updatedAt: nowIso(),
    };
    await this.save();
    return this.getAdvisorInstructions();
  }

  getConversation(conversationId: string): ConversationRecord | undefined {
    return this.state.conversations[conversationId];
  }

  getCurrentConversation(): ConversationRecord | undefined {
    const conversations = Object.values(this.state.conversations);
    return conversations.sort((a, b) => b.lastChunkAt.localeCompare(a.lastChunkAt))[0];
  }

  listSpeakers(): SpeakerRecord[] {
    return Object.values(this.state.speakers)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  getSpeaker(speakerId: string): SpeakerRecord | undefined {
    return this.state.speakers[speakerId];
  }

  listPendingSpeakers(): PendingSpeakerProposal[] {
    return Object.values(this.state.pendingSpeakers)
      .filter((proposal) => proposal.status === 'pending')
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  createChunkAudioPath(originalName: string | undefined, mimeType: string | undefined): string {
    const extFromName = originalName ? path.extname(originalName) : '';
    const ext = extFromName || this.extensionForMimeType(mimeType) || '.webm';
    return path.join(this.chunksDir, `${compactId('chunk')}${ext}`);
  }

  async registerChunk(input: {
    audioPath: string;
    mimeType: string;
    metadata: RealtimeChunkMetadata;
    conversationGapMs: number;
  }): Promise<{ chunk: StoredAudioChunk; conversation: ConversationRecord; quickEntry?: TranscriptEntry }> {
    const receivedAt = nowIso();
    const clientTimestamp = this.normalizeTimestamp(input.metadata.timestamp, receivedAt);
    const conversation = this.resolveConversationForTimestamp(clientTimestamp, input.conversationGapMs);
    const chunkId = input.metadata.chunkId?.trim() || compactId('chunk');
    const quickTranscript = input.metadata.quickTranscript?.trim() || '';

    const chunk: StoredAudioChunk = {
      id: chunkId,
      conversationId: conversation.id,
      receivedAt,
      clientTimestamp,
      audioPath: input.audioPath,
      mimeType: input.mimeType,
      quickTranscript,
      metadata: input.metadata.metadata,
      assemblyAi: {
        status: 'queued',
      },
    };

    this.state.chunks[chunk.id] = chunk;
    conversation.chunkIds.push(chunk.id);
    conversation.updatedAt = receivedAt;
    conversation.lastChunkAt = clientTimestamp;

    let quickEntry: TranscriptEntry | undefined;
    if (quickTranscript) {
      quickEntry = {
        id: compactId('entry'),
        chunkId: chunk.id,
        conversationId: conversation.id,
        source: 'quick',
        createdAt: receivedAt,
        updatedAt: receivedAt,
        startTime: clientTimestamp,
        speakerLabel: '[...]',
        text: quickTranscript,
        final: false,
        revision: 1,
        agentMarker: compactId('tr'),
      };
      conversation.entries.push(quickEntry);
    }

    await this.save();
    return { chunk, conversation, quickEntry };
  }

  async registerQuickChunk(input: {
    metadata: RealtimeChunkMetadata;
    conversationGapMs: number;
  }): Promise<{ chunk: StoredAudioChunk; conversation: ConversationRecord; quickEntry?: TranscriptEntry; created: boolean }> {
    const receivedAt = nowIso();
    const clientTimestamp = this.normalizeTimestamp(input.metadata.timestamp, receivedAt);
    const chunkId = input.metadata.chunkId?.trim() || compactId('chunk');
    const existing = this.state.chunks[chunkId];
    if (existing) {
      const existingConversation = this.state.conversations[existing.conversationId];
      if (!existingConversation) {
        throw new Error(`Chunk ${chunkId} references missing conversation ${existing.conversationId}.`);
      }
      return {
        chunk: existing,
        conversation: existingConversation,
        created: false,
      };
    }

    const conversation = this.resolveConversationForTimestamp(clientTimestamp, input.conversationGapMs);
    const quickTranscript = input.metadata.quickTranscript?.trim() || '';
    const chunk: StoredAudioChunk = {
      id: chunkId,
      conversationId: conversation.id,
      receivedAt,
      clientTimestamp,
      audioPath: '',
      mimeType: '',
      quickTranscript,
      metadata: input.metadata.metadata,
      assemblyAi: {
        status: 'queued',
      },
    };

    this.state.chunks[chunk.id] = chunk;
    conversation.chunkIds.push(chunk.id);
    conversation.updatedAt = receivedAt;
    conversation.lastChunkAt = clientTimestamp;

    let quickEntry: TranscriptEntry | undefined;
    if (quickTranscript) {
      quickEntry = {
        id: compactId('entry'),
        chunkId: chunk.id,
        conversationId: conversation.id,
        source: 'quick',
        createdAt: receivedAt,
        updatedAt: receivedAt,
        startTime: clientTimestamp,
        speakerLabel: '[...]',
        text: quickTranscript,
        final: false,
        revision: 1,
        agentMarker: compactId('tr'),
      };
      conversation.entries.push(quickEntry);
    }

    await this.save();
    return { chunk, conversation, quickEntry, created: true };
  }

  async attachAudioToChunk(input: {
    chunkId: string;
    audioPath: string;
    mimeType: string;
    metadata: RealtimeChunkMetadata;
  }): Promise<{ chunk: StoredAudioChunk; conversation: ConversationRecord }> {
    const chunk = this.state.chunks[input.chunkId];
    if (!chunk) {
      throw new Error(`Cannot attach audio to missing chunk ${input.chunkId}.`);
    }
    chunk.audioPath = input.audioPath;
    chunk.mimeType = input.mimeType;
    chunk.metadata = {
      ...(chunk.metadata || {}),
      ...(input.metadata.metadata || {}),
    };
    if (!chunk.quickTranscript && input.metadata.quickTranscript?.trim()) {
      chunk.quickTranscript = input.metadata.quickTranscript.trim();
    }
    chunk.assemblyAi = { status: 'queued' };
    const conversation = this.state.conversations[chunk.conversationId];
    if (!conversation) {
      throw new Error(`Chunk ${input.chunkId} references missing conversation ${chunk.conversationId}.`);
    }
    conversation.updatedAt = nowIso();
    await this.save();
    return { chunk, conversation };
  }

  async markChunkProcessing(
    chunkId: string,
    status: NonNullable<StoredAudioChunk['assemblyAi']>['status'],
    details?: { transcriptId?: string; error?: string },
  ): Promise<void> {
    const chunk = this.state.chunks[chunkId];
    if (!chunk) {
      return;
    }

    chunk.assemblyAi = {
      status,
      transcriptId: details?.transcriptId ?? chunk.assemblyAi?.transcriptId,
      error: details?.error,
    };
    await this.save();
  }

  async replaceChunkTranscript(input: {
    conversationId: string;
    chunkId: string;
    entries: Array<Omit<TranscriptEntry, 'id' | 'conversationId' | 'chunkId' | 'createdAt' | 'updatedAt' | 'revision' | 'agentMarker'>>;
  }): Promise<{ removedQuickEntries: TranscriptEntry[]; insertedEntries: TranscriptEntry[] }> {
    const conversation = this.state.conversations[input.conversationId];
    if (!conversation) {
      return { removedQuickEntries: [], insertedEntries: [] };
    }

    const timestamp = nowIso();
    const removedQuickEntries = conversation.entries.filter((entry) =>
      entry.chunkId === input.chunkId && entry.source === 'quick'
    );
    const firstQuick = removedQuickEntries[0];
    const retainedEntries = conversation.entries.filter((entry) =>
      !(entry.chunkId === input.chunkId && entry.source === 'quick')
    );
    const insertionIndex = conversation.entries.findIndex((entry) => entry.chunkId === input.chunkId);
    const targetIndex = insertionIndex >= 0
      ? retainedEntries.findIndex((entry) => entry.createdAt > conversation.entries[insertionIndex]!.createdAt)
      : -1;

    const insertedEntries: TranscriptEntry[] = input.entries
      .filter((entry) => entry.text.trim())
      .map((entry, index) => ({
        ...entry,
        id: compactId('entry'),
        conversationId: input.conversationId,
        chunkId: input.chunkId,
        createdAt: timestamp,
        updatedAt: timestamp,
        revision: 1,
        replacesEntryId: index === 0 ? firstQuick?.id : undefined,
        agentMarker: compactId('tr'),
      }));

    if (targetIndex >= 0) {
      retainedEntries.splice(targetIndex, 0, ...insertedEntries);
      conversation.entries = retainedEntries;
    } else if (insertionIndex >= 0) {
      const originalBefore = conversation.entries.slice(0, insertionIndex)
        .filter((entry) => !(entry.chunkId === input.chunkId && entry.source === 'quick'));
      const originalAfter = conversation.entries.slice(insertionIndex)
        .filter((entry) => !(entry.chunkId === input.chunkId && entry.source === 'quick'));
      conversation.entries = [...originalBefore, ...insertedEntries, ...originalAfter];
    } else {
      conversation.entries.push(...insertedEntries);
    }

    conversation.updatedAt = timestamp;
    await this.save();
    return { removedQuickEntries, insertedEntries };
  }

  async updateConversationAgent(conversationId: string, agent: AgentContextState): Promise<void> {
    const conversation = this.state.conversations[conversationId];
    if (!conversation) {
      return;
    }
    conversation.agent = {
      snapshot: agent.snapshot,
      sentEntryRevisions: { ...agent.sentEntryRevisions },
      lastAdviceAt: agent.lastAdviceAt,
    };
    conversation.updatedAt = nowIso();
    await this.save();
  }

  async updateTranscriptSpeakerLabels(input: {
    conversationId: string;
    chunkIds: string[];
    diarizationSpeaker?: string;
    speakerLabel: string;
  }): Promise<TranscriptEntry[]> {
    const conversation = this.state.conversations[input.conversationId];
    if (!conversation) {
      return [];
    }

    const timestamp = nowIso();
    const chunkIds = new Set(input.chunkIds);
    const updatedEntries: TranscriptEntry[] = [];

    for (const entry of conversation.entries) {
      if (!chunkIds.has(entry.chunkId)) {
        continue;
      }
      if (input.diarizationSpeaker && entry.diarizationSpeaker !== input.diarizationSpeaker) {
        continue;
      }
      if (entry.speakerLabel === input.speakerLabel) {
        continue;
      }

      entry.speakerLabel = input.speakerLabel;
      entry.updatedAt = timestamp;
      entry.revision += 1;
      updatedEntries.push({ ...entry });
    }

    if (updatedEntries.length > 0) {
      conversation.updatedAt = timestamp;
      await this.save();
    }

    return updatedEntries;
  }

  async recordRecognizedSpeakers(conversationId: string, speakerIds: string[]): Promise<void> {
    const conversation = this.state.conversations[conversationId];
    const uniqueSpeakerIds = Array.from(new Set(speakerIds.filter(Boolean)));
    if (!conversation || uniqueSpeakerIds.length === 0) {
      return;
    }

    const timestamp = nowIso();
    for (const speakerId of uniqueSpeakerIds) {
      const speaker = this.state.speakers[speakerId];
      if (!speaker) {
        continue;
      }
      speaker.usageCount += 1;
      speaker.lastSeenAt = timestamp;
      speaker.updatedAt = timestamp;
      if (!conversation.recognizedSpeakerIds.includes(speakerId)) {
        conversation.recognizedSpeakerIds.push(speakerId);
      }
    }

    for (const left of uniqueSpeakerIds) {
      for (const right of uniqueSpeakerIds) {
        if (left === right) {
          continue;
        }
        const speaker = this.state.speakers[left];
        if (speaker) {
          speaker.cooccurrence[right] = (speaker.cooccurrence[right] || 0) + 1;
        }
      }
    }

    conversation.updatedAt = timestamp;
    await this.save();
  }

  async upsertUnknownBuffer(input: {
    bufferId?: string;
    conversationId: string;
    diarizationSpeaker?: string;
    chunkId: string;
    audioPath: string;
    embeddingPath?: string;
    embeddingModel?: string;
    speechSeconds: number;
    chunkAt: string;
    unknownGapMs: number;
  }): Promise<UnknownCandidateBuffer> {
    const explicitBuffer = input.bufferId ? this.state.unknownBuffers[input.bufferId] : undefined;
    const buffers = explicitBuffer
      ? [explicitBuffer]
      : Object.values(this.state.unknownBuffers)
        .filter((buffer) =>
          buffer.conversationId === input.conversationId
          && (buffer.diarizationSpeaker || '') === (input.diarizationSpeaker || '')
        )
        .sort((a, b) => b.lastChunkAt.localeCompare(a.lastChunkAt));
    const latest = buffers[0];
    const latestAt = latest ? new Date(latest.lastChunkAt).getTime() : 0;
    const nextAt = new Date(input.chunkAt).getTime();
    const shouldExtend = !!explicitBuffer || !!latest && Number.isFinite(latestAt) && Number.isFinite(nextAt)
      && Math.abs(nextAt - latestAt) <= input.unknownGapMs;
    const timestamp = nowIso();
    const buffer: UnknownCandidateBuffer = shouldExtend && latest
      ? latest
      : {
        id: compactId('unknown'),
        conversationId: input.conversationId,
        diarizationSpeaker: input.diarizationSpeaker,
        createdAt: timestamp,
        updatedAt: timestamp,
        lastChunkAt: input.chunkAt,
        chunkIds: [],
        audioPaths: [],
        embeddingPaths: [],
        speechSeconds: 0,
      };

    if (!buffer.chunkIds.includes(input.chunkId)) {
      buffer.chunkIds.push(input.chunkId);
      buffer.audioPaths.push(input.audioPath);
      buffer.speechSeconds += Math.max(0, input.speechSeconds);
    }
    if (input.embeddingPath) {
      const embeddingPaths = buffer.embeddingPaths ?? (buffer.embeddingPath ? [buffer.embeddingPath] : []);
      if (!embeddingPaths.includes(input.embeddingPath)) {
        embeddingPaths.push(input.embeddingPath);
      }
      buffer.embeddingPaths = embeddingPaths;
      buffer.embeddingPath = input.embeddingPath;
      buffer.embeddingModel = input.embeddingModel;
    }
    buffer.updatedAt = timestamp;
    buffer.lastChunkAt = input.chunkAt;
    this.state.unknownBuffers[buffer.id] = buffer;
    await this.save();
    return buffer;
  }

  async removeUnknownBuffer(bufferId: string): Promise<void> {
    delete this.state.unknownBuffers[bufferId];
    await this.save();
  }

  async addPendingSpeaker(input: {
    conversationId: string;
    diarizationSpeaker: string;
    samplePath: string;
    embeddingPath?: string;
    embeddingModel?: string;
    speechSeconds: number;
    confidenceSummary?: PendingSpeakerProposal['confidenceSummary'];
  }): Promise<PendingSpeakerProposal> {
    const timestamp = nowIso();
    const proposal: PendingSpeakerProposal = {
      id: compactId('spk_tmp'),
      conversationId: input.conversationId,
      createdAt: timestamp,
      updatedAt: timestamp,
      status: 'pending',
      diarizationSpeaker: input.diarizationSpeaker,
      samplePath: input.samplePath,
      embeddingPath: input.embeddingPath,
      embeddingModel: input.embeddingModel,
      speechSeconds: input.speechSeconds,
      confidenceSummary: input.confidenceSummary,
    };
    this.state.pendingSpeakers[proposal.id] = proposal;
    await this.save();
    return proposal;
  }

  async markPendingSpeakerDelivered(conversationId: string, proposalIds: string[]): Promise<void> {
    const conversation = this.state.conversations[conversationId];
    if (!conversation) {
      return;
    }
    for (const proposalId of proposalIds) {
      if (!conversation.deliveredProposalIds.includes(proposalId)) {
        conversation.deliveredProposalIds.push(proposalId);
      }
    }
    conversation.updatedAt = nowIso();
    await this.save();
  }

  async createSpeaker(input: {
    name: string;
    description?: string;
    samplePath: string;
    embeddingPath?: string;
    embeddingModel?: string;
  }): Promise<SpeakerRecord> {
    const timestamp = nowIso();
    const speaker: SpeakerRecord = {
      id: compactId('spk'),
      name: input.name.trim(),
      description: input.description?.trim(),
      createdAt: timestamp,
      updatedAt: timestamp,
      samplePath: input.samplePath,
      embeddingPath: input.embeddingPath,
      embeddingCreatedAt: input.embeddingPath ? timestamp : undefined,
      embeddingModel: input.embeddingModel,
      usageCount: 0,
      cooccurrence: {},
    };
    this.state.speakers[speaker.id] = speaker;
    await this.save();
    return speaker;
  }

  async updateSpeakerSampleAndEmbedding(input: {
    speakerId: string;
    samplePath: string;
    embeddingPath?: string;
    embeddingModel?: string;
    description?: string;
  }): Promise<SpeakerRecord | undefined> {
    const speaker = this.state.speakers[input.speakerId];
    if (!speaker) {
      return undefined;
    }
    const timestamp = nowIso();
    speaker.samplePath = input.samplePath;
    if (input.description !== undefined) {
      speaker.description = input.description.trim();
    }
    if (input.embeddingPath !== undefined) {
      speaker.embeddingPath = input.embeddingPath;
      speaker.embeddingCreatedAt = timestamp;
      speaker.embeddingModel = input.embeddingModel;
    }
    speaker.updatedAt = timestamp;
    await this.save();
    return speaker;
  }

  async resolvePendingSpeaker(tempId: string, speakerId: string | undefined, dismiss = false): Promise<void> {
    const proposal = this.state.pendingSpeakers[tempId];
    if (!proposal) {
      return;
    }
    proposal.status = dismiss ? 'dismissed' : 'resolved';
    proposal.resolvedSpeakerId = speakerId;
    proposal.updatedAt = nowIso();
    await this.save();
  }

  async updateSpeakerEmbedding(input: {
    speakerId: string;
    embeddingPath: string;
    embeddingModel?: string;
  }): Promise<void> {
    const speaker = this.state.speakers[input.speakerId];
    if (!speaker) {
      return;
    }
    const timestamp = nowIso();
    speaker.embeddingPath = input.embeddingPath;
    speaker.embeddingCreatedAt = timestamp;
    speaker.embeddingModel = input.embeddingModel;
    speaker.updatedAt = timestamp;
    await this.save();
  }

  async recordKnownScore(score: number, margin: number): Promise<void> {
    this.pushScore(this.state.scoreStats.knownScores, score);
    this.pushScore(this.state.scoreStats.knownMargins, margin);
    await this.save();
  }

  async recordUnknownScore(score: number, margin: number): Promise<void> {
    this.pushScore(this.state.scoreStats.unknownTopScores, score);
    this.pushScore(this.state.scoreStats.unknownMargins, margin);
    await this.save();
  }

  getSpeakerSamplePathForName(name: string): string {
    return path.join(this.speakerSamplesDir, `${sanitizePathSegment(name)}-${compactId('sample')}.wav`);
  }

  getSpeakerEmbeddingPathForName(name: string): string {
    return path.join(this.speakerEmbeddingsDir, `${sanitizePathSegment(name)}-${compactId('embedding')}.ecapa.json`);
  }

  getPendingSamplePath(tempName = 'unknown'): string {
    return path.join(this.pendingSamplesDir, `${sanitizePathSegment(tempName)}-${compactId('sample')}.wav`);
  }

  getPendingEmbeddingPath(tempName = 'unknown'): string {
    return path.join(this.pendingEmbeddingsDir, `${sanitizePathSegment(tempName)}-${compactId('embedding')}.ecapa.json`);
  }

  getTempEmbeddingPath(tempName = 'unknown'): string {
    return path.join(this.tempDir, `${sanitizePathSegment(tempName)}-${compactId('embedding')}.ecapa.json`);
  }

  getTempPath(name: string): string {
    const parsed = path.parse(name);
    const baseName = sanitizePathSegment(parsed.name || name);
    const ext = sanitizePathSegment(parsed.ext).startsWith('.') ? sanitizePathSegment(parsed.ext) : '';
    return path.join(this.tempDir, `${baseName}-${compactId('tmp')}${ext}`);
  }

  private resolveConversationForTimestamp(clientTimestamp: string, conversationGapMs: number): ConversationRecord {
    const current = this.getCurrentConversation();
    const clientMs = new Date(clientTimestamp).getTime();
    const lastMs = current ? new Date(current.lastChunkAt).getTime() : 0;
    const shouldReuse = current && Number.isFinite(clientMs) && Number.isFinite(lastMs)
      && Math.abs(clientMs - lastMs) <= conversationGapMs;
    if (shouldReuse) {
      return current;
    }

    const timestamp = nowIso();
    const conversation: ConversationRecord = {
      id: compactId('conv'),
      startedAt: clientTimestamp,
      updatedAt: timestamp,
      lastChunkAt: clientTimestamp,
      chunkIds: [],
      entries: [],
      recognizedSpeakerIds: [],
      deliveredProposalIds: [],
      agent: {
        sentEntryRevisions: {},
      },
    };
    this.state.conversations[conversation.id] = conversation;
    return conversation;
  }

  private normalizeTimestamp(raw: string | number | undefined, fallback: string): string {
    if (typeof raw === 'number' && Number.isFinite(raw)) {
      const timestamp = raw > 10_000_000_000 ? raw : raw * 1000;
      return new Date(timestamp).toISOString();
    }
    if (typeof raw === 'string' && raw.trim()) {
      const parsed = new Date(raw);
      if (!Number.isNaN(parsed.getTime())) {
        return parsed.toISOString();
      }
    }
    return fallback;
  }

  private extensionForMimeType(mimeType: string | undefined): string | null {
    const normalized = String(mimeType || '').toLowerCase();
    if (normalized.includes('wav')) return '.wav';
    if (normalized.includes('mpeg') || normalized.includes('mp3')) return '.mp3';
    if (normalized.includes('mp4') || normalized.includes('m4a')) return '.m4a';
    if (normalized.includes('ogg')) return '.ogg';
    if (normalized.includes('webm')) return '.webm';
    return null;
  }

  private pushScore(target: number[], value: number): void {
    if (!Number.isFinite(value)) {
      return;
    }
    target.push(value);
    if (target.length > MAX_SCORE_SAMPLES) {
      target.splice(0, target.length - MAX_SCORE_SAMPLES);
    }
  }

  private async save(): Promise<void> {
    const payload = JSON.stringify(this.state, null, 2);
    this.saveQueue = this.saveQueue
      .catch(() => undefined)
      .then(() => this.writeStateFile(payload));
    await this.saveQueue;
  }

  private async writeStateFile(payload: string): Promise<void> {
    const tmpPath = `${this.statePath}.${process.pid}.${compactId('tmp')}.tmp`;
    try {
      await writeFile(tmpPath, payload, 'utf8');
      for (let attempt = 0; ; attempt += 1) {
        try {
          await rename(tmpPath, this.statePath);
          return;
        } catch (error) {
          if (attempt >= STATE_WRITE_RETRIES || !isRetryableFsError(error)) {
            throw error;
          }
          await sleep(STATE_WRITE_RETRY_BASE_MS * 2 ** attempt);
        }
      }
    } finally {
      await rm(tmpPath, { force: true }).catch(() => undefined);
    }
  }
}
