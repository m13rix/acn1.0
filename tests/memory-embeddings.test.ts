import assert from 'node:assert/strict';
import test from 'node:test';
import { __internals, cosineSimilarity, vectorSubtract } from '../src/memory_system/embeddings.ts';

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
