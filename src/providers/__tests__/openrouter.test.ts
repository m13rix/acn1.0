import test from 'node:test';
import assert from 'node:assert/strict';

import { OpenRouterProvider } from '../openrouter.js';
import { buildProviderToolRequest } from '../../core/providerTools.js';

test('replays assistant tool-call reasoning as OpenRouter message.reasoning', () => {
  const provider = new OpenRouterProvider('test-key');
  const request = provider.buildRequestWithTools(
    [
      {
        role: 'assistant',
        content: '',
        reasoning: 'I should inspect the filesystem before answering.',
        toolCalls: [
          {
            id: 'call_1',
            name: 'action',
            arguments: { content: 'console.log(await files.list("."));' },
          },
        ],
      },
    ],
    {
      model: 'moonshotai/kimi-k2.6',
      reasoning: 'medium',
      stream: false,
    },
    buildProviderToolRequest(),
  );

  assert.equal(request.messages[0].reasoning, 'I should inspect the filesystem before answering.');
  assert.equal(request.messages[0].reasoning_content, undefined);
});

test('extracts replayable reasoning from reasoning_details text blocks', () => {
  const provider = new OpenRouterProvider('test-key');
  const request = provider.buildRequestWithTools(
    [
      {
        role: 'assistant',
        content: '',
        reasoningDetails: [
          { type: 'reasoning.text', text: 'Need to run a tool.' },
          { type: 'reasoning.summary', summary: 'Tool needed.' },
        ],
        toolCalls: [
          {
            id: 'call_1',
            name: 'action',
            arguments: { content: 'console.log(await files.list("."));' },
          },
        ],
      },
    ],
    {
      model: 'moonshotai/kimi-k2.6',
      reasoning: 'medium',
      stream: false,
    },
    buildProviderToolRequest(),
  );

  assert.equal(request.messages[0].reasoning, 'Need to run a tool.\nTool needed.');
});
