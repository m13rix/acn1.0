import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createServer } from 'node:http';
import { v7 as uuidv7 } from 'uuid';

import {
  createAppAuthorizationRequest,
  createAppSessionProof,
  createLocalAppIdentity,
  decodeWire,
  encodeWire,
} from '@telos/link-core';
import { TelosLinkNode, type AppStream, type IncomingAppStream } from '@telos/link-node';

import { ThreadService, type ThreadExecutionAdapter } from '../ThreadService.js';
import { ThreadStore } from '../thread-store/ThreadStore.js';
import { TelosCodeLinkEndpoint } from './TelosCodeLinkEndpoint.js';

class FakeAppStream implements AppStream {
  readonly appId = 'telos-code';
  readonly closed: Promise<void>;
  readonly sent: Array<Record<string, unknown>> = [];
  private readonly queue: Uint8Array[] = [];
  private readonly waiters: Array<(value: IteratorResult<Uint8Array>) => void> = [];
  private ended = false;
  private resolveClosed!: () => void;

  constructor(
    readonly channelId: string,
    private readonly onSend?: (message: Record<string, unknown>, stream: FakeAppStream) => void,
    readonly channelType: AppStream['channelType'] = 'events',
  ) {
    this.closed = new Promise<void>((resolve) => { this.resolveClosed = resolve; });
  }

  push(message: Record<string, unknown>): void {
    const bytes = encodeWire(message);
    const waiter = this.waiters.shift();
    if (waiter) waiter({ done: false, value: bytes });
    else this.queue.push(bytes);
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    this.resolveClosed();
    for (const waiter of this.waiters.splice(0)) waiter({ done: true, value: undefined });
  }

  async send(bytes: Uint8Array): Promise<void> {
    const message = decodeWire<Record<string, unknown>>(bytes);
    this.sent.push(message);
    this.onSend?.(message, this);
  }

  async *messages(): AsyncIterable<Uint8Array> {
    while (true) {
      if (this.queue.length) yield this.queue.shift()!;
      else if (this.ended) return;
      else {
        const next = await new Promise<IteratorResult<Uint8Array>>((resolve) => this.waiters.push(resolve));
        if (next.done) return;
        yield next.value;
      }
    }
  }

  async halfClose(): Promise<void> {
    this.end();
  }

  async cancel(): Promise<void> {
    this.end();
  }
}

function incoming(stream: FakeAppStream): IncomingAppStream {
  return {
    appId: 'telos-code',
    protocol: '/telos/code/1',
    channelType: stream.channelType,
    channelId: stream.channelId,
    stream,
  };
}

const unusedAdapter: ThreadExecutionAdapter = {
  async execute() {
    throw new Error('Unexpected execution');
  },
};

