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

test('durable Telegram interactions collect multi-select answers transactionally', async () => {
  const service = new TelegramService() as any;
  const published: Array<Record<string, unknown>> = [];
  service.threadService = {
    answerInteraction: (input: Record<string, unknown>) => {
      published.push(input);
      return { accepted: true };
    },
  };
  service.sendMessageToRoute = async () => undefined;
  service.threadInteractions.set('route', {
    interactionId: 'interaction-1',
    questions: [{
      id: 'features',
      prompt: 'Choose features',
      type: 'multi-select',
      options: [{ id: 'files', label: 'Files' }, { id: 'audio', label: 'Audio' }],
    }],
    index: 0,
    answers: {},
    selected: new Set(),
  });
  const context = { answerCbQuery: async () => undefined };
  const route = { chatId: '123', transport: 'telegram' };

  assert.equal(await service.handleDurableThreadCallback(context, 'route', route, 'ti:0'), true);
  assert.equal(await service.handleDurableThreadCallback(context, 'route', route, 'ti:1'), true);
  assert.equal(await service.handleDurableThreadCallback(context, 'route', route, 'tidone'), true);
  assert.deepEqual(published, [{
    interactionId: 'interaction-1',
    answers: { features: ['files', 'audio'] },
  }]);
});

test('durable Telegram uploads choose a non-conflicting renamed destination', async () => {
  const service = new TelegramService() as any;
  const occupied = new Set(['report.txt', 'report (2).txt']);
  service.threadService = {
    readFile: async (_threadId: string, fileName: string) => {
      if (occupied.has(fileName)) return { revision: 'occupied' };
      throw new Error('missing');
    },
  };

  assert.equal(await service.availableUploadName('thread-1', 'report.txt'), 'report (3).txt');
  assert.equal(await service.availableUploadName('thread-1', '..\\unsafe?.txt'), 'unsafe_.txt');
});
