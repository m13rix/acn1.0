import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { RealtimeAdvisorInterfaceRuntime } from '../src/interfaces/realtime-advisor/index.js';
import { RealtimeAdvisorStore } from '../src/interfaces/realtime-advisor/store.js';
import type { InterfaceRouteHandler, InterfaceRuntimeContext } from '../src/interfaces/base.js';

test('realtime advisor runtime exposes health and test client', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'telos-realtime-advisor-'));
  const routes: InterfaceRouteHandler[] = [];
  const runtime = new RealtimeAdvisorInterfaceRuntime({
    dataDir,
    host: '127.0.0.1',
    port: 0,
    pyannoteApiKey: undefined,
    mockPyannote: false,
    autoOpenClient: false,
    localhostRunEnabled: false,
  });
  const context: InterfaceRuntimeContext = {
    registerRoute: (handler) => routes.push(handler),
    unregisterRoute: (routeId) => {
      const index = routes.findIndex((route) => route.routeId === routeId);
      if (index >= 0) routes.splice(index, 1);
    },
    getRegisteredRoutes: () => routes,
    getLoadedAgents: async () => [],
  };

  try {
    await runtime.start(context);
    assert.equal(routes.some((route) => route.routeId === 'realtime-advisor:default'), true);

    const healthResponse = await fetch(`${runtime.getBaseUrl()}/health`);
    assert.equal(healthResponse.ok, true);
    const health = await healthResponse.json() as { success?: boolean; pyannoteEnabled?: boolean };
    assert.equal(health.success, true);
    assert.equal(health.pyannoteEnabled, false);

    const clientResponse = await fetch(`${runtime.getBaseUrl()}/client`);
    assert.equal(clientResponse.ok, true);
    const html = await clientResponse.text();
    assert.match(html, /Realtime Advisor Console/);
  } finally {
    await runtime.stop();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('realtime advisor temp audio paths keep the wav extension at the end', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'telos-realtime-advisor-store-'));
  const store = new RealtimeAdvisorStore(dataDir);

  try {
    await store.initialize();
    const tempPath = store.getTempPath('unknown-unknown_abc.wav');
    assert.equal(path.extname(tempPath), '.wav');
    assert.match(path.basename(tempPath), /^unknown-unknown_abc-tmp_[a-f0-9]+\.wav$/);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('realtime advisor store can relabel unknown transcript entries', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'telos-realtime-advisor-store-'));
  const store = new RealtimeAdvisorStore(dataDir);

  try {
    await store.initialize();
    const audioPath = path.join(dataDir, 'input.wav');
    const { chunk, conversation } = await store.registerChunk({
      audioPath,
      mimeType: 'audio/wav',
      conversationGapMs: 300_000,
      metadata: {
        quickTranscript: 'hello',
        timestamp: '2026-06-03T12:00:00.000Z',
      },
    });
    await store.replaceChunkTranscript({
      conversationId: conversation.id,
      chunkId: chunk.id,
      entries: [{
        source: 'pyannote',
        startTime: '2026-06-03T12:00:00.000Z',
        endTime: '2026-06-03T12:00:02.000Z',
        speakerLabel: '[...]',
        diarizationSpeaker: 'SPEAKER_00',
        text: 'hello',
        final: true,
      }],
    });

    const updated = await store.updateTranscriptSpeakerLabels({
      conversationId: conversation.id,
      chunkIds: [chunk.id],
      diarizationSpeaker: 'SPEAKER_00',
      speakerLabel: 'Subject 13',
    });

    assert.equal(updated.length, 1);
    assert.equal(updated[0]?.speakerLabel, 'Subject 13');
    assert.equal(updated[0]?.revision, 2);
    assert.equal(store.getConversation(conversation.id)?.entries.at(-1)?.speakerLabel, 'Subject 13');
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('unknown buffers retain every snippet embedding for coherence checks', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'telos-realtime-advisor-store-'));
  const store = new RealtimeAdvisorStore(dataDir);

  try {
    await store.initialize();
    const first = await store.upsertUnknownBuffer({
      conversationId: 'conv_1',
      chunkId: 'chunk_1',
      diarizationSpeaker: 'SPEAKER_00',
      audioPath: path.join(dataDir, 'one.wav'),
      embeddingPath: path.join(dataDir, 'one.json'),
      speechSeconds: 4,
      chunkAt: '2026-06-03T12:00:00.000Z',
      unknownGapMs: 300_000,
    });
    const second = await store.upsertUnknownBuffer({
      conversationId: 'conv_1',
      chunkId: 'chunk_2',
      diarizationSpeaker: 'SPEAKER_00',
      audioPath: path.join(dataDir, 'two.wav'),
      embeddingPath: path.join(dataDir, 'two.json'),
      speechSeconds: 5,
      chunkAt: '2026-06-03T12:00:04.000Z',
      unknownGapMs: 300_000,
      bufferId: first.id,
    });

    assert.equal(second.embeddingPath, path.join(dataDir, 'two.json'));
    assert.deepEqual(second.embeddingPaths, [
      path.join(dataDir, 'one.json'),
      path.join(dataDir, 'two.json'),
    ]);
    assert.equal(second.speechSeconds, 9);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('realtime advisor store serializes concurrent state writes', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'telos-realtime-advisor-store-'));
  const store = new RealtimeAdvisorStore(dataDir);

  try {
    await store.initialize();
    await Promise.all(Array.from({ length: 25 }, (_item, index) => store.registerChunk({
      audioPath: path.join(dataDir, `chunk-${index}.wav`),
      mimeType: 'audio/wav',
      conversationGapMs: 300_000,
      metadata: {
        chunkId: `chunk_${index}`,
        quickTranscript: `hello ${index}`,
        timestamp: new Date(Date.UTC(2026, 5, 3, 12, 0, index)).toISOString(),
      },
    })));

    const saved = JSON.parse(await readFile(path.join(dataDir, 'state.json'), 'utf8')) as {
      chunks?: Record<string, unknown>;
    };
    assert.equal(Object.keys(saved.chunks ?? {}).length, 25);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
