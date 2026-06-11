import test from 'node:test';
import assert from 'node:assert/strict';

import { Session } from '../Session.js';
import type { LoadedAgent, Provider, SyntaxType, LoopType } from '../../types/index.js';

const provider: Provider = {
  name: 'test',
  async complete(): Promise<any> {
    return { content: '', finishReason: 'stop' };
  },
};

const syntax: SyntaxType = {
  name: 'test',
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
  wrapThinking: (content) => content,
  wrapAction: (content) => content,
  wrapObservation: (content) => content,
  wrapCli: (content) => content,
  wrapSkills: (content) => content,
  getDescription: () => 'test',
};

const loop: LoopType = {
  name: 'test',
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
  buildContinuationMessages: (currentAssistantContent, observation) => ({
    updatedAssistantContent: currentAssistantContent,
    continuationUserMessage: observation,
  }),
  getDescription: () => 'test',
};

const agent: LoadedAgent = {
  config: {
    name: 'persisted',
    model: 'test-model',
    systemPrompt: 'system.md',
    tools: [],
    loop: 'test',
    syntax: 'test',
    preserveSession: true,
  },
  systemPromptContent: 'system',
  directory: process.cwd(),
};

function buildSession(): Session {
  return new Session({
    agent,
    provider,
    syntax,
    loop,
    tools: [],
  });
}

test('Session export preserves full history for crash recovery', () => {
  const session = buildSession();

  for (let i = 1; i <= 9; i++) {
    session.beginTurn(`user-${i}`);
    session.addUserMessage(`user-${i}`);
    session.addAssistantMessage(`assistant-${i}-internal`);
    session.addUserMessage(`observation-${i}`);
    session.addAssistantMessage(`assistant-${i}-final`);
    session.recordVisibleAssistantOutput(`assistant-${i}-visible`);
    session.markMemoryFactsAsSurfaced([`fact-${i}`], `hint-${i}`);
    session.endTurn();
  }

  const snapshot = session.exportSnapshot();
  assert.equal(snapshot.turns?.length, 9);
  assert.equal(snapshot.messages.length, 9 * 4);
  assert.deepEqual(snapshot.surfacedMemoryFactIds, ['fact-1', 'fact-2', 'fact-3', 'fact-4', 'fact-5', 'fact-6', 'fact-7', 'fact-8', 'fact-9']);
  assert.equal(snapshot.messages[0]?.role, 'user');
  assert.equal(snapshot.messages[0]?.content, 'user-1');
  assert.equal(snapshot.messages[1]?.role, 'assistant');
  assert.equal(snapshot.messages[1]?.content, 'assistant-1-internal');
});

test('Session applies configurable provider window without mutating persisted history', () => {
  const session = buildSession();
  const previousFull = process.env.TELOS_SESSION_FULL_TURN_WINDOW;
  const previousCompact = process.env.TELOS_SESSION_COMPACT_TURN_WINDOW;
  process.env.TELOS_SESSION_FULL_TURN_WINDOW = '5';
  process.env.TELOS_SESSION_COMPACT_TURN_WINDOW = '3';

  try {
    for (let i = 1; i <= 9; i++) {
      session.beginTurn(`user-${i}`);
      session.addUserMessage(`user-${i}`);
      session.recordVisibleAssistantOutput(`assistant-${i}`);
      session.markMemoryFactsAsSurfaced([`fact-${i}`], `hint-${i}`);
      session.endTurn();
    }

    session.injectVisibleMemoryHintsIntoLastUserMessage();
    const allMessages = session.getAllMessages();
    const snapshot = session.exportSnapshot();
    const systemPrompt = session.getSystemPrompt();
    const userMessages = allMessages.filter(message => message.role === 'user').map(message => message.content).join('\n');

    assert.equal(allMessages.length, 1 + (3 * 2) + (5 * 1));
    assert.match(userMessages, /hint-2/);
    assert.doesNotMatch(systemPrompt, /MEMORY HINTS/);
    assert.doesNotMatch(systemPrompt, /hint-1/);
    assert.equal(snapshot.turns?.length, 9);
  } finally {
    if (previousFull === undefined) {
      delete process.env.TELOS_SESSION_FULL_TURN_WINDOW;
    } else {
      process.env.TELOS_SESSION_FULL_TURN_WINDOW = previousFull;
    }
    if (previousCompact === undefined) {
      delete process.env.TELOS_SESSION_COMPACT_TURN_WINDOW;
    } else {
      process.env.TELOS_SESSION_COMPACT_TURN_WINDOW = previousCompact;
    }
  }
});

test('Session snapshot round-trips active turns and execution state', () => {
  const session = buildSession();
  session.beginTurn('resume-me');
  session.addUserMessage('resume-me');
  session.recordVisibleAssistantOutput('partial visible reply');
  session.setExecutionState({
    mode: 'legacy',
    iterations: 3,
    noProgressTurns: 1,
    currentAssistantContent: 'partial assistant body',
    continuationUserMessage: 'continue',
    lastModelTurnContent: 'partial assistant body',
    pendingLegacyOperations: {
      actionCode: 'console.log("hi")',
      filesToWrite: [{ path: 'notes.md', content: 'abc' }],
      diffs: ['--- a'],
      edits: [{ filename: 'x.ts', content: 'SEARCH' }],
    },
  });

  const restored = buildSession();
  restored.applySnapshot(session.exportSnapshot());

  assert.equal(restored.getActiveTurnUserMessage(), 'resume-me');
  assert.equal(restored.captureActiveTurnSnapshot()?.assistantResponses[0], 'partial visible reply');
  assert.equal(restored.getExecutionState()?.currentAssistantContent, 'partial assistant body');
  assert.equal(restored.getExecutionState()?.pendingLegacyOperations?.filesToWrite?.[0]?.path, 'notes.md');
});
