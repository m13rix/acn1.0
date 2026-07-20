import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { v7 as uuidv7 } from 'uuid';

import type { ThreadLaunchProfile } from '@telos/code-contracts/telos';
import { ThreadStore } from './ThreadStore.js';

async function withStore(
  run: (store: ThreadStore, directory: string) => Promise<void> | void,
): Promise<void> {
  const directory = join(tmpdir(), `telos-thread-store-${uuidv7()}`);
  await mkdir(directory, { recursive: true });
  const store = await ThreadStore.open({ databasePath: join(directory, 'threads.db') });
  try {
    await run(store, directory);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
}

function launchProfile(projectId: string, workspacePath: string): ThreadLaunchProfile {
  return {
    projectId: projectId as ThreadLaunchProfile['projectId'],
    workspacePath,
    worktreePath: null,
    agentName: 'executor',
    resolvedAgentConfig: {
      preserveSession: true,
      provider: 'openai-codex',
      model: 'gpt-5.6-codex',
      reasoning: 'high',
      modelSwitching: { mode: 'whitelist', whitelist: ['gpt-5.6-codex'] },
    },
    providerId: 'openai-codex',
    modelId: 'gpt-5.6-codex',
    reasoning: 'high',
  };
}

test('persists immutable launch profiles and monotonic replayable events', async () => {
  await withStore((store, directory) => {
    const project = store.createProject({ path: directory, displayName: 'Fixture' });
    const thread = store.createThread({ launchProfile: launchProfile(project.id, directory) });
    store.appendEvent(thread.id, 'message', { role: 'user', text: 'first' }, 'event-1');
    store.appendEvent(thread.id, 'message', { role: 'assistant', text: 'second' }, 'event-2');

    const replay = store.replayEvents(thread.id, 1);
    assert.deepEqual(
      replay.map((event) => [event.sequence, event.eventId]),
      [
        [2, 'event-1'],
        [3, 'event-2'],
      ],
    );
    assert.equal(store.getThread(thread.id)?.launchProfile.modelId, 'gpt-5.6-codex');
  });
});

test('deduplicates commands and enforces projection versions', async () => {
  await withStore((store, directory) => {
    const project = store.createProject({ path: directory });
    const thread = store.createThread({ launchProfile: launchProfile(project.id, directory) });
    let executions = 0;
    const first = store.executeIdempotently('command-1', 'thread.rename', () => {
      executions += 1;
      return store.renameThread(thread.id, 'Renamed', 1);
    });
    const replayed = store.executeIdempotently('command-1', 'thread.rename', () => {
      executions += 1;
      return null;
    });

    assert.equal(executions, 1);
    assert.equal(first.title, 'Renamed');
    assert.deepEqual(replayed, first);
    assert.throws(() => store.renameThread(thread.id, 'Stale', 1), /version conflict/);
  });
});

test('imports legacy JSON once and leaves source files untouched', async () => {
  await withStore(async (store, directory) => {
    const legacyDirectory = join(directory, 'legacy');
    await mkdir(legacyDirectory, { recursive: true });
    const session = {
      version: 1,
      savedAt: '2026-07-20T00:00:00.000Z',
      sessionKey: 'shared-agent:executor:fixture',
      agentName: 'executor',
      runPath: directory,
      snapshot: {
        messages: [
          { role: 'user', content: 'Continue the migration' },
          { role: 'assistant', content: 'Ready.' },
        ],
        contextFiles: [],
        surfacedMemoryFactIds: [],
        injectedMemoryHints: [],
      },
    };
    await writeFile(join(legacyDirectory, 'session.json'), JSON.stringify(session));
    await writeFile(
      join(legacyDirectory, 'route-index.json'),
      JSON.stringify({ 'telegram:1': { agentName: 'executor', runPath: directory } }),
    );

    const migrationStore = await ThreadStore.open({
      databasePath: join(directory, 'migration.db'),
      legacySessionsPath: legacyDirectory,
    });
    try {
      const first = await migrationStore.migrateLegacySessions();
      const second = await migrationStore.migrateLegacySessions();
      assert.equal(first.importedThreads, 1);
      assert.equal(second.alreadyCompleted, true);
      assert.equal(migrationStore.listThreads().length, 1);
      assert.equal(migrationStore.getActiveThread('telegram:1'), migrationStore.listThreads()[0]?.id);
      assert.equal(existsSync(join(legacyDirectory, 'session.json')), true);
    } finally {
      migrationStore.close();
    }
  });
});
