import { timingSafeEqual } from 'node:crypto';

import type { TelosCodeCommand } from '@telos/code-contracts/telos';
import {
  TELOS_CODE_APP_ID,
  TELOS_CODE_STREAM_PROTOCOL,
} from '@telos/code-contracts/telos';
import {
  decodeWire,
  encodeDirectPairingCode,
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
      fullAddress: input.fullAddress,
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
      if (incoming.channelType !== 'events') {
        throw new Error(`Channel is not implemented yet: ${incoming.channelType}`);
      }
      await this.serveEvents(incoming.stream, iterator, appInstanceId);
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
      }));
    };
    this.store.listThreads({ includeArchived: true }).forEach(subscribe);
    await this.send(stream, {
      type: 'shell.snapshot',
      harnessId: this.options.harnessId,
      projects: this.store.listProjects(),
      threads: this.store.listThreads({ includeArchived: true }),
      appClients: this.store.listAppClients(),
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
            await this.revokeClient(appInstanceId);
            return;
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
      for (const unsubscribe of subscriptions.values()) unsubscribe();
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
      case 'app-client.revoke':
        if (command.appClientId !== appInstanceId) throw new Error('A client may revoke only itself.');
        result = { revoked: true };
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
