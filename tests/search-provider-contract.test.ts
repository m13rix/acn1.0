import assert from 'node:assert/strict';
import test from 'node:test';
import { diagnose, docs, imageSearch, search } from '../tools/search/index.ts';

const ORIGINAL_TAVILY_KEY = process.env.TAVILY_API_KEY;

function withoutTavilyKey(): void {
  delete process.env.TAVILY_API_KEY;
}

function restore(): void {
  if (ORIGINAL_TAVILY_KEY === undefined) delete process.env.TAVILY_API_KEY;
  else process.env.TAVILY_API_KEY = ORIGINAL_TAVILY_KEY;
}

test('search retains natural object inputs and fails with a provider-specific configuration error', async () => {
  withoutTavilyKey();
  try {
    await assert.rejects(
      search({ query: 'router setup', numResults: 3, output: 'full', includeDomains: ['example.test'] }),
      /Tavily is not configured/,
    );
  } finally {
    restore();
  }
});

test('image search retains the count alias', async () => {
  withoutTavilyKey();
  try {
    await assert.rejects(imageSearch({ query: 'network rack', count: 2 }), /Tavily is not configured/);
  } finally {
    restore();
  }
});

test('provider-neutral recovery APIs retain their established object inputs', async () => {
  const diagnostic = await diagnose({ question: 'Why did a provider request fail?', jobId: 'job-1' });
  const documentation = await docs({ question: 'What arguments does search.search accept?' });
  assert.equal(diagnostic.provider, 'tavily-exa');
  assert.match(String(diagnostic.guidance), /lower result limits/i);
  assert.equal(documentation.provider, 'tavily-exa');
  assert.match(String(documentation.guidance), /search\.help/);
});
