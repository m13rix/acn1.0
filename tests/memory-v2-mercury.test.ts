import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { normalizeMemoryText, weightQueryPhrases } from '../src/memory_system/mercury.ts';

const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_API_KEY = process.env.INCEPTION_API_KEY;

test('Mercury normalization uses instant reasoning and returns rewritten text', async () => {
  const requests = [];
  process.env.INCEPTION_API_KEY = 'test-key';

  globalThis.fetch = async (_url, init) => {
    requests.push(JSON.parse(String(init?.body ?? '{}')));
    return new Response(JSON.stringify({
      choices: [{
        message: {
          content: 'Subject 3 observed that Subject 14 was likely late.',
        },
        finish_reason: 'stop',
      }],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  const result = await normalizeMemoryText('She said he was probably late.', {
    table: 'global_memory_v2',
    mercuryProvider: 'inception',
    mercuryModel: 'mercury-2',
    mercuryTemperature: 0,
    mercuryMaxTokens: 4000,
    embeddingModel: 'bge-m3',
    linkCandidatePoolMax: 40,
    maxAutoLinksPerFact: 4,
    semanticMergeThreshold: 0.92,
    overallEmbeddingWeight: 0.35,
    searchDefaultAggregationMode: 'max',
    searchDefaultCandidateMode: 'top-k',
    searchDefaultTopK: 5,
    searchDefaultThreshold: 0.35,
    searchDefaultRangeMin: 3,
    searchDefaultRangeMax: 8,
    searchMaxDepth: 2,
    searchBeamWidth: 10,
    searchMaxChains: 5,
  });

  assert.equal(result, 'Subject 3 observed that Subject 14 was likely late.');
  assert.equal(requests[0]?.model, 'mercury-2');
  assert.equal(requests[0]?.reasoning_effort, 'instant');
});

test('Mercury phrase weighting preserves input order and normalizes weights', async () => {
  process.env.INCEPTION_API_KEY = 'test-key';

  globalThis.fetch = async () => new Response(JSON.stringify({
    choices: [{
      message: {
        content: JSON.stringify({
          weights: [
            { phrase: 'Subject 13', weight: 0.9 },
            { phrase: 'relationship', weight: 0.1 },
          ],
        }),
      },
      finish_reason: 'stop',
    }],
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });

  const weights = await weightQueryPhrases('What is the relationship of Subject 13?', [
    { type: 'vp', text: 'relationship' },
    { type: 'np', text: 'Subject 13' },
  ], {
    table: 'global_memory_v2',
    mercuryProvider: 'inception',
    mercuryModel: 'mercury-2',
    mercuryTemperature: 0,
    mercuryMaxTokens: 4000,
    embeddingModel: 'bge-m3',
    linkCandidatePoolMax: 40,
    maxAutoLinksPerFact: 4,
    semanticMergeThreshold: 0.92,
    overallEmbeddingWeight: 0.35,
    searchDefaultAggregationMode: 'max',
    searchDefaultCandidateMode: 'top-k',
    searchDefaultTopK: 5,
    searchDefaultThreshold: 0.35,
    searchDefaultRangeMin: 3,
    searchDefaultRangeMax: 8,
    searchMaxDepth: 2,
    searchBeamWidth: 10,
    searchMaxChains: 5,
  });

  assert.deepEqual(weights.map((item) => item.phrase), ['relationship', 'Subject 13']);
  assert.equal(Number((weights[0].weight + weights[1].weight).toFixed(4)), 1);
  assert.ok(weights[1].weight > weights[0].weight);
});

after(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  if (ORIGINAL_API_KEY === undefined) {
    delete process.env.INCEPTION_API_KEY;
  } else {
    process.env.INCEPTION_API_KEY = ORIGINAL_API_KEY;
  }
});
