import test from 'node:test';
import assert from 'node:assert/strict';
import type { Message } from '../src/types/index.js';
import { __internals } from '../tools/minecraft/index.js';

test('minecraft tool extracts the first fenced code block', () => {
  const code = __internals.extractFirstCodeFence([
    'Here is the script:',
    '```javascript',
    'console.log("hello");',
    '```',
    '```javascript',
    'console.log("second");',
    '```',
  ].join('\n'));

  assert.equal(code, 'console.log("hello");');
});

test('minecraft tool retries with preserved history after execution failure', async () => {
  const seenMessages: Message[][] = [];
  let generationCount = 0;
  let executionCount = 0;

  const result = await __internals.runConductTest('Run a combat trial', {
    systemPrompt: 'System prompt.',
    maxAttempts: 2,
    generate: async (messages) => {
      seenMessages.push(messages.map((message) => ({ ...message })));
      generationCount += 1;

      if (generationCount === 1) {
        return '```javascript\nconsole.log("broken");\n```';
      }

      return '```javascript\nconsole.log("fixed");\n```';
    },
    execute: async () => {
      executionCount += 1;

      if (executionCount === 1) {
        return {
          success: false,
          output: '',
          errorText: 'ReferenceError: bot is not defined',
        };
      }

      return {
        success: true,
        output: 'test finished',
        errorText: '',
      };
    },
  });

  assert.equal(result, 'test finished');
  assert.equal(seenMessages.length, 2);
  assert.equal(seenMessages[0]?.length, 2);
  assert.equal(seenMessages[0]?.[0]?.role, 'system');
  assert.equal(seenMessages[0]?.[1]?.role, 'user');
  assert.equal(seenMessages[1]?.at(-1)?.role, 'user');
  assert.match(seenMessages[1]?.at(-1)?.content || '', /ReferenceError: bot is not defined/);
});
