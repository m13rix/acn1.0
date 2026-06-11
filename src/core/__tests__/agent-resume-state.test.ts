import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

import {
  readPersistedAgentSessionState,
  writePersistedAgentSessionState,
} from '../agentResumeState.js';

test('persisted agent session state round-trips descriptor and snapshot', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'telos-agent-resume-state-'));
  const filePath = join(dir, 'resume.json');

  try {
    await writePersistedAgentSessionState(filePath, {
      version: 1,
      savedAt: '2026-04-02T00:00:00.000Z',
      descriptor: {
        label: 'researcher',
        agent: 'researcher',
        modelOverride: 'openai/gpt-5-mini',
      },
      snapshot: {
        messages: [
          { role: 'user', content: 'first request' },
          { role: 'assistant', content: 'first reply' },
        ],
        contextFiles: [
          { filename: 'notes.md', content: 'abc123' },
        ],
        surfacedMemoryFactIds: ['fact-1'],
        injectedMemoryHints: [
          { id: 'fact-1', content: 'remember this' },
        ],
        activeTurn: {
          source: 'user',
          userMessage: 'unfinished request',
          assistantResponses: ['partial answer'],
          messageStartIndex: 2,
          surfacedMemoryFactIds: ['fact-1'],
        },
        executionState: {
          mode: 'legacy',
          iterations: 2,
          currentAssistantContent: 'partial answer',
          continuationUserMessage: 'continue',
          pendingLegacyOperations: {
            actionCode: 'console.log("test")',
            filesToWrite: [{ path: 'draft.md', content: 'hello' }],
            diffs: [],
            edits: [],
          },
        },
      },
    });

    const restored = await readPersistedAgentSessionState(filePath);
    assert.ok(restored);
    assert.equal(restored?.descriptor.agent, 'researcher');
    assert.equal(restored?.snapshot.messages[1]?.content, 'first reply');
    assert.equal(restored?.snapshot.contextFiles[0]?.filename, 'notes.md');
    assert.deepEqual(restored?.snapshot.surfacedMemoryFactIds, ['fact-1']);
    assert.equal(restored?.snapshot.activeTurn?.userMessage, 'unfinished request');
    assert.equal(restored?.snapshot.executionState?.pendingLegacyOperations?.filesToWrite?.[0]?.path, 'draft.md');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