test('pairs an app identity only after explicit approval and authenticates reconnects', async () => {
  const directory = join(tmpdir(), `telos-code-link-${uuidv7()}`);
  await mkdir(directory, { recursive: true });
  const node = await TelosLinkNode.create({
    storagePath: join(directory, 'link'),
    device: { name: 'Harness', type: 'server' },
  });
  const store = await ThreadStore.open({ databasePath: join(directory, 'threads.db') });
  const threads = new ThreadService(store, { executionAdapter: unusedAdapter,
    attachmentStoragePath: join(directory, 'attachments') });
  const approvals: string[] = [];
  const endpoint = new TelosCodeLinkEndpoint(node, threads, store, {
    harnessId: '01900000-0000-7000-8000-000000000001',
    approveClient: (request) => {
      approvals.push(`${request.deviceName}:${request.fingerprint}`);
      return true;
    },
    catalog: {
      getCatalog: async () => ({ agents: [], providers: [] }),
      listModels: async () => ({ items: [] }),
    } as never,
  });
  try {
    const pairing = endpoint.beginPairing({ host: '127.0.0.1', port: 4424 });
    const localIdentity = createLocalAppIdentity({ appId: 'telos-code', deviceName: 'Laptop' });
    const authorizationRequest = createAppAuthorizationRequest({
      localIdentity,
      pairingNonce: Buffer.from(pairing.channelId.slice('pair:'.length), 'base64url'),
      expiresAt: Date.now() + 60_000,
    });
    const pairingStream = new FakeAppStream(pairing.channelId);
    pairingStream.push({ type: 'pairing.request', request: authorizationRequest });
    await endpoint.acceptIncoming(incoming(pairingStream));

    assert.equal(pairingStream.sent.at(-1)?.approved, true);
    assert.equal(approvals.length, 1);
    assert.equal(node.apps.listAuthorized('telos-code').length, 1);
    assert.equal(store.listAppClients()[0]?.deviceName, 'Laptop');

    const sessionStream = new FakeAppStream('events:primary', (message, stream) => {
      if (message.type === 'session.challenge') {
        stream.push({
          type: 'session.proof',
          proof: createAppSessionProof(
            localIdentity,
            message.challenge as Parameters<typeof createAppSessionProof>[1],
          ),
        });
      }
      if (message.type === 'shell.snapshot') {
        stream.push({
          type: 'command',
          command: {
            _tag: 'catalog.get',
            protocolVersion: 1,
            commandId: '01900000-0000-7000-8000-000000000101',
            harnessId: '01900000-0000-7000-8000-000000000001',
            issuedAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
          },
        });
      }
      if (message.type === 'command.result' && message.commandId === '01900000-0000-7000-8000-000000000101') {
        stream.push({
          type: 'command',
          command: {
            _tag: 'project.create',
            protocolVersion: 1,
            commandId: '01900000-0000-7000-8000-000000000102',
            harnessId: '01900000-0000-7000-8000-000000000001',
            issuedAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
            projectId: '01900000-0000-7000-8000-000000000201',
            path: directory,
            displayName: 'Fixture',
          },
        });
      }
      if (message.type === 'command.result' && message.commandId === '01900000-0000-7000-8000-000000000102') {
        stream.push({
          type: 'command',
          command: {
            _tag: 'thread.create',
            protocolVersion: 1,
            commandId: '01900000-0000-7000-8000-000000000103',
            harnessId: '01900000-0000-7000-8000-000000000001',
            issuedAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
            threadId: '01900000-0000-7000-8000-000000000301',
            parentThreadId: null,
            projectId: '01900000-0000-7000-8000-000000000201',
            worktreePath: null,
            agentName: 'Telos-Code',
            providerId: 'openai-codex',
            modelId: 'gpt-5.5',
            reasoning: 'high',
          },
        });
      }
      if (message.type === 'command.result' && message.commandId === '01900000-0000-7000-8000-000000000103') {
        store.createInteraction({
          id: '01900000-0000-7000-8000-000000000401',
          threadId: '01900000-0000-7000-8000-000000000301',
          request: { questions: [{ id: 'response', question: 'Continue?' }] },
        });
        stream.push({
          type: 'command',
          command: {
            _tag: 'interaction.answer',
            protocolVersion: 1,
            commandId: '01900000-0000-7000-8000-000000000104',
            harnessId: '01900000-0000-7000-8000-000000000001',
            issuedAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
            threadId: '01900000-0000-7000-8000-000000000301',
            interactionId: '01900000-0000-7000-8000-000000000401',
            answers: { response: 'yes' },
          },
        });
      }
      if (message.type === 'command.result' && message.commandId === '01900000-0000-7000-8000-000000000104') stream.end();
    });
    sessionStream.push({
      type: 'session.hello',
      appInstanceId: localIdentity.identity.appInstanceId,
    });
    await endpoint.acceptIncoming(incoming(sessionStream));

    assert.deepEqual(
      sessionStream.sent.map((message) => message.type),
      [
        'session.challenge',
        'session.ready',
        'shell.snapshot',
        'command.result',
        'shell.event',
        'command.result',
        'shell.event',
        'command.result',
        'thread.event',
        'command.result',
      ],
    );
    assert.equal(
      (sessionStream.sent.find((message) => message.type === 'session.ready')?.capabilities as string[])
        .includes('threads'),
      true,
    );
    assert.equal(store.listProjects()[0]?.displayName, 'Fixture');
    assert.equal(store.listThreads()[0]?.launchProfile.modelId, 'gpt-5.5');
    assert.deepEqual(store.getInteraction('01900000-0000-7000-8000-000000000401')?.answer, {
      response: 'yes',
    });

    const uploadBytes = Buffer.from('immutable attachment bytes');
    let uploadedAttachmentId = '';
    const fileStream = new FakeAppStream('files:primary', (message, stream) => {
      if (message.type === 'session.challenge') {
        stream.push({ type: 'session.proof', proof: createAppSessionProof(localIdentity,
          message.challenge as Parameters<typeof createAppSessionProof>[1]) });
      }
      if (message.type === 'session.ready') stream.push({ type: 'attachment.upload.begin',
        requestId: 'upload-1', threadId: '01900000-0000-7000-8000-000000000301',
        name: 'proof.txt', mimeType: 'text/plain', size: uploadBytes.length,
        sha256: 'fa320e87c0ec9d342a0a77a8f3ddc8540f4d785fd0729f6b4656681912bc2699' });
      if (message.type === 'attachment.upload.ready') {
        stream.push({ type: 'attachment.upload.chunk', requestId: 'upload-1', index: 0, data: uploadBytes });
        stream.push({ type: 'attachment.upload.complete', requestId: 'upload-1' });
      }
      if (message.type === 'attachment.upload.complete' && message.attachment) {
        uploadedAttachmentId = String((message.attachment as Record<string, unknown>).id);
        assert.equal('storagePath' in (message.attachment as Record<string, unknown>), false);
        stream.push({ type: 'attachment.download', requestId: 'download-1',
          threadId: '01900000-0000-7000-8000-000000000301', attachmentId: uploadedAttachmentId });
      }
      if (message.type === 'attachment.download.complete') stream.end();
    }, 'file-direct');
    fileStream.push({ type: 'session.hello', appInstanceId: localIdentity.identity.appInstanceId });
    await endpoint.acceptIncoming(incoming(fileStream));
    assert.ok(uploadedAttachmentId);
    assert.equal(store.getAttachment(uploadedAttachmentId)?.name, 'proof.txt');
    assert.equal(Buffer.concat(fileStream.sent
      .filter((message) => message.type === 'attachment.download.chunk')
      .map((message) => Buffer.from(message.data as Uint8Array))).toString(), uploadBytes.toString());

    const previewServer = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.write('streamed ');
      setTimeout(() => response.end('preview'), 5);
    });
    await new Promise<void>((resolve) => previewServer.listen(0, '127.0.0.1', resolve));
    const previewAddress = previewServer.address();
    if (!previewAddress || typeof previewAddress === 'string') throw new Error('Preview fixture did not bind.');
    try {
      const previewId = '01900000-0000-7000-8000-000000000501';
      threads.previews.open({
        threadId: '01900000-0000-7000-8000-000000000301',
        previewSessionId: previewId,
        url: `http://127.0.0.1:${previewAddress.port}/`,
      });
      const previewStream = new FakeAppStream(previewId, (message, stream) => {
        if (message.type === 'session.challenge') {
          stream.push({ type: 'session.proof', proof: createAppSessionProof(localIdentity,
            message.challenge as Parameters<typeof createAppSessionProof>[1]) });
        }
        if (message.type === 'session.ready') stream.push({
          type: 'preview.http.request',
          threadId: '01900000-0000-7000-8000-000000000301',
          previewSessionId: previewId,
          method: 'GET',
        });
      }, 'preview-http');
      previewStream.push({ type: 'session.hello', appInstanceId: localIdentity.identity.appInstanceId });
      await endpoint.acceptIncoming(incoming(previewStream));
      assert.equal(previewStream.sent.find((message) => message.type === 'preview.http.response')?.status, 200);
      assert.equal(Buffer.concat(previewStream.sent
        .filter((message) => message.type === 'preview.http.data')
        .map((message) => Buffer.from(message.data as Uint8Array))).toString(), 'streamed preview');
      assert.equal(previewStream.sent.at(-1)?.type, 'preview.http.end');
    } finally {
      await new Promise<void>((resolve, reject) => previewServer.close((error) => error ? reject(error) : resolve()));
    }

    await endpoint.revokeClient(localIdentity.identity.appInstanceId);
    assert.ok(node.apps.getAuthorization(localIdentity.identity.appInstanceId)?.revokedAt);
    assert.ok(store.getAppClient(localIdentity.identity.appInstanceId)?.revokedAt);

    const rejected = new FakeAppStream('events:rejected');
    rejected.push({ type: 'session.hello', appInstanceId: localIdentity.identity.appInstanceId });
    await endpoint.acceptIncoming(incoming(rejected));
    assert.match(String(rejected.sent.at(-1)?.error), /not authorized/u);
  } finally {
    await endpoint.close();
    store.close();
    node.storage.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('rejects expired pairing sessions before asking for approval', async () => {
  const directory = join(tmpdir(), `telos-code-expired-pair-${uuidv7()}`);
  await mkdir(directory, { recursive: true });
  let clock = Date.now();
  let approvals = 0;
  const node = await TelosLinkNode.create({ storagePath: join(directory, 'link') });
  const store = await ThreadStore.open({ databasePath: join(directory, 'threads.db') });
  const endpoint = new TelosCodeLinkEndpoint(
    node,
    new ThreadService(store, { executionAdapter: unusedAdapter }),
    store,
    {
      harnessId: '01900000-0000-7000-8000-000000000001',
      now: () => new Date(clock),
      approveClient: () => {
        approvals += 1;
        return true;
      },
    },
  );
  try {
    const pairing = endpoint.beginPairing({ host: '10.0.0.2', port: 4424 });
    clock += 11 * 60 * 1000;
    const stream = new FakeAppStream(pairing.channelId);
    stream.push({ type: 'pairing.request', request: {} });
    await endpoint.acceptIncoming(incoming(stream));
    assert.equal(approvals, 0);
    assert.match(String(stream.sent.at(-1)?.error), /invalid or expired/u);
  } finally {
    store.close();
    node.storage.close();
    await rm(directory, { recursive: true, force: true });
  }
});
