import test from 'node:test';
import assert from 'node:assert/strict';
import { Session, formatLocalDeviceTime } from '../Session.js';

function createSession(tools: any[] = [], memoryConfig?: any): Session {
  return new Session({
    agent: {
      config: {
        name: 'test-agent',
        model: 'test-model',
        systemPrompt: 'system.md',
        tools: [],
        loop: 'default',
        syntax: 'xml-tags',
        ...(memoryConfig !== undefined ? { memory: memoryConfig } : {}),
      },
      systemPromptContent: 'Base instructions.',
      directory: process.cwd(),
    } as any,
    provider: {
      name: 'test-provider',
      complete: async () => ({ content: '', finishReason: 'stop' as const }),
    } as any,
    syntax: {
      name: 'xml-tags',
      getThinking: () => null,
      getAction: () => null,
      getObservation: () => null,
      getCli: () => null,
      getSkills: () => null,
      getFiles: () => [],
      getDiffs: () => [],
      getEdits: () => [],
      hasAction: () => false,
      hasCli: () => false,
      isActionClosed: () => false,
      isCliClosed: () => false,
      hasAnyClosedBlock: () => false,
      wrapThinking: (content: string) => content,
      wrapAction: (content: string) => content,
      wrapObservation: (content: string) => content,
      wrapCli: (content: string) => content,
      wrapSkills: (content: string) => content,
      getDescription: () => '',
    } as any,
    loop: {
      name: 'default',
      processResponse: () => ({
        hasAction: false,
        actionCode: null,
        hasCli: false,
        cliCommand: null,
        filesToWrite: [],
        diffs: [],
        edits: [],
        fullResponse: '',
      }),
      buildContinuationMessages: () => ({
        updatedAssistantContent: '',
        continuationUserMessage: '',
      }),
      getDescription: () => '',
    } as any,
    tools,
    sandbox: {
      id: 'sandbox',
      directory: process.cwd(),
      initialize: async () => {},
      execute: async () => ({ success: true, output: '' }),
      executeCli: async () => ({ success: true, output: '' }),
      parseSearchReplace: () => [],
      applySearchReplace: async () => ({ success: true, output: '' }),
      cleanup: async () => {},
      getDescription: () => '',
    } as any,
  });
}

test('markMemoryFactsAsSurfaced appends memory hints to the last user message and avoids system prompt churn', async () => {
  const session = createSession();
  session.beginTurn('debug a failed build');
  session.addUserMessage('debug a failed build');
  session.markMemoryFactsAsSurfaced(
    ['fact-build-debug'],
    'When a build fails after a CLI tool result, inspect the failing command output first.',
  );
  session.injectVisibleMemoryHintsIntoLastUserMessage();

  const allMessages = session.getAllMessages();
  const lastUserMessage = [...allMessages].reverse().find(message => message.role === 'user')?.content || '';

  assert.doesNotMatch(session.getSystemPrompt(), /MEMORY HINTS:/);
  assert.match(lastUserMessage, /MEMORY HINTS:\n\nWhen a build fails after a CLI tool result/);
  assert.equal(lastUserMessage.split('When a build fails after a CLI tool result').length - 1, 1);
});

test('memory hints are hidden when memory is disabled', async () => {
  const session = createSession([], { enabled: false });
  session.beginTurn('debug a failed build');
  session.markMemoryFactsAsSurfaced(
    ['fact-disabled-memory'],
    'This hint should not be visible while memory is disabled.',
  );

  assert.doesNotMatch(session.getSystemPrompt(), /MEMORY HINTS:/);
  assert.doesNotMatch(session.getSystemPrompt(), /This hint should not be visible/);
});

test('memory hints are hidden when auto hints are disabled', async () => {
  const session = createSession([], { enabled: true, autoHints: { enabled: false } });
  session.beginTurn('debug a failed build');
  session.markMemoryFactsAsSurfaced(
    ['fact-disabled-auto-hints'],
    'This hint should not be visible while auto hints are disabled.',
  );

  assert.doesNotMatch(session.getSystemPrompt(), /MEMORY HINTS:/);
  assert.doesNotMatch(session.getSystemPrompt(), /This hint should not be visible/);
});

test('Session appends the local device time context to the system prompt', () => {
  const session = createSession();
  const fixedNow = new Date('2026-03-18T15:04:05');

  assert.equal(formatLocalDeviceTime(fixedNow), 'Local device time: Wednesday, 2026-03-18 15:04:05');

  const prompt = session.getSystemPrompt();
  assert.match(prompt, /Local device time: [A-Za-z]+, \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
});
