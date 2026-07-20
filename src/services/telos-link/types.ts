export type TelosLinkEventPriority = 'normal' | 'high' | 'realtime';

export interface TelosLinkEventEnvelope<TPayload = unknown> {
  version: 1;
  app: 'realtime-advisor';
  type: string;
  priority: TelosLinkEventPriority;
  createdAt: string;
  source?: string;
  conversationId?: string;
  payload: TPayload;
}

export interface TelosLinkPublishInput<TPayload = unknown> {
  type: string;
  priority?: TelosLinkEventPriority;
  source?: string;
  conversationId?: string;
  payload: TPayload;
  ttlMs?: number;
}

export interface TelosLinkAudioChunkInput {
  metadata: Record<string, unknown>;
  audioBuffer?: Buffer;
  mimeType?: string;
  fileName?: string;
  originPeerId: string;
  originUserId: string;
  envelopeId: string;
}

export interface TelosLinkInboundHandlers {
  onAudioChunk(input: TelosLinkAudioChunkInput): Promise<void>;
  onQuickTranscript?(input: TelosLinkAudioChunkInput): Promise<void>;
  onSpeakerResolution?(input: Record<string, unknown>): Promise<void>;
  onAdviceTrigger?(input: Record<string, unknown>): Promise<void>;
  onSmartphoneDataResponse?(input: Record<string, unknown>): Promise<void>;
  onMusicHistoryResponse?(input: Record<string, unknown>): Promise<void>;
}
