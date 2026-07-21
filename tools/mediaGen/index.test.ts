import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { generateImage } from './index.ts';

const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const ORIGINAL_SANDBOX_DIR = process.env.SANDBOX_DIR;

test('generateImage retries OpenRouter image request with image-only modalities when mixed output routing is unavailable', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'media-gen-test-'));
  const requestBodies: Array<Record<string, unknown>> = [];

  process.env.OPENROUTER_API_KEY = 'test-key';
  process.env.SANDBOX_DIR = tempDir;
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    requestBodies.push(JSON.parse(String(init?.body)));
    if (requestBodies.length === 1) {
      return new Response(JSON.stringify({
        error: {
          message: 'No endpoints found that support the requested output modalities: image, text',
          code: 404,
        },
      }), {
        status: 404,
        statusText: 'Not Found',
        headers: { 'content-type': 'application/json' },
      });
    }

    return new Response(JSON.stringify({
      choices: [{
        message: {
          images: [{
            image_url: {
              url: 'data:image/png;base64,aGVsbG8=',
            },
          }],
        },
      }],
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;

  try {
    const result = await generateImage({
      prompt: 'stage backdrop',
      outputPath: 'backdrop.png',
      model: 'pro',
      aspectRatio: '16:9',
      imageSize: '4K',
    });

    assert.deepEqual(requestBodies.map(body => body.modalities), [
      ['image', 'text'],
      ['image'],
    ]);
    assert.equal(requestBodies[0].model, 'google/gemini-3-pro-image');
    assert.deepEqual(requestBodies[1].image_config, {
      aspect_ratio: '16:9',
      image_size: '4K',
    });
    assert.equal(result.path, path.join(tempDir, 'backdrop.png'));
    assert.equal(await readFile(result.path, 'utf8'), 'hello');

    const metadata = JSON.parse(await readFile(result.metadataPath, 'utf8'));
    assert.deepEqual(metadata.outputModalities, ['image']);
  } finally {
    globalThis.fetch = ORIGINAL_FETCH;
    if (ORIGINAL_OPENROUTER_API_KEY === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = ORIGINAL_OPENROUTER_API_KEY;
    if (ORIGINAL_SANDBOX_DIR === undefined) delete process.env.SANDBOX_DIR;
    else process.env.SANDBOX_DIR = ORIGINAL_SANDBOX_DIR;
    await rm(tempDir, { recursive: true, force: true });
  }
});
