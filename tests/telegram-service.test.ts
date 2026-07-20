import test from 'node:test';
import assert from 'node:assert/strict';
import { TelegramService } from '../src/services/TelegramService.js';

test('telegram route operations retry transient socket failures', async () => {
  const service = new TelegramService() as any;
  service.delay = async () => undefined;

  let attempts = 0;
  const result = await service.runTelegramRouteOperation(
    { chatId: '123', transport: 'telegram' },
    'sendMessage',
    async () => {
      attempts += 1;
      if (attempts < 3) {
        const error = new Error('request failed: socket hang up') as Error & { code?: string; cause?: unknown };
        error.code = 'ECONNRESET';
        error.cause = { code: 'UND_ERR_SOCKET' };
        throw error;
      }
      return 'ok';
    },
  );

  assert.equal(result, 'ok');
  assert.equal(attempts, 3);
});

test('telegram transient classifier treats bare terminated errors as retryable', () => {
  const service = new TelegramService() as any;
  assert.equal(service.isTransientTelegramError(new TypeError('terminated')), true);
});
