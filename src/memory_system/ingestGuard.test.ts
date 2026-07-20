import assert from 'node:assert/strict';
import test from 'node:test';

import { MemoryQueueService } from './MemoryQueueService.js';
import { MemoryService } from './MemoryService.js';
import { assertMemoryIngestAllowed, isMemoryIngestAllowed } from './ingestGuard.js';

const originalDisabled = process.env.TELOS_MEMORY_INGEST_DISABLED;

test.afterEach(() => {
  if (originalDisabled === undefined) {
    delete process.env.TELOS_MEMORY_INGEST_DISABLED;
  } else {
    process.env.TELOS_MEMORY_INGEST_DISABLED = originalDisabled;
  }
});

test('memory ingestion is enabled by default', () => {
  delete process.env.TELOS_MEMORY_INGEST_DISABLED;

  assert.equal(isMemoryIngestAllowed(), true);
  assert.doesNotThrow(() => assertMemoryIngestAllowed());
});

test('memory ingestion can be temporarily disabled process-wide', async () => {
  process.env.TELOS_MEMORY_INGEST_DISABLED = '1';

  assert.equal(isMemoryIngestAllowed(), false);
  assert.throws(() => assertMemoryIngestAllowed(), /temporarily disabled/);
  await assert.rejects(
    () => new MemoryService().ingestText({ text: 'blocked' }),
    /temporarily disabled/,
  );
  await assert.rejects(
    () => new MemoryQueueService({} as MemoryService).enqueue({ text: 'blocked' }),
    /temporarily disabled/,
  );
});
