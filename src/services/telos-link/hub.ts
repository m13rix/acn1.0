import type express from 'express';
import { mkdir } from 'fs/promises';
import path from 'path';
import { randomBytes } from 'crypto';

import {
  HttpTransport,
  TelosLinkNode,
  type PayloadEvent,
  type SendPayloadInput,
} from '@telos/link-node';
import {
  decodeFileManifest,
  encodeJsonInvite,
  utf8Decode,
  type Contact,
  type FileManifest,
  type PeerRouteHint,
} from '@telos/link-core';

import type {
  TelosLinkAudioChunkInput,
  TelosLinkEventEnvelope,
  TelosLinkInboundHandlers,
  TelosLinkPublishInput,
} from './types.js';

function jsonError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function nowIso(): string {
  return new Date().toISOString();
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isRetryableFileFetchError(error: unknown): boolean {
  const message = jsonError(error).toLowerCase();
  return message.includes('unable to fetch file chunk')
    || message.includes('fetch failed')
    || message.includes('timeout')
    || message.includes('not found')
    || message.includes('econnreset')
    || message.includes('socket');
}

function priorityToImportance(priority: TelosLinkPublishInput['priority']): SendPayloadInput['delivery'] {
  if (priority === 'realtime') return { mode: 'auto', importance: 'urgent', ttlSeconds: 60 };
  if (priority === 'high') return { mode: 'auto', importance: 'high', ttlSeconds: 3600 };
  return { mode: 'auto', importance: 'normal', ttlSeconds: 7 * 86_400 };
}

function parseJsonBytes(bytes: Uint8Array): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(utf8Decode(bytes)) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

function boolFromUnknown(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  const raw = String(value || '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

export class TelosLinkCommunicationHub {
  private node: TelosLinkNode | null = null;
  private bootstrapNode: TelosLinkNode | null = null;
  private transport: HttpTransport | null = null;
  private endpointBaseUrl = '';
  private pairingToken = '';
  private pairingPayload = '';
  private pairingUrl = '';
  private readonly processingChunkIds = new Set<string>();
  private readonly deferredFileChunkFetches = new Map<string, {
    event: PayloadEvent;
    manifest: FileManifest;
    metadata: Record<string, unknown>;
    chunkId: string;
  }>();
  private readonly handledAudioChunkIds = new Map<string, number>();

  constructor(
    private readonly dataDir: string,
    private readonly handlers: TelosLinkInboundHandlers,
  ) {}

  async initialize(endpointBaseUrl?: string): Promise<void> {
    await mkdir(this.dataDir, { recursive: true });
    const storagePath = path.join(this.dataDir, 'node');
    this.bootstrapNode = await TelosLinkNode.create({
      storagePath,
      device: { name: 'Realtime Advisor Server', type: 'server' },
    });
    this.transport = new HttpTransport({
      storage: this.bootstrapNode.storage,
      listen: false,
      endpoint: endpointBaseUrl,
    });
    this.node = await TelosLinkNode.create({
      storagePath,
      transport: this.transport,
      device: { name: 'Realtime Advisor Server', type: 'server' },
      relay: { enabled: true },
    });
    this.node.on('payload', (event) => {
      void this.handlePayload(event).catch((error) => {
        console.warn(`[telos-link] payload handling failed: ${jsonError(error)}`);
      });
    });
    await this.node.start();
    this.setEndpointBaseUrl(endpointBaseUrl || '');
  }

  async close(): Promise<void> {
    await this.node?.stop().catch(() => undefined);
    this.node = null;
    this.transport = null;
    this.bootstrapNode?.storage.close();
    this.bootstrapNode = null;
  }

  mount(app: express.Express): void {
    app.use((req, res, next) => {
      if (!req.path.startsWith('/telos/link')) {
        next();
        return;
      }
      const transport = this.transport;
      if (!transport) {
        res.status(503).send('Telos Link transport is not ready.');
        return;
      }
      transport.handle(req, res)
        .then((handled) => {
          if (!handled) next();
        })
        .catch(next);
    });

    app.get('/v1/link/health', async (_req, res) => {
      const node = this.requireNode();
      if (this.endpointBaseUrl && !this.pairingPayload) {
        await this.refreshPairingPayload();
      }
      res.json({
        success: true,
        peerId: node.identity.device.peerId,
        userId: node.identity.user.userId,
        endpoint: this.endpointBaseUrl || undefined,
        pairingUrl: this.pairingUrl || undefined,
        pairingPayload: this.pairingPayload || undefined,
        contacts: this.contacts().map((contact) => ({
          userId: contact.userId,
          trustState: contact.trustState,
          devices: Object.keys(contact.knownDevices),
        })),
      });
    });
  }

  setEndpointBaseUrl(endpointBaseUrl: string): void {
    this.endpointBaseUrl = endpointBaseUrl.replace(/\/+$/, '');
    this.transport?.setEndpoint(this.endpointBaseUrl || undefined);
    if (this.endpointBaseUrl && this.node) {
      this.node.storage.savePeer({
        peerId: this.node.identity.device.peerId,
        httpEndpoint: this.endpointBaseUrl,
        updatedAt: Date.now(),
      });
      void this.refreshPairingPayload().catch((error) => {
        console.warn(`[telos-link] pairing payload refresh failed: ${jsonError(error)}`);
      });
    }
  }

  async publish<TPayload>(input: TelosLinkPublishInput<TPayload>): Promise<void> {
    const node = this.requireNode();
    const message: TelosLinkEventEnvelope<TPayload> = {
      version: 1,
      app: 'realtime-advisor',
      type: input.type,
      priority: input.priority || 'normal',
      createdAt: nowIso(),
      source: input.source,
      conversationId: input.conversationId,
      payload: input.payload,
    };
    const contacts = this.contacts();
    if (contacts.length === 0) {
      console.warn(`[telos-link] no paired contacts for ${input.type}; event kept in server state only`);
      return;
    }
    const bytes = Buffer.from(JSON.stringify(message), 'utf8');
    await Promise.all(contacts.map(async (contact) => {
      await node.sendPayload({
        targetUserId: contact.userId,
        kind: 'json',
        contentType: 'application/vnd.telos.realtime-advisor.event+json',
        bytes,
        metadata: {
          app: 'realtime-advisor',
          type: input.type,
          priority: input.priority || 'normal',
        },
        delivery: input.ttlMs
          ? { mode: 'auto', importance: input.priority === 'realtime' ? 'urgent' : 'normal', ttlSeconds: Math.max(1, Math.floor(input.ttlMs / 1000)) }
          : priorityToImportance(input.priority),
        conversationId: input.conversationId,
      });
    }));
  }

  private async refreshPairingPayload(): Promise<void> {
    const node = this.requireNode();
    const routeHint: PeerRouteHint = {
      peerId: node.identity.device.peerId,
      httpEndpoint: this.endpointBaseUrl,
      updatedAt: Date.now(),
    };
    const invite = encodeJsonInvite(await node.identity.createContactInviteCard({
      expiresInSeconds: 30 * 24 * 60 * 60,
      routeHints: [routeHint],
    }));
    this.pairingToken = this.pairingToken || randomBytes(9).toString('base64url');
    this.transport?.publishPairingInvite(this.pairingToken, invite, (peerInvite) => {
      const contact = node.contacts.addFromInvite(peerInvite);
      console.log(`[telos-link] paired contact ${contact.userId}`);
    });
    this.pairingUrl = new URL(`/telos/link/invite/1.0.0/${this.pairingToken}`, this.endpointBaseUrl).toString();
    this.pairingPayload = `telos-pair:${this.pairingUrl}`;
  }

  private async handlePayload(event: PayloadEvent): Promise<void> {
    const node = this.requireNode();
    node.contacts.findDevice(event.originPeerId) ?? node.storage.saveDeviceCertificate(event.originDeviceCertificate);

    if (event.kind === 'file-manifest') {
      const manifest = decodeFileManifest(event.bytes);
      const metadata: Record<string, unknown> = {
        ...(event.metadata || {}),
        type: event.metadata?.type || 'chunk.audio',
        mimeType: event.metadata?.mimeType || manifest.contentType,
      };
      const chunkId = typeof metadata.chunkId === 'string' ? metadata.chunkId.trim() : '';
      if (chunkId) {
        if (this.wasAudioChunkHandledRecently(chunkId)) {
          console.warn(`[telos-link] duplicate file chunk ignored before fetch: ${chunkId}`);
          return;
        }
        if (this.processingChunkIds.has(chunkId)) {
          this.deferredFileChunkFetches.set(chunkId, {
            event,
            manifest,
            metadata,
            chunkId,
          });
          console.warn(`[telos-link] duplicate file chunk queued for retry after current fetch: ${chunkId}`);
          return;
        }
      }
      this.queueAudioFileFetch({
        event,
        manifest,
        metadata,
        chunkId,
      });
      return;
    }

    const body = event.kind === 'json' ? parseJsonBytes(event.bytes) : undefined;
    const binaryMetadata = event.kind === 'binary' ? event.metadata : undefined;
    if (!body && !binaryMetadata) return;
    const message = body || binaryMetadata || {};
    const type = String(message.type || message.messageType || '').trim();
    if (type === 'chunk.quick' || type === 'realtime.chunk.quick') {
      await this.handlers.onQuickTranscript?.({
        metadata: message,
        originPeerId: event.originPeerId,
        originUserId: event.originUserId,
        envelopeId: event.envelopeId,
      });
      return;
    }
    if (type === 'chunk.audio' || type === 'realtime.chunk.audio') {
      const chunkId = typeof message.chunkId === 'string' ? message.chunkId.trim() : '';
      if (chunkId && this.wasAudioChunkHandledRecently(chunkId)) {
        console.warn(`[telos-link] duplicate audio chunk ignored before handler: ${chunkId}`);
        return;
      }
      await this.handlers.onAudioChunk({
        metadata: message,
        audioBuffer: event.kind === 'binary'
          ? Buffer.from(event.bytes)
          : typeof message.audioBase64 === 'string'
            ? Buffer.from(message.audioBase64, 'base64')
            : undefined,
        mimeType: typeof message.mimeType === 'string'
          ? message.mimeType
          : event.kind === 'binary'
            ? event.contentType
            : undefined,
        fileName: typeof message.fileName === 'string' ? message.fileName : undefined,
        originPeerId: event.originPeerId,
        originUserId: event.originUserId,
        envelopeId: event.envelopeId,
      });
      if (chunkId) this.markAudioChunkHandled(chunkId);
      return;
    }
    if (type === 'speaker.resolve' || type === 'realtime.speaker.resolve') {
      await this.handlers.onSpeakerResolution?.(message);
      return;
    }
    if (type === 'advisor.trigger' || type === 'realtime.advisor.trigger') {
      await this.handlers.onAdviceTrigger?.({
        ...message,
        immediateAdvice: boolFromUnknown(message.immediateAdvice ?? true),
      });
      return;
    }
    if (type === 'telos.smartphone.data.response') {
      await this.handlers.onSmartphoneDataResponse?.(message);
      return;
    }
    if (type === 'telos.music.history.response') {
      await this.handlers.onMusicHistoryResponse?.(message);
    }
  }

  private async fetchAndHandleAudioFile(input: {
    event: PayloadEvent;
    manifest: FileManifest;
    metadata: Record<string, unknown>;
    chunkId: string;
  }): Promise<void> {
    const node = this.requireNode();
    let fetched: Awaited<ReturnType<typeof node.files.fetch>> | null = null;
    let lastError: unknown;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        fetched = await node.files.fetch({ manifest: input.manifest, sourcePeerIds: [input.event.originPeerId] });
        break;
      } catch (error) {
        lastError = error;
        if (!isRetryableFileFetchError(error) || attempt === 3) {
          throw error;
        }
        await sleep(250 * (attempt + 1));
      }
    }
    if (!fetched) {
      throw lastError instanceof Error ? lastError : new Error(String(lastError || 'Unable to fetch file chunk'));
    }
    await this.handlers.onAudioChunk({
      metadata: input.metadata,
      audioBuffer: Buffer.from(fetched.bytes),
      mimeType: typeof input.metadata.mimeType === 'string' ? input.metadata.mimeType : input.manifest.contentType,
      fileName: input.manifest.fileName,
      originPeerId: input.event.originPeerId,
      originUserId: input.event.originUserId,
      envelopeId: input.event.envelopeId,
    });
    if (input.chunkId) this.markAudioChunkHandled(input.chunkId);
  }

  private queueAudioFileFetch(input: {
    event: PayloadEvent;
    manifest: FileManifest;
    metadata: Record<string, unknown>;
    chunkId: string;
  }): void {
    if (input.chunkId) this.processingChunkIds.add(input.chunkId);
    let failure: unknown;
    void this.fetchAndHandleAudioFile(input).catch((error) => {
      failure = error;
    }).finally(() => {
      if (!input.chunkId) {
        if (failure) {
          console.warn(`[telos-link] file chunk handling failed: ${jsonError(failure)}`);
        }
        return;
      }

      this.processingChunkIds.delete(input.chunkId);
      const deferred = this.deferredFileChunkFetches.get(input.chunkId);
      this.deferredFileChunkFetches.delete(input.chunkId);
      if (deferred && !this.wasAudioChunkHandledRecently(input.chunkId)) {
        this.queueAudioFileFetch(deferred);
        return;
      }
      if (failure) {
        console.warn(`[telos-link] file chunk handling failed: ${jsonError(failure)}`);
      }
    });
  }

  private wasAudioChunkHandledRecently(chunkId: string): boolean {
    this.pruneHandledAudioChunks();
    return this.handledAudioChunkIds.has(chunkId);
  }

  private markAudioChunkHandled(chunkId: string): void {
    this.handledAudioChunkIds.set(chunkId, Date.now());
    this.pruneHandledAudioChunks();
  }

  private pruneHandledAudioChunks(): void {
    const cutoff = Date.now() - 10 * 60 * 1000;
    for (const [chunkId, seenAt] of this.handledAudioChunkIds) {
      if (seenAt < cutoff || this.handledAudioChunkIds.size > 4096) {
        this.handledAudioChunkIds.delete(chunkId);
      }
    }
  }

  private contacts(): Contact[] {
    return this.node?.contacts.list().filter((contact) => contact.trustState !== 'blocked') || [];
  }

  private requireNode(): TelosLinkNode {
    if (!this.node) {
      throw new Error('Telos Link node is not initialized.');
    }
    return this.node;
  }
}
