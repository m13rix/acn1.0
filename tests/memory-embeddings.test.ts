import assert from 'node:assert/strict';
import test from 'node:test';
import { __internals, cosineSimilarity, embedBatch, vectorSubtract } from '../src/memory_system/embeddings.ts';
import { DEFAULT_MEMORY_CONFIG } from '../src/memory_system/types.ts';

test('embedding sanitization replaces non-finite values with zeros', () => {
  const sanitized = __internals.sanitizeEmbeddingVector([1, NaN, Infinity, -Infinity, '4']);
  assert.deepEqual(sanitized, [1, 0, 0, 0, 4]);
});

test('vector math stays finite when legacy records contain non-finite values', () => {
  const similarity = cosineSimilarity([1, NaN, 0], [1, 2, Infinity]);
  assert.ok(Number.isFinite(similarity));

  const diff = vectorSubtract([NaN, 4, Infinity], [1, NaN, 2]);
  assert.deepEqual(diff, [-1, 4, -2]);
});

test('default memory embeddings use OpenRouter qwen3 embedding model', () => {
  assert.equal(DEFAULT_MEMORY_CONFIG.embeddingProvider, 'openrouter');
  assert.equal(DEFAULT_MEMORY_CONFIG.embeddingModel, 'qwen/qwen3-embedding-8b');
});

test('openrouter batch embedding retries individual inputs after zero-vector batch response', async () => {
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.OPENROUTER_API_KEY;
  const calls: unknown[] = [];

  process.env.OPENROUTER_API_KEY = 'test-key';
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as { input?: string | string[] };
    calls.push(body.input);
    if (Array.isArray(body.input)) {
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    }
    return new Response(JSON.stringify({ data: [{ embedding: [1, 0, 0] }] }), { status: 200 });
  }) as typeof fetch;

  try {
    const vectors = await embedBatch(['openrouter fallback a', 'openrouter fallback b'], 'test-openrouter-model', {
      provider: 'openrouter',
      label: 'test.openrouter.zero_batch',
    });

    assert.deepEqual(vectors, [[1, 0, 0], [1, 0, 0]]);
    assert.equal(calls.length, 3);
    assert.deepEqual(calls[0], ['openrouter fallback a', 'openrouter fallback b']);
    assert.equal(calls[1], 'openrouter fallback a');
    assert.equal(calls[2], 'openrouter fallback b');
  } finally {
    globalThis.fetch = originalFetch;
    if (originalApiKey === undefined) {
      delete process.env.OPENROUTER_API_KEY;
    } else {
      process.env.OPENROUTER_API_KEY = originalApiKey;
    }
  }
});
