import test from 'node:test';
import assert from 'node:assert/strict';

import { telosMessagesToModelMessages } from './message-mapper.js';
import type { Message } from '../types/index.js';

const assistantWithReasoning: Message = {
  role: 'assistant',
  content: 'visible answer',
  reasoning: 'private chain worth preserving',
};

test('telosMessagesToModelMessages omits assistant reasoning by default', () => {
  const [message] = telosMessagesToModelMessages([assistantWithReasoning]);

  assert.equal(message?.role, 'assistant');
  assert.deepEqual((message as any).content, [
    { type: 'text', text: 'visible answer' },
  ]);
});

test('telosMessagesToModelMessages replays assistant reasoning when enabled', () => {
  const [message] = telosMessagesToModelMessages([assistantWithReasoning], {
    preserveReasoning: true,
  });

  assert.equal(message?.role, 'assistant');
  assert.deepEqual((message as any).content, [
    { type: 'reasoning', text: 'private chain worth preserving' },
    { type: 'text', text: 'visible answer' },
  ]);
});
