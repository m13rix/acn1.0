import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { v7 as uuidv7 } from 'uuid';
import { WebSocketServer } from 'ws';

import { normalizePreviewUrl, PreviewService } from './PreviewService.js';
import { ThreadStore } from './thread-store/ThreadStore.js';

async function fixture(run: (service: PreviewService, threadId: string) => Promise<void>): Promise<void> {
  const directory = join(tmpdir(), `telos-preview-${uuidv7()}`);
  await mkdir(directory, { recursive: true });
  const store = await ThreadStore.open({ databasePath: join(directory, 'threads.db') });
  try {
    const project = store.createProject({ path: directory });
    const thread = store.createThread({
      launchProfile: {
        projectId: project.id as never, workspacePath: directory, worktreePath: null, agentName: 'Code',
        resolvedAgentConfig: {}, providerId: 'provider', modelId: 'model', reasoning: 'high',
      },
    });
    await run(new PreviewService(store), thread.id);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
}

test('streams harness-loopback HTTP and SSE response bodies', async () => {
  const server = createServer((request, response) => {
    if (request.url === '/events') {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write('data: first\n\n');
      setTimeout(() => response.end('data: second\n\n'), 10);
      return;
    }
    response.writeHead(200, { 'content-type': 'text/plain', 'x-preview': 'yes' });
    response.end('hello preview');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('HTTP fixture did not bind.');
  try {
    await fixture(async (service, threadId) => {
      const session = service.open({ threadId, url: `http://127.0.0.1:${address.port}/` });
      const response = await service.request({ threadId, previewSessionId: session.id });
      assert.equal(response.status, 200);
      assert.equal(Buffer.concat(await collect(response.body)).toString(), 'hello preview');

      const events = await service.request({
        threadId,
        previewSessionId: session.id,
        url: `http://127.0.0.1:${address.port}/events`,
      });
      assert.match(Buffer.concat(await collect(events.body)).toString(), /data: first[\s\S]*data: second/u);
    });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test('bridges a loopback WebSocket and rejects non-loopback targets', async () => {
  const server = createServer();
  const sockets = new WebSocketServer({ server });
  sockets.on('connection', (socket) => socket.on('message', (data) => socket.send(data)));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('WebSocket fixture did not bind.');
  try {
    await fixture(async (service, threadId) => {
      const session = service.open({ threadId, url: `http://127.0.0.1:${address.port}/` });
      const socket = service.openWebSocket({ threadId, previewSessionId: session.id });
      await new Promise<void>((resolve, reject) => {
        socket.once('open', () => socket.send('echo'));
        socket.once('message', (data) => {
          assert.equal(data.toString(), 'echo');
          socket.close();
          resolve();
        });
        socket.once('error', reject);
      });
    });
    assert.throws(() => normalizePreviewUrl('http://example.com'), /only loopback/u);
  } finally {
    sockets.close();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

async function collect(source: AsyncIterable<Uint8Array>): Promise<Buffer[]> {
  const chunks: Buffer[] = [];
  for await (const chunk of source) chunks.push(Buffer.from(chunk));
  return chunks;
}
