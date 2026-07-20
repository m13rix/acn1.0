import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { v7 as uuidv7 } from 'uuid';

import { decodeDirectPairingCode } from '@telos/link-core';

import { TelosCodeRuntime } from './TelosCodeRuntime.js';

test('starts the real direct endpoint and preserves its harness identity', async () => {
  const directory = join(tmpdir(), `telos-code-runtime-${uuidv7()}`);
  const legacySessionsPath = join(directory, 'legacy');
  await mkdir(legacySessionsPath, { recursive: true });
  let first: TelosCodeRuntime | undefined;
  let second: TelosCodeRuntime | undefined;
  try {
    first = await TelosCodeRuntime.start({
      dataDirectory: directory,
      legacySessionsPath,
      listenPort: 0,
      pairingHost: '127.0.0.1',
      approveClient: () => false,
    });
    const firstHarnessId = first.harnessId;
    const pairing = first.beginPairing();
    const decoded = decodeDirectPairingCode(pairing.code);
    assert.equal(decoded.route.host, '127.0.0.1');
    assert.equal(decoded.route.port, first.listenPort);
    assert.ok(first.listenPort > 0);
    await first.close();
    first = undefined;

    second = await TelosCodeRuntime.start({
      dataDirectory: directory,
      legacySessionsPath,
      listenPort: 0,
      pairingHost: '127.0.0.1',
      approveClient: () => false,
    });
    assert.equal(second.harnessId, firstHarnessId);
  } finally {
    await first?.close().catch(() => undefined);
    await second?.close().catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }
});
