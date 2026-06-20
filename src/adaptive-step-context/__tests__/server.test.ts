import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

import { ensureAdaptiveStepContextServer } from '../server.js';

test('adaptive debug server does not throw when configured port is occupied', async () => {
  const blocker = createServer((_req, res) => {
    res.end('occupied');
  });

  await new Promise<void>((resolve) => {
    blocker.listen(0, '127.0.0.1', resolve);
  });

  const address = blocker.address();
  assert.ok(address && typeof address === 'object');

  try {
    const url = await ensureAdaptiveStepContextServer({
      port: address.port,
      openBrowser: false,
      sessionId: 'session-for-occupied-port-test',
    });

    assert.equal(url, `http://localhost:${address.port}/?session=session-for-occupied-port-test`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      blocker.close((error) => error ? reject(error) : resolve());
    });
  }
});
