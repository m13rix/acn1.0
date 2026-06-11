import type { SessionSnapshot } from '../../core/Session.js';

export const REALTIME_ADVISOR_INTERFACE = 'realtime-advisor';
export const REALTIME_ADVISOR_ROUTE_ID = 'realtime-advisor:default';

export type TranscriptEntrySource = 'quick' | 'pyannote';
export type SpeakerProposalStatus = 'pending' | 'resolved' | 'dismissed';

export interface RealtimeAdvisorConfig {
  port: number;
  host: string;
  publicBaseUrl?: string;
  dataDir: string;
  agentName: string;
  conversationGapMs: number;
  unknownGapMs: number;
  unknownMinSpeechSeconds: number;
  speakerSampleMaxSeconds: number;
  ecapaPythonPath: string;
  ecapaModelCache: string;
  ecapaSampleRate: number;
  ecapaBatchSize: number;
  ecapaChunkSeconds: number;
  ecapaOverlapSeconds: number;
  ecapaFp16: boolean;
  ecapaDevice: string;
  pyannoteApiKey?: string;
  pyannoteApiBaseUrl: string;
  mockPyannote: boolean;
  autoOpenClient: boolean;
  maxUploadBytes: number;
  localhostRunEnabled: boolean;
  localhostRunHost: string;
}

export interface RealtimeChunkMetadata {
  chunkId?: string;
  quickTranscript?: string;
  immediateAdvice?: boolean;
  timestamp?: string | number;
  language?: string;
  metadata?: Record<string, unknown>;
}

export interface StoredAudioChunk {
  id: string;
  conversationId: string;
  receivedAt: string;
  clientTimestamp: string;
  audioPath: string;
  mimeType: string;
  quickTranscript: string;
  durationSeconds?: number;
  metadata?: Record<string, unknown>;
  pyannote?: {
    diarizationJobId?: string;
    status: 'queued' | 'running' | 'succeeded' | 'failed' | 'skipped';
    error?: string;
  };
}

export interface TranscriptEntry {
  id: string;
  chunkId: string;
  conversationId: string;
  source: TranscriptEntrySource;
  createdAt: string;
  updatedAt: string;
  startTime: string;
  endTime?: string;
  speakerLabel: string;
  diarizationSpeaker?: string;
  text: string;
  final: boolean;
  revision: number;
  replacesEntryId?: string;
  agentMarker: string;
}

export interface AgentContextState {
  snapshot?: SessionSnapshot;
  sentEntryRevisions: Record<string, number>;
  lastAdviceAt?: string;
}

export interface ConversationRecord {
  id: string;
  startedAt: string;
  updatedAt: string;
  lastChunkAt: string;
  chunkIds: string[];
  entries: TranscriptEntry[];
  recognizedSpeakerIds: string[];
  deliveredProposalIds: string[];
  agent: AgentContextState;
}

export interface SpeakerRecord {
  id: string;
  name: string;
  description?: string;
  createdAt: string;
  updatedAt: string;
  samplePath: string;
  embeddingPath?: string;
  embeddingCreatedAt?: string;
  embeddingModel?: string;
  usageCount: number;
  lastSeenAt?: string;
  cooccurrence: Record<string, number>;
}

export interface PendingSpeakerProposal {
  id: string;
  conversationId: string;
  createdAt: string;
  updatedAt: string;
  status: SpeakerProposalStatus;
  diarizationSpeaker: string;
  samplePath: string;
  embeddingPath?: string;
  embeddingModel?: string;
  speechSeconds: number;
  confidenceSummary?: SpeakerConfidenceSummary;
  resolvedSpeakerId?: string;
}

export interface SpeakerConfidenceSummary {
  topLabel?: string;
  topScore?: number;
  secondLabel?: string;
  secondScore?: number;
  margin?: number;
  cleanSpeechSeconds?: number;
  agreeingSegments?: number;
  coherenceMinPairwise?: number;
  coherenceMeanPairwise?: number;
  coherenceWindows?: number;
  rejectedReason?: string;
}

export interface UnknownCandidateBuffer {
  id: string;
  conversationId: string;
  diarizationSpeaker?: string;
  createdAt: string;
  updatedAt: string;
  lastChunkAt: string;
  chunkIds: string[];
  audioPaths: string[];
  embeddingPaths?: string[];
  embeddingPath?: string;
  embeddingModel?: string;
  speechSeconds: number;
}

export interface RealtimeAdvisorState {
  version: 1;
  conversations: Record<string, ConversationRecord>;
  chunks: Record<string, StoredAudioChunk>;
  speakers: Record<string, SpeakerRecord>;
  pendingSpeakers: Record<string, PendingSpeakerProposal>;
  unknownBuffers: Record<string, UnknownCandidateBuffer>;
  scoreStats: AdaptiveScoreStats;
}

export interface AdaptiveScoreStats {
  knownScores: number[];
  knownMargins: number[];
  unknownTopScores: number[];
  unknownMargins: number[];
}

export interface SpeakerEmbeddingCandidate {
  speakerId: string;
  label: string;
  embeddingPath: string;
  embedding: number[];
}

export interface AdaptiveThresholds {
  confirmedScore: number;
  confirmedMargin: number;
  cleanSpeechSeconds: number;
  agreeingSegments: number;
  unknownScoreCeiling: number;
  unknownMargin: number;
}

export interface DiarizationSegment {
  speaker: string;
  start: number;
  end: number;
  confidence?: Record<string, number>;
}

export interface TurnLevelTranscript {
  speaker: string;
  start: number;
  end: number;
  text: string;
}

export interface PyannoteJob<TOutput = Record<string, unknown>> {
  jobId: string;
  status: 'pending' | 'created' | 'running' | 'succeeded' | 'canceled' | 'failed';
  createdAt?: string;
  updatedAt?: string;
  output?: TOutput;
  warning?: string;
  error?: string;
}

export interface PyannoteDiarizationOutput {
  diarization?: DiarizationSegment[];
  exclusiveDiarization?: DiarizationSegment[];
  turnLevelTranscription?: TurnLevelTranscript[];
  wordLevelTranscription?: Array<{
    speaker: string;
    start: number;
    end: number;
    text: string;
  }>;
  warning?: string;
  error?: string;
}

export interface ResolvedChunkProcessing {
  transcriptEntries: TranscriptEntry[];
  recognizedSpeakerIds: string[];
  pendingSpeakers: PendingSpeakerProposal[];
}

export interface SpeakerResolutionRequest {
  tempId: string;
  name?: string;
  description?: string;
  existingSpeakerId?: string;
  dismiss?: boolean;
}
