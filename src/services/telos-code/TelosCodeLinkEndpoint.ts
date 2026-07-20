import { createHash, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import type { TelosCodeCommand } from '@telos/code-contracts/telos';
import {
  TELOS_CODE_APP_ID,
  TELOS_CODE_STREAM_PROTOCOL,
} from '@telos/code-contracts/telos';
import {
  decodeWire,
  encodeDirectPairingCode,
  encodeFullDirectPairingPayload,
  encodeWire,
  fingerprint,
  type AppAuthorizationRecord,
  type AppAuthorizationRequest,
  type AppSessionProof,
} from '@telos/link-core';
import type { AppStream, IncomingAppStream, TelosLinkNode } from '@telos/link-node';

import { ThreadService } from '../ThreadService.js';
import { ThreadStore } from '../thread-store/ThreadStore.js';
import type { HarnessThread } from '../thread-store/types.js';
import { WorkspaceSnapshotService } from '../WorkspaceSnapshotService.js';
import { TelosCodeCatalogService } from './TelosCodeCatalogService.js';

const PAIRING_TTL_MS = 10 * 60 * 1000;
const SESSION_HANDSHAKE_TIMEOUT_MS = 15_000;
const FULL_CAPABILITIES = [
  'threads',
  'projects',
  'workspace',
  'terminal',
  'git',
  'preview',
  'attachments',
  'app-client',
] as const;

export interface TelosCodePairingSession {
  code: string;
  words: [string, string, string, string, string, string];
  channelId: string;
  route: { host: string; port: number };
  fullAddress?: string;
  expiresAt: string;
}

export interface TelosCodeClientApproval {
  appInstanceId: string;
  deviceName: string;
  fingerprint: string;
  expiresAt: string;
}

export interface TelosCodeLinkEndpointOptions {
  harnessId: string;
  approveClient(request: TelosCodeClientApproval): boolean | Promise<boolean>;
  workspaceSnapshots?: WorkspaceSnapshotService;
  catalog?: TelosCodeCatalogService;
  now?: () => Date;
  onRouteVerified?(route: string): void | Promise<void>;
}

interface PendingPairing {
  nonce: Uint8Array;
  expiresAt: number;
  public: TelosCodePairingSession;
}

type ProtocolMessage = Record<string, unknown> & { type: string };

export class TelosCodeLinkEndpoint {
  private readonly pairing = new Map<string, PendingPairing>();
  private readonly activeStreams = new Map<string, Set<AppStream>>();
  private readonly now: () => Date;
  private readonly catalog: TelosCodeCatalogService;
  private unregister: (() => Promise<void>) | null = null;

  public constructor(
    private readonly node: TelosLinkNode,
    private readonly threads: ThreadService,
    private readonly store: ThreadStore,
    private readonly options: TelosCodeLinkEndpointOptions,
  ) {
    this.now = options.now || (() => new Date());
    this.catalog = options.catalog || new TelosCodeCatalogService();
  }

  public async start(): Promise<void> {
    if (this.unregister) return;
    this.unregister = await this.node.handleAppStream(
      { appId: TELOS_CODE_APP_ID, protocol: TELOS_CODE_STREAM_PROTOCOL },
      (incoming) => this.acceptIncoming(incoming),
    );
  }

  public async close(): Promise<void> {
    await this.unregister?.();
    this.unregister = null;
    const streams = [...this.activeStreams.values()].flatMap((items) => [...items]);
    this.activeStreams.clear();
    await Promise.all(streams.map((stream) => stream.cancel('Telos Code endpoint closed').catch(() => undefined)));
  }

  public beginPairing(input: { host: string; port: number; fullAddress?: string }): TelosCodePairingSession {
    this.prunePairings();
    const encoded = encodeDirectPairingCode({ host: input.host, port: input.port });
    const nonceKey = Buffer.from(encoded.nonce).toString('base64url');
    const expiresAt = this.now().getTime() + PAIRING_TTL_MS;
    const session: TelosCodePairingSession = {
      code: encoded.code,
      words: encoded.words,
      channelId: `pair:${nonceKey}`,
      route: encoded.route,
      fullAddress: encodeFullDirectPairingPayload({
        route: input.fullAddress || `/ip4/${input.host}/tcp/${input.port}`,
        nonce: encoded.nonce,
      }),
      expiresAt: new Date(expiresAt).toISOString(),
    };
    this.pairing.set(nonceKey, { nonce: encoded.nonce, expiresAt, public: session });
    return session;
  }

  public async revokeClient(appInstanceId: string): Promise<void> {
    const revokedAt = this.now().getTime();
    this.node.apps.revoke(appInstanceId, revokedAt);
    this.store.revokeAppClient(appInstanceId, new Date(revokedAt).toISOString());
    const streams = [...(this.activeStreams.get(appInstanceId) || [])];
    this.activeStreams.delete(appInstanceId);
    await Promise.all(streams.map((stream) => stream.cancel('Telos Code authorization revoked').catch(() => undefined)));
  }

  public async acceptIncoming(incoming: IncomingAppStream): Promise<void> {
    if (incoming.appId !== TELOS_CODE_APP_ID || incoming.protocol !== TELOS_CODE_STREAM_PROTOCOL) {
      await incoming.stream.cancel('Unsupported application protocol');
      return;
    }
    if (incoming.channelId.startsWith('pair:')) {
      try {
        await this.acceptPairing(incoming);
      } catch (error) {
        await this.send(incoming.stream, {
          type: 'pairing.result',
          approved: false,
          error: error instanceof Error ? error.message : String(error),
        }).catch(() => undefined);
        await incoming.stream.cancel('Telos Code pairing failed').catch(() => undefined);
      }
      return;
    }
    const iterator = incoming.stream.messages()[Symbol.asyncIterator]();
    let appInstanceId = '';
    try {
      appInstanceId = await this.authenticate(incoming.stream, iterator);
      this.trackStream(appInstanceId, incoming.stream);
      if (incoming.channelType === 'events') {
        await this.serveEvents(incoming.stream, iterator, appInstanceId);
      } else if (incoming.channelType === 'terminal') {
        await this.serveTerminal(incoming, iterator);
      } else if (incoming.channelType === 'file-direct') {
        await this.serveFiles(incoming.stream, iterator);
      } else if (incoming.channelType === 'preview-http' || incoming.channelType === 'preview-sse') {
        await this.servePreviewHttp(incoming, iterator);
      } else if (incoming.channelType === 'preview-websocket') {
        await this.servePreviewWebSocket(incoming, iterator);
      } else {
        throw new Error(`Channel is not implemented yet: ${incoming.channelType}`);
      }
    } catch (error) {
      await this.send(incoming.stream, {
        type: 'session.error',
        error: error instanceof Error ? error.message : String(error),
      }).catch(() => undefined);
      await incoming.stream.cancel('Telos Code session failed').catch(() => undefined);
    } finally {
      if (appInstanceId) this.untrackStream(appInstanceId, incoming.stream);
    }
  }

  private async servePreviewHttp(
    incoming: IncomingAppStream,
    iterator: AsyncIterator<Uint8Array>,
  ): Promise<void> {
    const request = await this.nextMessage(iterator);
    if (
      request.type !== 'preview.http.request'
      || typeof request.threadId !== 'string'
      || typeof request.previewSessionId !== 'string'
      || request.previewSessionId !== incoming.channelId
    ) {
      throw new Error('Expected a preview HTTP request matching the channel session.');
    }
    const abort = new AbortController();
    void incoming.stream.closed.then(() => abort.abort()).catch(() => abort.abort());
    const response = await this.threads.previews.request({
      threadId: request.threadId,
      previewSessionId: request.previewSessionId,
      url: typeof request.url === 'string' ? request.url : undefined,
      method: typeof request.method === 'string' ? request.method : undefined,
      headers: isStringHeaders(request.headers) ? request.headers : undefined,
      body: request.body instanceof Uint8Array ? request.body : undefined,
      signal: abort.signal,
    });
    await this.send(incoming.stream, {
      type: 'preview.http.response',
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
      finalUrl: response.finalUrl,
    });
    for await (const data of response.body) {
      await this.send(incoming.stream, { type: 'preview.http.data', data });
    }
    await this.send(incoming.stream, { type: 'preview.http.end' });
    await incoming.stream.halfClose();
  }

  private async servePreviewWebSocket(
    incoming: IncomingAppStream,
    iterator: AsyncIterator<Uint8Array>,
  ): Promise<void> {
    const request = await this.nextMessage(iterator);
    if (
      request.type !== 'preview.websocket.open'
      || typeof request.threadId !== 'string'
      || typeof request.previewSessionId !== 'string'
      || request.previewSessionId !== incoming.channelId
    ) {
      throw new Error('Expected a preview WebSocket request matching the channel session.');
    }
    const socket = this.threads.previews.openWebSocket({
      threadId: request.threadId,
      previewSessionId: request.previewSessionId,
      url: typeof request.url === 'string' ? request.url : undefined,
      protocols: Array.isArray(request.protocols)
        ? request.protocols.filter((item): item is string => typeof item === 'string')
        : undefined,
      headers: isStringHeaders(request.headers) ? request.headers : undefined,
    });
    let writes = Promise.resolve();
    const publish = (message: ProtocolMessage) => {
      writes = writes.then(() => this.send(incoming.stream, message));
      return writes;
    };
    let finish!: () => void;
    const closed = new Promise<void>((resolve) => { finish = resolve; });
    socket.on('open', () => void publish({
      type: 'preview.websocket.opened',
      protocol: socket.protocol,
      extensions: socket.extensions,
    }).catch(() => undefined));
    socket.on('message', (data, binary) => void publish({
      type: 'preview.websocket.data',
      binary,
      data: new Uint8Array(Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer)),
    }).catch(() => undefined));
    socket.on('close', (code, reason) => {
      void publish({ type: 'preview.websocket.closed', code, reason: reason.toString() })
        .finally(finish);
    });
    socket.on('error', (error) => void publish({
      type: 'preview.websocket.error',
      error: error.message,
    }).catch(() => undefined));
    try {
      for (;;) {
        const next = await Promise.race([
          iterator.next().then((value) => ({ kind: 'message' as const, value })),
          closed.then(() => ({ kind: 'closed' as const })),
        ]);
        if (next.kind === 'closed' || next.value.done) return;
        const message = decodeProtocolMessage(next.value.value);
        if (message.type === 'preview.websocket.data' && message.data instanceof Uint8Array) {
          socket.send(message.data, { binary: message.binary === true });
        } else if (message.type === 'preview.websocket.close') {
          socket.close(Number(message.code || 1000), String(message.reason || ''));
        } else if (message.type === 'preview.websocket.ping') {
          socket.ping(message.data instanceof Uint8Array ? message.data : undefined);
        } else {
          throw new Error(`Unsupported preview WebSocket message: ${message.type}`);
        }
      }
    } finally {
      if (socket.readyState === socket.OPEN || socket.readyState === socket.CONNECTING) socket.close();
      await writes.catch(() => undefined);
    }
  }

  private async serveFiles(stream: AppStream, iterator: AsyncIterator<Uint8Array>): Promise<void> {
    const uploads = new Map<string, {
      threadId: string; name: string; mimeType?: string; size: number; sha256: string;
      chunks: Uint8Array[]; received: number;
    }>();
    while (true) {
      const next = await iterator.next();
      if (next.done) return;
      const message = decodeProtocolMessage(next.value);
      if (message.type === 'attachment.download') {
        const requestId = String(message.requestId || '');
        const attachment = this.threads.attachments.get(
          String(message.attachmentId || ''), String(message.threadId || ''));
        const bytes = await readFile(attachment.storagePath);
        await this.send(stream, { type: 'attachment.download.begin', requestId,
          attachment: publicAttachment(attachment) });
        for (let offset = 0, index = 0; offset < bytes.length; offset += 256 * 1024, index += 1) {
          await this.send(stream, { type: 'attachment.download.chunk', requestId, index,
            data: bytes.subarray(offset, Math.min(bytes.length, offset + 256 * 1024)) });
        }
        await this.send(stream, { type: 'attachment.download.complete', requestId });
        continue;
      }
      if (message.type === 'attachment.upload.begin') {
        const requestId = String(message.requestId || '');
        const size = Number(message.size);
        if (!requestId || !Number.isSafeInteger(size) || size < 0 || size > 100 * 1024 * 1024) {
          throw new Error('Attachment upload manifest is invalid or exceeds 100 MiB.');
        }
        this.requireThread(String(message.threadId || ''));
        uploads.set(requestId, { threadId: String(message.threadId), name: String(message.name || ''),
          mimeType: typeof message.mimeType === 'string' ? message.mimeType : undefined,
          size, sha256: String(message.sha256 || ''), chunks: [], received: 0 });
        await this.send(stream, { type: 'attachment.upload.ready', requestId });
        continue;
      }
      if (message.type === 'attachment.upload.chunk') {
        const upload = uploads.get(String(message.requestId || ''));
        if (!upload) throw new Error(`Attachment upload is unknown: ${String(message.requestId || '')}`);
        if (!(message.data instanceof Uint8Array)) throw new Error('Attachment upload chunk is invalid.');
        upload.received += message.data.byteLength;
        if (upload.received > upload.size) throw new Error('Attachment upload exceeds declared size.');
        upload.chunks.push(message.data);
        continue;
      }
      if (message.type === 'attachment.upload.complete') {
        const requestId = String(message.requestId || '');
        const upload = uploads.get(requestId);
        if (!upload) throw new Error(`Attachment upload is unknown: ${requestId}`);
        uploads.delete(requestId);
        const bytes = Buffer.concat(upload.chunks.map((chunk) => Buffer.from(chunk)));
        if (bytes.byteLength !== upload.size) throw new Error('Attachment upload size does not match its manifest.');
        const actualHash = createHash('sha256').update(bytes).digest('hex');
        if (upload.sha256 && actualHash !== upload.sha256) throw new Error('Attachment upload hash verification failed.');
        const attachment = await this.threads.createUploadedAttachment({ threadId: upload.threadId,
          bytes, name: upload.name, mimeType: upload.mimeType });
        await this.send(stream, { type: 'attachment.upload.complete', requestId,
          attachment: publicAttachment(attachment) });
        continue;
      }
      throw new Error(`Unsupported file-direct message: ${message.type}`);
    }
  }

  private async acceptPairing(incoming: IncomingAppStream): Promise<void> {
    this.prunePairings();
    const nonceKey = incoming.channelId.slice('pair:'.length);
    const pending = this.pairing.get(nonceKey);
    if (!pending) throw new Error('Pairing session is invalid or expired.');
    const iterator = incoming.stream.messages()[Symbol.asyncIterator]();
    const message = await this.nextMessage(iterator);
    if (message.type !== 'pairing.request') throw new Error('Expected a pairing authorization request.');
    const request = message.request as AppAuthorizationRequest;
    if (!request?.identity || request.identity.appId !== TELOS_CODE_APP_ID) {
      throw new Error('Pairing request is not a Telos Code identity.');
    }
    if (!sameBytes(request.pairingNonce, pending.nonce)) throw new Error('Pairing nonce mismatch.');
    this.pairing.delete(nonceKey);
    const approval: TelosCodeClientApproval = {
      appInstanceId: request.identity.appInstanceId,
      deviceName: request.identity.deviceName,
      fingerprint: fingerprint(request.identity.signingPublicKey, 'appfp'),
      expiresAt: new Date(request.expiresAt).toISOString(),
    };
    if (!(await this.options.approveClient(approval))) {
      await this.send(incoming.stream, { type: 'pairing.result', approved: false });
      await incoming.stream.halfClose();
      return;
    }
    const authorization = this.node.apps.authorize({
      request,
      pairingNonce: pending.nonce,
      capabilities: [...FULL_CAPABILITIES],
      approvedAt: this.now().getTime(),
    });
    this.saveAuthorization(authorization);
    if (typeof message.dialRoute === 'string') await this.options.onRouteVerified?.(message.dialRoute);
    await this.send(incoming.stream, {
      type: 'pairing.result',
      approved: true,
      harnessId: this.options.harnessId,
      authorization,
    });
    await incoming.stream.halfClose();
  }

  private async authenticate(
    stream: AppStream,
    iterator: AsyncIterator<Uint8Array>,
  ): Promise<string> {
    const hello = await this.nextMessage(iterator);
    if (hello.type !== 'session.hello' || typeof hello.appInstanceId !== 'string') {
      throw new Error('Expected Telos Code session hello.');
    }
    const authorization = this.node.apps.getAuthorization(hello.appInstanceId);
    if (!authorization || authorization.appId !== TELOS_CODE_APP_ID || authorization.revokedAt !== undefined) {
      throw new Error('Telos Code client is not authorized.');
    }
    if (!authorization.capabilities.includes('threads')) {
      throw new Error('Telos Code client lacks the threads capability.');
    }
    const challenge = this.node.apps.createSessionChallenge(authorization.appInstanceId, {
      ttlMs: SESSION_HANDSHAKE_TIMEOUT_MS,
    });
    await this.send(stream, { type: 'session.challenge', challenge });
    const proofMessage = await this.nextMessage(iterator);
    if (proofMessage.type !== 'session.proof') throw new Error('Expected Telos Code session proof.');
    if (!this.node.apps.verifySessionProof(challenge, proofMessage.proof as AppSessionProof, this.now().getTime())) {
      throw new Error('Telos Code session proof is invalid or expired.');
    }
    const touched = this.node.apps.getAuthorization(authorization.appInstanceId)!;
    this.saveAuthorization(touched);
    await this.send(stream, {
      type: 'session.ready',
      harnessId: this.options.harnessId,
      capabilities: touched.capabilities,
    });
    return authorization.appInstanceId;
  }

  private async serveEvents(
    stream: AppStream,
    iterator: AsyncIterator<Uint8Array>,
    appInstanceId: string,
  ): Promise<void> {
    const subscriptions = new Map<string, () => void>();
    const subscribe = (thread: HarnessThread) => {
      if (subscriptions.has(thread.id)) return;
      subscriptions.set(thread.id, this.threads.subscribe(thread.id, (event) => {
        void this.send(stream, { type: 'thread.event', event }).catch(() => undefined);
        const childThreadId = (event.payload as Record<string, unknown>).childThreadId;
        if (typeof childThreadId === 'string') {
          const child = this.store.getThread(childThreadId);
          if (child) {
            subscribe(child);
            void this.send(stream, { type: 'shell.thread-upsert', thread: child }).catch(() => undefined);
          }
        }
      }));
    };
    this.store.listThreads({ includeArchived: true }).forEach(subscribe);
    const unsubscribeShell = this.store.subscribeShell((event) => {
      const thread = event.payload.thread;
      if (thread && typeof thread === 'object' && typeof (thread as { id?: unknown }).id === 'string') {
        subscribe(thread as HarnessThread);
      }
      void this.send(stream, { type: 'shell.event', event }).catch(() => undefined);
    });
    await this.send(stream, {
      type: 'shell.snapshot',
      harnessId: this.options.harnessId,
      sequence: this.store.shellSequence(),
      projects: this.store.listProjects(),
      threads: this.store.listThreads({ includeArchived: true }),
      appClients: this.store.listAppClients().map(publicAppClient),
    });
    try {
      while (true) {
        const next = await iterator.next();
        if (next.done) return;
        const message = decodeProtocolMessage(next.value);
        if (message.type === 'thread.replay.request') {
          const threadId = String(message.threadId || '');
          const afterSequence = Number(message.afterSequence || 0);
          const limit = Math.max(1, Math.min(Number(message.limit || 500), 1_000));
          await this.send(stream, {
            type: 'thread.replay',
            threadId,
            afterSequence,
            events: this.store.replayEvents(threadId, afterSequence, limit),
          });
          continue;
        }
        if (message.type === 'shell.replay.request') {
          const afterSequence = Number(message.afterSequence || 0);
          const limit = Math.max(1, Math.min(Number(message.limit || 500), 1_000));
          await this.send(stream, {
            type: 'shell.replay',
            afterSequence,
            events: this.store.replayShellEvents(afterSequence, limit),
          });
          continue;
        }
        if (message.type !== 'command') throw new Error(`Unsupported events message: ${message.type}`);
        const command = message.command as TelosCodeCommand;
        try {
          const result = await this.executeCommand(command, appInstanceId);
          const createdThread = result && typeof result === 'object'
            ? (result as { thread?: HarnessThread }).thread
            : undefined;
          if (createdThread) subscribe(createdThread);
          await this.send(stream, {
            type: 'command.result',
            commandId: command?.commandId,
            success: true,
            result,
          });
          if (command._tag === 'app-client.revoke') {
            await this.revokeClient(command.appClientId);
            if (command.appClientId === appInstanceId) return;
          }
        } catch (error) {
          await this.send(stream, {
            type: 'command.result',
            commandId: command?.commandId,
            success: false,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    } finally {
      unsubscribeShell();
      for (const unsubscribe of subscriptions.values()) unsubscribe();
    }
  }

  private async serveTerminal(
    incoming: IncomingAppStream,
    iterator: AsyncIterator<Uint8Array>,
  ): Promise<void> {
    const request = await this.nextMessage(iterator);
    if (
      request.type !== 'terminal.subscribe'
      || typeof request.threadId !== 'string'
      || typeof request.terminalId !== 'string'
    ) {
      throw new Error('Expected a terminal subscription request.');
    }
    if (incoming.channelId !== request.terminalId) {
      throw new Error('Terminal stream channel does not match the requested terminal.');
    }
    const terminal = this.threads.terminals.get(request.threadId, request.terminalId);
    let writes = Promise.resolve();
    const publish = (message: ProtocolMessage) => {
      writes = writes.then(() => this.send(incoming.stream, message));
      return writes;
    };
    const unsubscribe = this.threads.terminals.subscribe(request.threadId, (event) => {
      if ('terminalId' in event && event.terminalId !== request.terminalId) return;
      if ('terminal' in event && event.terminal.id !== request.terminalId) return;
      void publish({ type: 'terminal.event', event }).catch(() => undefined);
    });
    try {
      await publish({ type: 'terminal.snapshot', terminal });
      while (true) {
        const next = await iterator.next();
        if (next.done) return;
        const message = decodeProtocolMessage(next.value);
        if (message.type === 'terminal.ping') {
          await publish({ type: 'terminal.pong' });
          continue;
        }
        if (message.type === 'terminal.input' && typeof message.data === 'string') {
          await this.threads.terminals.write({
            threadId: request.threadId,
            terminalId: request.terminalId,
            data: message.data,
          });
          continue;
        }
        if (
          message.type === 'terminal.resize'
          && typeof message.cols === 'number'
          && typeof message.rows === 'number'
        ) {
          await this.threads.terminals.resize({
            threadId: request.threadId,
            terminalId: request.terminalId,
            cols: message.cols,
            rows: message.rows,
          });
          continue;
        }
        throw new Error(`Unsupported terminal stream message: ${message.type}`);
      }
    } finally {
      unsubscribe();
      await writes.catch(() => undefined);
    }
  }

  private async executeCommand(command: TelosCodeCommand, appInstanceId: string): Promise<unknown> {
    if (!command || command.protocolVersion !== 1) throw new Error('Unsupported Telos Code command version.');
    if (command.harnessId !== this.options.harnessId) throw new Error('Command targets another harness.');
    const expiresAt = Date.parse(command.expiresAt);
    if (!Number.isFinite(expiresAt) || expiresAt <= this.now().getTime()) throw new Error('Command has expired.');
    const prior = this.store.getCommandResult<unknown>(command.commandId);
    if (prior !== null) return prior;
    let result: unknown;
    switch (command._tag) {
      case 'catalog.get':
        result = { catalog: await this.catalog.getCatalog() };
        break;
      case 'catalog.models':
        result = { page: await this.catalog.listModels({
          providerId: command.providerId,
          query: command.query,
          cursor: command.cursor,
          limit: command.limit,
        }) };
        break;
      case 'project.create':
        result = { project: this.store.createProject({
          id: command.projectId,
          path: command.path,
          displayName: command.displayName,
        }) };
        break;
      case 'project.update':
        result = { project: this.store.updateProject({
          id: command.projectId,
          ...(command.displayName === undefined ? {} : { displayName: command.displayName }),
          ...(command.snapshotIgnore === undefined
            ? {}
            : { snapshotIgnore: [...command.snapshotIgnore] }),
        }) };
        break;
      case 'project.unregister':
        result = { project: this.store.unregisterProject(command.projectId) };
        break;
      case 'thread.create':
        result = { thread: await this.threads.createThread({
          threadId: command.threadId,
          projectId: command.projectId,
          worktreePath: command.worktreePath,
          agentName: command.agentName,
          providerId: command.providerId,
          modelId: command.modelId,
          reasoning: command.reasoning,
          parentThreadId: command.parentThreadId,
          title: command.title,
        }) };
        break;
      case 'thread.rename':
        result = { thread: this.store.renameThread(command.threadId, command.title, command.expectedVersion) };
        break;
      case 'thread.archive':
        result = { thread: this.store.archiveThread(command.threadId, true, command.expectedVersion) };
        break;
      case 'thread.unarchive':
        result = { thread: this.store.archiveThread(command.threadId, false, command.expectedVersion) };
        break;
      case 'thread.delete':
        this.store.deleteThread(command.threadId);
        result = { deleted: true };
        break;
      case 'turn.enqueue': {
        const queued = this.threads.enqueueTurn({
          threadId: command.threadId,
          turnId: command.turnId,
          text: command.text,
          attachmentIds: [...command.attachmentIds],
        });
        result = { turnId: queued.turnId, state: 'queued' };
        break;
      }
      case 'turn.stop':
        result = { stopping: this.threads.stop(command.threadId) };
        break;
      case 'turn.stop-and-send': {
        const queued = this.threads.stopAndSend({
          threadId: command.threadId,
          text: command.text,
          attachmentIds: [...command.attachmentIds],
        });
        result = { turnId: queued.turnId, state: 'queued' };
        break;
      }
      case 'interaction.answer':
        result = this.threads.answerInteraction({
          interactionId: command.interactionId,
          answers: { ...command.answers },
        });
        break;
      case 'file.list':
        result = await this.threads.listFiles(command.threadId, command.path);
        break;
      case 'file.read':
        result = await this.threads.readFile(command.threadId, command.path);
        break;
      case 'file.write':
        result = await this.threads.writeFile({
          threadId: command.threadId,
          path: command.path,
          contentBase64: command.contentBase64,
          expectedRevision: command.expectedRevision,
        });
        break;
      case 'checkpoint.create': {
        if (!this.options.workspaceSnapshots) throw new Error('Workspace checkpoints are unavailable.');
        const thread = this.requireThread(command.threadId);
        result = { checkpoint: await this.options.workspaceSnapshots.snapshot({
          workspacePath: thread.launchProfile.worktreePath || thread.launchProfile.workspacePath,
          threadId: thread.id,
          name: command.name,
        }) };
        break;
      }
      case 'checkpoint.list':
        result = { checkpoints: this.options.workspaceSnapshots?.listSnapshots({
          threadId: command.threadId,
        }) || [] };
        break;
      case 'checkpoint.rewind': {
        result = await this.threads.rewind({
          threadId: command.threadId,
          checkpointId: command.checkpointId,
          files: command.files ? [...command.files] : undefined,
        });
        break;
      }
      case 'terminal.open':
        result = { terminal: await this.threads.terminals.open({
          threadId: command.threadId,
          terminalId: command.terminalId,
          cwd: command.cwd,
          cols: command.cols,
          rows: command.rows,
        }) };
        break;
      case 'terminal.attach':
        result = { terminal: await this.threads.terminals.attach({
          threadId: command.threadId,
          terminalId: command.terminalId,
          cols: command.cols,
          rows: command.rows,
          restartIfNotRunning: command.restartIfNotRunning,
        }) };
        break;
      case 'terminal.write':
        await this.threads.terminals.write({
          threadId: command.threadId,
          terminalId: command.terminalId,
          data: command.data,
        });
        result = { written: true };
        break;
      case 'terminal.resize':
        result = { terminal: await this.threads.terminals.resize({
          threadId: command.threadId,
          terminalId: command.terminalId,
          cols: command.cols,
          rows: command.rows,
        }) };
        break;
      case 'terminal.clear':
        result = { terminal: this.threads.terminals.clear(command.threadId, command.terminalId) };
        break;
      case 'terminal.restart':
        result = { terminal: await this.threads.terminals.restart({
          threadId: command.threadId,
          terminalId: command.terminalId,
          cols: command.cols,
          rows: command.rows,
        }) };
        break;
      case 'terminal.close':
        await this.threads.terminals.closeTerminal({
          threadId: command.threadId,
          terminalId: command.terminalId,
          deleteHistory: command.deleteHistory,
        });
        result = { closed: true };
        break;
      case 'terminal.list':
        result = { terminals: this.threads.terminals.list(command.threadId) };
        break;
      case 'git.action': {
        if (
          !['status', 'list-refs', 'list-worktrees', 'remotes'].includes(command.action)
          && this.threads.isWorkspaceTurnActive(command.threadId)
        ) {
          throw new Error('Wait for or stop the active workspace turn before running this Git action.');
        }
        result = await this.threads.git.execute({
          threadId: command.threadId,
          action: command.action,
          arguments: { ...command.arguments },
        });
        break;
      }
      case 'project-script.list':
        result = { scripts: this.threads.scripts.list(command.projectId) };
        break;
      case 'project-script.save':
        result = { script: this.threads.scripts.save({
          id: command.scriptId,
          projectId: command.projectId,
          name: command.name,
          command: command.command,
          previewUrl: command.previewUrl,
          autoOpenPreview: command.autoOpenPreview,
        }) };
        break;
      case 'project-script.delete':
        result = { deleted: this.threads.scripts.delete(command.projectId, command.scriptId) };
        break;
      case 'project-script.start':
        result = await this.threads.scripts.start({
          threadId: command.threadId,
          scriptId: command.scriptId,
          terminalId: command.terminalId,
        });
        break;
      case 'project-script.stop':
        await this.threads.scripts.stop(command.threadId, command.terminalId);
        result = { stopped: true };
        break;
      case 'project.ports':
        result = { ports: await this.threads.scripts.discoverPorts(command.threadId) };
        break;
      case 'preview.open':
        result = { preview: this.threads.previews.open({
          threadId: command.threadId,
          previewSessionId: command.previewSessionId,
          url: command.url,
        }) };
        break;
      case 'preview.navigate':
        result = { preview: this.threads.previews.navigate({
          threadId: command.threadId,
          previewSessionId: command.previewSessionId,
          url: command.url,
        }) };
        break;
      case 'preview.close':
        result = { preview: this.threads.previews.close({
          threadId: command.threadId,
          previewSessionId: command.previewSessionId,
        }) };
        break;
      case 'preview.list':
        result = { previews: this.threads.previews.list(command.threadId) };
        break;
      case 'app-client.revoke':
        if (!this.store.getAppClient(command.appClientId)) {
          throw new Error(`Telos Code app client not found: ${command.appClientId}`);
        }
        result = { revoked: true };
        break;
      case 'app-client.list':
        result = { appClients: this.store.listAppClients().map(publicAppClient) };
        break;
      default:
        throw new Error(`Command is not implemented yet: ${(command as { _tag?: string })._tag}`);
    }
    return this.store.saveCommandResult(command.commandId, command._tag, result);
  }

  private requireThread(threadId: string): HarnessThread {
    const thread = this.store.getThread(threadId);
    if (!thread) throw new Error(`Thread not found: ${threadId}`);
    return thread;
  }

  private saveAuthorization(record: AppAuthorizationRecord): void {
    this.store.saveAppClient({
      id: record.appInstanceId,
      appId: record.appId,
      deviceName: record.deviceName,
      signingPublicKey: Buffer.from(record.signingPublicKey).toString('base64'),
      exchangePublicKey: Buffer.from(record.agreementPublicKey).toString('base64'),
      fingerprint: record.fingerprint,
      capabilities: [...record.capabilities],
      createdAt: new Date(record.approvedAt).toISOString(),
      lastSeenAt: record.lastSeenAt ? new Date(record.lastSeenAt).toISOString() : null,
      revokedAt: record.revokedAt ? new Date(record.revokedAt).toISOString() : null,
    });
  }

  private trackStream(appInstanceId: string, stream: AppStream): void {
    const streams = this.activeStreams.get(appInstanceId) || new Set<AppStream>();
    streams.add(stream);
    this.activeStreams.set(appInstanceId, streams);
  }

  private untrackStream(appInstanceId: string, stream: AppStream): void {
    const streams = this.activeStreams.get(appInstanceId);
    streams?.delete(stream);
    if (!streams?.size) this.activeStreams.delete(appInstanceId);
  }

  private prunePairings(): void {
    const now = this.now().getTime();
    for (const [nonce, pairing] of this.pairing) {
      if (pairing.expiresAt <= now) this.pairing.delete(nonce);
    }
  }

  private async nextMessage(iterator: AsyncIterator<Uint8Array>): Promise<ProtocolMessage> {
    const result = await withTimeout(iterator.next(), SESSION_HANDSHAKE_TIMEOUT_MS);
    if (result.done) throw new Error('Telos Code stream closed during handshake.');
    return decodeProtocolMessage(result.value);
  }

  private send(stream: AppStream, message: ProtocolMessage): Promise<void> {
    return stream.send(encodeWire(message));
  }
}

function decodeProtocolMessage(bytes: Uint8Array): ProtocolMessage {
  const message = decodeWire<ProtocolMessage>(bytes);
  if (!message || typeof message.type !== 'string') throw new Error('Invalid Telos Code protocol message.');
  return message;
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  const first = Buffer.from(left);
  const second = Buffer.from(right);
  return first.length === second.length && timingSafeEqual(first, second);
}

function publicAttachment(attachment: import('../thread-store/types.js').StoredAttachment): Record<string, unknown> {
  return { id: attachment.id, threadId: attachment.threadId, name: attachment.name,
    mimeType: attachment.mimeType, size: attachment.size, sha256: attachment.sha256,
    createdAt: attachment.createdAt };
}

function publicAppClient(client: import('../thread-store/types.js').StoredAppClient): Record<string, unknown> {
  return {
    id: client.id,
    appId: client.appId,
    deviceName: client.deviceName,
    fingerprint: client.fingerprint,
    capabilities: client.capabilities,
    createdAt: client.createdAt,
    lastSeenAt: client.lastSeenAt,
    revokedAt: client.revokedAt,
  };
}

function isStringHeaders(value: unknown): value is Record<string, string | string[]> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.values(value).every((item) => typeof item === 'string'
    || (Array.isArray(item) && item.every((part) => typeof part === 'string')));
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Telos Code session handshake timed out.')), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
