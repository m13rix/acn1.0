import test from 'node:test';
import assert from 'node:assert/strict';

import {
  __internals,
  clearPersistedChatSessionState,
  readPersistedChatSessionState,
  savePersistedChatSessionState,
  savePersistedRouteSelection,
  readPersistedRouteSelection,
} from './chatSessionPersistence.js';

test('shared session persistence can be read independently from route selection', async () => {
  const originalReadIndex = __internals.readIndex;
  const originalWriteIndex = __internals.writeIndex;
  const index: Record<string, any> = {};

  (__internals as any).readIndex = async () => ({ ...index });
  (__internals as any).writeIndex = async (next: Record<string, any>) => {
    Object.keys(index).forEach((key) => delete index[key]);
    Object.assign(index, next);
  };

  try {
    await savePersistedChatSessionState({
      version: 1,
      savedAt: '2026-04-12T00:00:00.000Z',
      sessionKey: 'shared-agent:core',
      agentName: 'core',
      snapshot: {
        messages: [{ role: 'user', content: 'hi' }],
        contextFiles: [],
        surfacedMemoryFactIds: [],
        injectedMemoryHints: [],
        activeTurn: {
          source: 'user',
          userMessage: 'resume this',
          assistantResponses: [],
          messageStartIndex: 1,
          surfacedMemoryFactIds: [],
        },
        executionState: {
          mode: 'provider-tools',
          iterations: 4,
          pendingProviderToolCalls: [
            {
              id: 'tool-1',
              name: 'file',
              arguments: { filename: 'notes.md', content: 'hello' },
            },
          ],
          nextProviderToolIndex: 0,
        },
      },
    }, { updateRouteSelection: false });

    await savePersistedRouteSelection('route-a', {
      agentName: 'core',
      savedAt: '2026-04-12T00:00:00.000Z',
    });

    const persisted = await readPersistedChatSessionState('shared-agent:core', 'core');
    const selection = await readPersistedRouteSelection('route-a');

    assert.ok(persisted);
    assert.equal(persisted?.sessionKey, 'shared-agent:core');
    assert.equal(persisted?.snapshot.activeTurn?.userMessage, 'resume this');
    assert.equal(persisted?.snapshot.executionState?.pendingProviderToolCalls?.[0]?.name, 'file');
    assert.equal(selection?.agentName, 'core');
  } finally {
    await clearPersistedChatSessionState('shared-agent:core', 'core', undefined, { clearRouteSelection: false });
    (__internals as any).readIndex = originalReadIndex;
    (__internals as any).writeIndex = originalWriteIndex;
  }
});
