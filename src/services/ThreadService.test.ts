import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { v7 as uuidv7 } from 'uuid';

import type { ThreadLaunchProfile } from '@telos/code-contracts/telos';
import { ThreadService, type ThreadExecutionAdapter } from './ThreadService.js';
import { ThreadStore } from './thread-store/ThreadStore.js';
import { WorkspaceSnapshotService } from './WorkspaceSnapshotService.js';

async function fixture(
  adapter: ThreadExecutionAdapter,
  run: (service: ThreadService, store: ThreadStore, directory: string) => Promise<void>,
): Promise<void> {
  const directory = join(tmpdir(), `telos-thread-service-${uuidv7()}`);
  await mkdir(directory, { recursive: true });
  const store = await ThreadStore.open({ databasePath: join(directory, 'threads.db') });
  const service = new ThreadService(store, { executionAdapter: adapter });
  try {
    await run(service, store, directory);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
}

function profile(projectId: string, workspacePath: string): ThreadLaunchProfile {
  return {
    projectId: projectId as ThreadLaunchProfile['projectId'],
    workspacePath,
    worktreePath: null,
    agentName: 'executor',
    resolvedAgentConfig: { preserveSession: true },
    providerId: 'openrouter',
    modelId: 'openai/gpt-5.6',
    reasoning: 'xhigh',
  };
}

test('serializes root turns that target the same physical workspace', async () => {
  let active = 0;
  let maximumActive = 0;
  const order: string[] = [];
  const adapter: ThreadExecutionAdapter = {
    async execute(input) {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      order.push(`start:${input.turn.inputText}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
      input.callbacks.onTextDelta?.(input.turn.inputText, input.turn.inputText);
      input.callbacks.onTextDone?.(input.turn.inputText);
      order.push(`end:${input.turn.inputText}`);
      active -= 1;
      return {
        response: input.turn.inputText,
        snapshot: {
          messages: [],
          contextFiles: [],
          surfacedMemoryFactIds: [],
          injectedMemoryHints: [],
        },
      };
    },
  };

  await fixture(adapter, async (service, store, directory) => {
    const project = store.createProject({ path: directory });
    const firstThread = store.createThread({ launchProfile: profile(project.id, directory) });
    const secondThread = store.createThread({ launchProfile: profile(project.id, directory) });
    const first = service.enqueueTurn({ threadId: firstThread.id, text: 'first' });
    const second = service.enqueueTurn({ threadId: secondThread.id, text: 'second' });
    await Promise.all([first.completed, second.completed]);

    assert.equal(maximumActive, 1);
    assert.deepEqual(order, ['start:first', 'end:first', 'start:second', 'end:second']);
    assert.equal(store.getTurn(first.turnId)?.effectiveEffort, 'high');
  });
});

test('stop records partial output and lets the queued follow-up continue', async () => {
  const adapter: ThreadExecutionAdapter = {
    async execute(input) {
      input.callbacks.onTextDelta?.('partial', 'partial');
      if (input.turn.inputText === 'first') {
        await new Promise<void>((_resolve, reject) => {
          input.signal.addEventListener('abort', () => reject(input.signal.reason), { once: true });
        });
      }
      input.callbacks.onTextDone?.('done');
      return {
        response: 'done',
        snapshot: {
          messages: [],
          contextFiles: [],
          surfacedMemoryFactIds: [],
          injectedMemoryHints: [],
        },
      };
    },
  };

  await fixture(adapter, async (service, store, directory) => {
    const project = store.createProject({ path: directory });
    const thread = store.createThread({ launchProfile: profile(project.id, directory) });
    const first = service.enqueueTurn({ threadId: thread.id, text: 'first' });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const second = service.stopAndSend({ threadId: thread.id, text: 'second' });
    const [stopped, completed] = await Promise.all([first.completed, second.completed]);

    assert.equal(stopped.status, 'stopped');
    assert.equal(completed.status, 'completed');
    const events = store.replayEvents(thread.id, 0);
    assert.ok(events.some((event) => (event.payload as Record<string, unknown>)['partial'] === true));
    assert.equal(store.getThread(thread.id)?.status, 'idle');
  });
});

test('creates authoritative before and after workspace checkpoints for a root turn', async () => {
  const directory = join(tmpdir(), `telos-thread-checkpoints-${uuidv7()}`);
  const snapshotRoot = join(tmpdir(), `telos-snapshot-cas-${uuidv7()}`);
  await mkdir(directory, { recursive: true });
  const store = await ThreadStore.open({ databasePath: join(directory, 'threads.db') });
  const snapshots = new WorkspaceSnapshotService(store, snapshotRoot);
  const adapter: ThreadExecutionAdapter = {
    async execute(input) {
      input.callbacks.onTextDone?.('done');
      return {
        response: 'done',
        snapshot: {
          messages: [],
          contextFiles: [],
          surfacedMemoryFactIds: [],
          injectedMemoryHints: [],
        },
      };
    },
  };
  const service = new ThreadService(store, { executionAdapter: adapter, workspaceSnapshots: snapshots });
  try {
    const project = store.createProject({ path: directory });
    const thread = store.createThread({ launchProfile: profile(project.id, directory) });
    await service.enqueueTurn({ threadId: thread.id, text: 'checkpoint this' }).completed;

    assert.deepEqual(
      snapshots.listSnapshots({ threadId: thread.id }).map((checkpoint) => checkpoint.name).sort(),
      ['After completed turn', 'Before turn'],
    );
    assert.equal(
      store.replayEvents(thread.id, 0).filter((event) => event.type === 'activity'
        && (event.payload as Record<string, unknown>)['activityType'] === 'checkpoint').length,
      2,
    );
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
    await rm(snapshotRoot, { recursive: true, force: true });
  }
});

test('persists action-worker questions and accepts only the first interface answer', async () => {
  const adapter: ThreadExecutionAdapter = {
    async execute(input) {
      const answer = await input.callbacks.onServiceRequest?.(
        'interaction.create',
        {
          request: {
            questions: [{ id: 'choice', type: 'single-select', question: 'Choose', options: [
              { id: 'a', label: 'A' },
              { id: 'b', label: 'B' },
            ] }],
          },
        },
        [],
      ) as Record<string, unknown>;
      await input.callbacks.onServiceRequest?.('message.publish', { text: `Selected ${answer.choice}` }, []);
      return {
        response: 'done',
        snapshot: {
          messages: [],
          contextFiles: [],
          surfacedMemoryFactIds: [],
          injectedMemoryHints: [],
        },
      };
    },
  };

  await fixture(adapter, async (service, store, directory) => {
    const project = store.createProject({ path: directory });
    const thread = store.createThread({ launchProfile: profile(project.id, directory) });
    const turn = service.enqueueTurn({ threadId: thread.id, text: 'ask me' });
    let interactionId = '';
    for (let attempt = 0; attempt < 50 && !interactionId; attempt += 1) {
      const request = store.replayEvents(thread.id, 0).find((event) => event.type === 'interaction');
      const value = (request?.payload as Record<string, unknown> | undefined)?.interactionId;
      if (typeof value === 'string') interactionId = value;
      else await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.ok(interactionId);
    assert.equal(store.getThread(thread.id)?.status, 'waiting-input');
    assert.equal(service.answerInteraction({ interactionId, answers: { choice: 'a' } }).accepted, true);
    assert.equal(service.answerInteraction({ interactionId, answers: { choice: 'b' } }).accepted, false);
    assert.equal((await turn.completed).status, 'completed');
    assert.ok(
      store.replayEvents(thread.id, 0).some((event) =>
        event.type === 'message' && (event.payload as Record<string, unknown>).text === 'Selected a'),
    );
  });
});
