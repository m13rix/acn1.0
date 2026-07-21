import test from 'node:test';
import assert from 'node:assert/strict';

import { AdaptiveStepContextService } from '../Service.js';

function testSession() {
  return {
    id: 'durable-thread-test',
    agent: {
      config: {
        name: 'test-agent',
        adaptiveStepContext: {
          enabled: true,
          pruning: { enabled: true },
        },
      },
    },
    getMessages: () => [{ role: 'user' as const, content: 'Keep this task in context.' }],
  };
}

test('keeps adaptive timeline step indices monotonic across provider turns', () => {
  const service = new AdaptiveStepContextService();
  const internals = service as any;
  internals.queueEmbedding = () => {};
  internals.persistSession = () => {};
  const session = testSession() as any;

  service.recordStep({
    session,
    messages: [{ role: 'assistant', content: 'First provider step.' }],
    stepNumber: 0,
  });
  service.recordStep({
    session,
    messages: [{ role: 'assistant', content: 'First step of the next provider turn.' }],
    stepNumber: 0,
  });

  assert.deepEqual(service.getSession(session.id)?.steps.map(step => step.index), [0, 1]);
});

test('never compacts adaptive messages while observation-only mode is active', () => {
  const service = new AdaptiveStepContextService();
  const session = testSession() as any;
  const messages = [
    { role: 'assistant' as const, content: 'Keep this complete.', adaptiveStepIndex: 0 },
    { role: 'tool' as const, content: 'Keep this tool output.', adaptiveStepIndex: 0 },
  ];

  const result = service.compactMessagesForPrompt(session, messages);

  assert.deepEqual(
    result.map(({ role, content, adaptiveStepIndex }) => ({ role, content, adaptiveStepIndex })),
    messages,
  );
  assert.notEqual(result[0], messages[0]);
});
