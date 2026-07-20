import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { RealtimeAdvisorInterfaceRuntime } from '../src/interfaces/realtime-advisor/index.js';
import { RealtimeAdvisorStore } from '../src/interfaces/realtime-advisor/store.js';
import type { InterfaceRouteHandler, InterfaceRuntimeContext } from '../src/interfaces/base.js';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForState(baseUrl: string, predicate: (state: { currentConversation?: { entries?: Array<{ text?: string }> } }) => boolean): Promise<{ currentConversation?: { entries?: Array<{ text?: string }> } }> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const response = await fetch(`${baseUrl}/v1/state`);
    assert.equal(response.ok, true);
    const body = await response.json() as { currentConversation?: { entries?: Array<{ text?: string }> } };
    if (predicate(body)) {
      return body;
    }
    await sleep(25);
  }
  return {};
}

test('realtime advisor runtime exposes health and test client', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'telos-realtime-advisor-'));
  const routes: InterfaceRouteHandler[] = [];
  const runtime = new RealtimeAdvisorInterfaceRuntime({
    dataDir,
    host: '127.0.0.1',
    port: 0,
    assemblyAiApiKey: undefined,
    mockAssemblyAi: false,
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
    const health = await healthResponse.json() as { success?: boolean; assemblyAiEnabled?: boolean };
    assert.equal(health.success, true);
    assert.equal(health.assemblyAiEnabled, false);

    const triggerResponse = await fetch(`${runtime.getBaseUrl()}/v1/context/trigger`);
    assert.equal(triggerResponse.ok, true);
    const trigger = await triggerResponse.json() as { formatted?: string; trigger?: { type?: string; value?: number } };
    assert.match(trigger.formatted || '', /Automatic trigger: debounce = 10/);
    assert.equal(trigger.trigger?.type, 'debounce');
    assert.equal(trigger.trigger?.value, 10);

    const setInstructionsResponse = await fetch(`${runtime.getBaseUrl()}/v1/context/instructions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'Subject 13 is studying. Stay quiet unless asked.' }),
    });
    assert.equal(setInstructionsResponse.ok, true);
    const setInstructions = await setInstructionsResponse.json() as { text?: string; formatted?: string };
    assert.equal(setInstructions.text, 'Subject 13 is studying. Stay quiet unless asked.');
    assert.match(setInstructions.formatted || '', /Subject 13 is studying/);

    const getInstructionsResponse = await fetch(`${runtime.getBaseUrl()}/v1/context/instructions`);
    assert.equal(getInstructionsResponse.ok, true);
    const getInstructions = await getInstructionsResponse.json() as { text?: string };
    assert.equal(getInstructions.text, 'Subject 13 is studying. Stay quiet unless asked.');

    const linkResponse = await fetch(`${runtime.getBaseUrl()}/v1/link/health`);
    assert.equal(linkResponse.ok, true);
    const link = await linkResponse.json() as { success?: boolean; peerId?: string; pairingPayload?: string };
    assert.equal(link.success, true);
    assert.equal(typeof link.peerId, 'string');
    assert.match(link.pairingPayload || '', /^telos-pair:/);

    const clientResponse = await fetch(`${runtime.getBaseUrl()}/client`);
    assert.equal(clientResponse.ok, true);
    const html = await clientResponse.text();
    assert.match(html, /Realtime Advisor Console/);
  } finally {
    await runtime.stop();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('realtime advisor chunk ingest returns immediately and publishes communication event', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'telos-realtime-advisor-'));
  const routes: InterfaceRouteHandler[] = [];
  const runtime = new RealtimeAdvisorInterfaceRuntime({
    dataDir,
    host: '127.0.0.1',
    port: 0,
    assemblyAiApiKey: undefined,
    mockAssemblyAi: false,
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
    const baseUrl = runtime.getBaseUrl();

    const form = new FormData();
    form.set('quickTranscript', 'hello from phone');
    form.set('timestamp', new Date().toISOString());
    form.set('audio', new Blob([Buffer.from('fake-audio')], { type: 'audio/webm' }), 'clip.webm');
    const chunkResponse = await fetch(`${baseUrl}/v1/chunks`, {
      method: 'POST',
      body: form,
    });
    assert.equal(chunkResponse.ok, true);
    assert.deepEqual(await chunkResponse.json(), { success: true });

    const state = await waitForState(baseUrl, (item) =>
      item.currentConversation?.entries?.some((entry) => entry.text === 'hello from phone') === true
    );
    assert.equal(state.currentConversation?.entries?.at(-1)?.text, 'hello from phone');

    const russianText = 'это тестовое сообщение';
    const mojibakeText = Buffer.from(russianText, 'utf8').toString('latin1');
    const mojibakeForm = new FormData();
    mojibakeForm.set('quickTranscript', mojibakeText);
    mojibakeForm.set('timestamp', new Date().toISOString());
    mojibakeForm.set('audio', new Blob([Buffer.from('fake-audio')], { type: 'audio/webm' }), 'clip2.webm');
    const mojibakeResponse = await fetch(`${baseUrl}/v1/chunks`, {
      method: 'POST',
      body: mojibakeForm,
    });
    assert.equal(mojibakeResponse.ok, true);

    const repairedState = await waitForState(baseUrl, (item) =>
      item.currentConversation?.entries?.some((entry) => entry.text === russianText) === true
    );
    assert.equal(repairedState.currentConversation?.entries?.at(-1)?.text, russianText);
  } finally {
    await runtime.stop();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('realtime advisor store persists automatic trigger and logs', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'telos-realtime-advisor-store-'));
  const store = new RealtimeAdvisorStore(dataDir);

  try {
    await store.initialize();
    assert.equal(store.getAutomaticTrigger().type, 'debounce');
    assert.equal(store.getAutomaticTrigger().value, 10);

    await store.setAutomaticTrigger('every', 3);
    await store.recordVoiceLineForAutomaticTrigger();
    await store.recordVoiceLineForAutomaticTrigger();
    const active = store.getAutomaticTrigger();
    assert.equal(active.type, 'every');
    assert.equal(active.value, 3);
    assert.equal(active.lineCountSinceLastTrigger, 2);

    const log = await store.addLog('Subject 13 asked for advice; Telos stayed quiet because the conversation was going well.');
    assert.match(log.id, /^log_/);
    assert.equal(store.listLogs(1)[0]?.text, log.text);
    await store.setAdvisorInstructions('Subject 13 is on a walk. Keep advice short.');
    assert.equal(store.getAdvisorInstructions().text, 'Subject 13 is on a walk. Keep advice short.');

    const restored = new RealtimeAdvisorStore(dataDir);
    await restored.initialize();
    assert.equal(restored.getAutomaticTrigger().type, 'every');
    assert.equal(restored.getAutomaticTrigger().lineCountSinceLastTrigger, 2);
    assert.equal(restored.listLogs(1)[0]?.text, log.text);
    assert.equal(restored.getAdvisorInstructions().text, 'Subject 13 is on a walk. Keep advice short.');
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('smartphone data read recovers from late response with mismatched request id', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'telos-realtime-advisor-'));
  const runtime = new RealtimeAdvisorInterfaceRuntime({
    dataDir,
    host: '127.0.0.1',
    port: 0,
    assemblyAiApiKey: undefined,
    mockAssemblyAi: false,
    autoOpenClient: false,
    localhostRunEnabled: false,
  }) as any;

  try {
    const pending = runtime.waitForSmartphoneDataRead('read-current', 5_000);
    runtime.resolveSmartphoneDataRead({
      requestId: 'read-previous',
      combinedText: 'fresh phone data',
    });

    const result = await pending;
    assert.equal(result.combinedText, 'fresh phone data');
    assert.equal(result.recoveredFromMismatchedRequestId, true);
    assert.equal(result.recoveredRequestId, 'read-previous');
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('smartphone data read does not recover cached error payloads as success', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'telos-realtime-advisor-'));
  const runtime = new RealtimeAdvisorInterfaceRuntime({
    dataDir,
    host: '127.0.0.1',
    port: 0,
    assemblyAiApiKey: undefined,
    mockAssemblyAi: false,
    autoOpenClient: false,
    localhostRunEnabled: false,
  }) as any;

  try {
    runtime.latestSmartphoneDataResponse = {
      payload: { requestId: 'read-error', error: 'phone failed' },
      receivedAt: Date.now(),
      requestId: 'read-error',
    };

    assert.equal(runtime.getRecentSmartphoneDataResponse(Date.now() - 100), null);
  } finally {
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
        source: 'assemblyai',
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
