import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { TelosLinkCommunicationHub } from '../src/services/telos-link/hub.js';
import type { TelosLinkAudioChunkInput } from '../src/services/telos-link/types.js';

test('telos link audio file fetch retries transient chunk availability errors', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'telos-link-hub-'));
  const handled: TelosLinkAudioChunkInput[] = [];
  let attempts = 0;
  const hub = new TelosLinkCommunicationHub(dataDir, {
    onAudioChunk: async (input) => {
      handled.push(input);
    },
  }) as any;

  hub.node = {
    files: {
      fetch: async () => {
        attempts += 1;
        if (attempts === 1) {
          throw new Error('Unable to fetch file chunk chk_test');
        }
        return { bytes: Buffer.from('audio-bytes') };
      },
    },
  };

  try {
    await hub.fetchAndHandleAudioFile({
      event: {
        kind: 'json',
        originPeerId: 'peer-1',
        originUserId: 'user-1',
        envelopeId: 'env-1',
      },
      manifest: {
        fileName: 'clip.webm',
        contentType: 'audio/webm',
      },
      metadata: {
        chunkId: 'chunk-1',
      },
      chunkId: 'chunk-1',
    });

    assert.equal(attempts, 2);
    assert.equal(handled.length, 1);
    assert.deepEqual(handled[0]?.audioBuffer, Buffer.from('audio-bytes'));
    assert.equal(handled[0]?.mimeType, 'audio/webm');
    assert.equal(handled[0]?.fileName, 'clip.webm');
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('telos link replays a deferred duplicate manifest after exhausted fetch attempts', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'telos-link-hub-'));
  const handled: TelosLinkAudioChunkInput[] = [];
  let attempts = 0;
  const hub = new TelosLinkCommunicationHub(dataDir, {
    onAudioChunk: async (input) => {
      handled.push(input);
    },
  }) as any;

  const fetchInput = {
    event: {
      kind: 'json',
      originPeerId: 'peer-1',
      originUserId: 'user-1',
      envelopeId: 'env-1',
    },
    manifest: {
      fileName: 'clip.webm',
      contentType: 'audio/webm',
    },
    metadata: {
      chunkId: 'chunk-deferred',
    },
    chunkId: 'chunk-deferred',
  };

  hub.node = {
    files: {
      fetch: async () => {
        attempts += 1;
        if (attempts <= 4) {
          throw new Error('Unable to fetch file chunk chk_test');
        }
        return { bytes: Buffer.from('deferred-audio') };
      },
    },
  };
  hub.deferredFileChunkFetches.set('chunk-deferred', fetchInput);

  try {
    hub.queueAudioFileFetch(fetchInput);
    for (let i = 0; i < 20 && handled.length === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    assert.equal(attempts, 5);
    assert.equal(handled.length, 1);
    assert.deepEqual(handled[0]?.audioBuffer, Buffer.from('deferred-audio'));
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
