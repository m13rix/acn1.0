import assert from 'node:assert/strict';
import test from 'node:test';

import type { LoadedAgent } from '../../types/index.js';
import { TelosCodeCatalogService } from './TelosCodeCatalogService.js';

const agents: LoadedAgent[] = [
  {
    config: {
      name: 'Telos-Code',
      description: 'Coding agent',
      model: 'openai/gpt-5',
      provider: 'openrouter',
      reasoning: 'high',
      systemPrompt: 'system.md',
      tools: [],
    },
    systemPromptContent: '',
    directory: 'agents/telos-code',
  },
  {
    config: {
      name: 'Voice',
      model: 'live',
      provider: 'gemini-voice',
      modality: 'voice',
      systemPrompt: 'system.md',
      tools: [],
    },
    systemPromptContent: '',
    directory: 'agents/voice',
  },
];

test('returns text agents, healthy providers, and paged server-side model search', async () => {
  const previousKey = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = 'fixture-key';
  const requests: string[] = [];
  const service = new TelosCodeCatalogService({
    agentLoader: { loadAll: async () => agents } as never,
    fetchImpl: (async (input: string | URL | Request) => {
      const url = String(input);
      requests.push(url);
      if (url === 'https://openrouter.ai/api/v1/models') {
        return new Response(JSON.stringify({
          data: [
            { id: 'openai/gpt-5', name: 'GPT 5', context_length: 200_000 },
            { id: 'openai/gpt-5-mini', name: 'GPT 5 Mini', context_length: 128_000 },
            { id: 'moonshot/kimi', name: 'Kimi' },
          ],
        }), { status: 200 });
      }
      return new Response('{}', { status: 503 });
    }) as typeof fetch,
  });
  try {
    const catalog = await service.getCatalog();
    assert.deepEqual(catalog.agents.map((agent) => agent.name), ['Telos-Code']);
    assert.deepEqual(catalog.providers.map((provider) => provider.id), ['openrouter']);

    const first = await service.listModels({ providerId: 'openrouter', query: 'gpt', limit: 1 });
    assert.equal(first.items[0]?.id, 'openai/gpt-5');
    assert.ok(first.nextCursor);
    const second = await service.listModels({
      providerId: 'openrouter',
      query: 'gpt',
      cursor: first.nextCursor,
      limit: 1,
    });
    assert.equal(second.items[0]?.id, 'openai/gpt-5-mini');
    assert.equal(second.nextCursor, undefined);
    assert.equal(requests.filter((url) => url === 'https://openrouter.ai/api/v1/models').length, 1);
  } finally {
    if (previousKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = previousKey;
  }
});

test('rejects malformed opaque model cursors', async () => {
  const previousKey = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = 'fixture-key';
  const service = new TelosCodeCatalogService({
    agentLoader: { loadAll: async () => agents } as never,
    fetchImpl: (async () => new Response(JSON.stringify({ data: [] }), { status: 200 })) as typeof fetch,
  });
  try {
    await assert.rejects(
      service.listModels({ providerId: 'openrouter', cursor: 'not-a-cursor', limit: 10 }),
      /invalid model catalog cursor/iu,
    );
  } finally {
    if (previousKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = previousKey;
  }
});
