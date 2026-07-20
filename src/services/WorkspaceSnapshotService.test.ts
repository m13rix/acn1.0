import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { v7 as uuidv7 } from 'uuid';

import { ThreadStore } from './thread-store/ThreadStore.js';
import { WorkspaceSnapshotService } from './WorkspaceSnapshotService.js';

async function withSnapshotService(
  run: (input: {
    service: WorkspaceSnapshotService;
    store: ThreadStore;
    workspace: string;
    snapshotRoot: string;
  }) => Promise<void>,
): Promise<void> {
  const root = join(tmpdir(), `telos-workspace-snapshot-${uuidv7()}`);
  const workspace = join(root, 'workspace');
  const snapshotRoot = join(root, 'snapshot-store');
  await mkdir(workspace, { recursive: true });
  const store = await ThreadStore.open({ databasePath: join(root, 'threads.db') });
  const service = new WorkspaceSnapshotService(store, snapshotRoot);
  try {
    await run({ service, store, workspace, snapshotRoot });
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
}

async function countFiles(directory: string): Promise<number> {
  if (!existsSync(directory)) return 0;
  let count = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) count += await countFiles(join(directory, entry.name));
    else count += 1;
  }
  return count;
}

test('snapshots literal workspace content, diffs changes, and rolls back without touching exclusions', async () => {
  await withSnapshotService(async ({ service, workspace }) => {
    await mkdir(join(workspace, 'nested'), { recursive: true });
    await mkdir(join(workspace, '.git'), { recursive: true });
    await writeFile(join(workspace, '.telos-snapshotignore'), '*.log\n');
    await writeFile(join(workspace, 'a.txt'), 'before');
    await writeFile(join(workspace, 'nested', 'keep.txt'), 'keep');
    await writeFile(join(workspace, 'runtime.log'), 'outside rollback');
    await writeFile(join(workspace, '.git', 'HEAD'), 'ref: refs/heads/main');

    const checkpoint = await service.snapshot({ workspacePath: workspace, name: 'baseline' });
    await writeFile(join(workspace, 'a.txt'), 'after');
    await rm(join(workspace, 'nested', 'keep.txt'));
    await writeFile(join(workspace, 'new.txt'), 'new');
    await writeFile(join(workspace, 'runtime.log'), 'still outside rollback');
    await writeFile(join(workspace, '.git', 'HEAD'), 'ref: refs/heads/other');

    const diff = await service.diff(checkpoint.id);
    assert.deepEqual(
      diff.entries.map((entry) => [entry.path, entry.status]),
      [
        ['a.txt', 'modified'],
        ['nested/keep.txt', 'deleted'],
        ['new.txt', 'added'],
      ],
    );

    const result = await service.rollback(checkpoint.id);
    assert.equal(await readFile(join(workspace, 'a.txt'), 'utf8'), 'before');
    assert.equal(await readFile(join(workspace, 'nested', 'keep.txt'), 'utf8'), 'keep');
    assert.equal(existsSync(join(workspace, 'new.txt')), false);
    assert.equal(await readFile(join(workspace, 'runtime.log'), 'utf8'), 'still outside rollback');
    assert.equal(await readFile(join(workspace, '.git', 'HEAD'), 'utf8'), 'ref: refs/heads/other');
    assert.match(result.safetyCheckpoint.name || '', /^Safety before rollback/u);
    assert.deepEqual((await service.diff(checkpoint.id)).entries, []);
  });
});

test('supports partial rollback while safety-snapshotting the complete workspace', async () => {
  await withSnapshotService(async ({ service, workspace }) => {
    await writeFile(join(workspace, 'a.txt'), 'a1');
    await writeFile(join(workspace, 'b.txt'), 'b1');
    const baseline = await service.snapshot({ workspacePath: workspace });
    await writeFile(join(workspace, 'a.txt'), 'a2');
    await writeFile(join(workspace, 'b.txt'), 'b2');

    const rollback = await service.rollback(baseline.id, { files: ['a.txt'] });
    assert.equal(await readFile(join(workspace, 'a.txt'), 'utf8'), 'a1');
    assert.equal(await readFile(join(workspace, 'b.txt'), 'utf8'), 'b2');
    assert.equal(service.listSnapshots().some((item) => item.id === rollback.safetyCheckpoint.id), true);
    assert.deepEqual(
      (await service.diff(baseline.id)).entries.map((entry) => entry.path),
      ['b.txt'],
    );
  });
});

test('deduplicates blobs and garbage-collects only the final checkpoint reference', async () => {
  await withSnapshotService(async ({ service, workspace, snapshotRoot }) => {
    await writeFile(join(workspace, 'shared.txt'), 'same bytes');
    const first = await service.snapshot({ workspacePath: workspace });
    const second = await service.snapshot({ workspacePath: workspace });
    assert.equal(await countFiles(join(snapshotRoot, 'blobs')), 1);

    await service.deleteSnapshot(first.id);
    assert.equal(await countFiles(join(snapshotRoot, 'blobs')), 1);
    await service.deleteSnapshot(second.id);
    assert.equal(await countFiles(join(snapshotRoot, 'blobs')), 0);
  });
});

test('rejects a snapshot store nested inside the workspace', async () => {
  await withSnapshotService(async ({ store, workspace }) => {
    const nested = new WorkspaceSnapshotService(store, join(workspace, '.snapshot-store'));
    await assert.rejects(() => nested.snapshot({ workspacePath: workspace }), /must be outside/u);
  });
});
