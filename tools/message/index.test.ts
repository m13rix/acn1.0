import test from 'node:test';
import assert from 'node:assert/strict';

import { __internals } from './index.ts';

test('getBridgeRecipient prefers interface route and includes chat id when available', () => {
  const previousRoute = process.env.TELOS_INTERFACE_ROUTE;
  const previousChat = process.env.TELOS_CHAT_ID;

  process.env.TELOS_INTERFACE_ROUTE = 'route-123';
  process.env.TELOS_CHAT_ID = 'chat-456';

  const recipient = __internals.getBridgeRecipient(null);

  assert.deepEqual(recipient, {
    routeId: 'route-123',
    chatId: 'chat-456',
  });

  process.env.TELOS_INTERFACE_ROUTE = previousRoute;
  process.env.TELOS_CHAT_ID = previousChat;
});

test('getBridgeRecipient falls back to chat id when route id is absent', () => {
  const previousRoute = process.env.TELOS_INTERFACE_ROUTE;
  const previousChat = process.env.TELOS_CHAT_ID;

  delete process.env.TELOS_INTERFACE_ROUTE;
  process.env.TELOS_CHAT_ID = 'chat-456';

  const recipient = __internals.getBridgeRecipient(null);

  assert.deepEqual(recipient, {
    routeId: undefined,
    chatId: 'chat-456',
  });

  process.env.TELOS_INTERFACE_ROUTE = previousRoute;
  process.env.TELOS_CHAT_ID = previousChat;
});

test('getBridgeRecipient can use owner fallback when chat id env is absent', () => {
  const previousRoute = process.env.TELOS_INTERFACE_ROUTE;
  const previousChat = process.env.TELOS_CHAT_ID;

  delete process.env.TELOS_INTERFACE_ROUTE;
  delete process.env.TELOS_CHAT_ID;

  const recipient = __internals.getBridgeRecipient('owner-789');

  assert.deepEqual(recipient, {
    routeId: undefined,
    chatId: 'owner-789',
  });

  process.env.TELOS_INTERFACE_ROUTE = previousRoute;
  process.env.TELOS_CHAT_ID = previousChat;
});

test('getBridgeRecipient ignores reserved heartbeat pseudo-route ids', () => {
  const previousRoute = process.env.TELOS_INTERFACE_ROUTE;
  const previousChat = process.env.TELOS_CHAT_ID;

  process.env.TELOS_INTERFACE_ROUTE = 'HEARTBEAT_ROUTE';
  process.env.TELOS_CHAT_ID = 'HEARTBEAT_ROUTE';

  const recipient = __internals.getBridgeRecipient('owner-789');

  assert.deepEqual(recipient, {
    routeId: undefined,
    chatId: 'owner-789',
  });

  process.env.TELOS_INTERFACE_ROUTE = previousRoute;
  process.env.TELOS_CHAT_ID = previousChat;
});

test('getBridgeRecipient without fallback returns empty recipient outside managed context', () => {
  const previousRoute = process.env.TELOS_INTERFACE_ROUTE;
  const previousChat = process.env.TELOS_CHAT_ID;

  delete process.env.TELOS_INTERFACE_ROUTE;
  delete process.env.TELOS_CHAT_ID;

  const recipient = __internals.getBridgeRecipient();

  assert.deepEqual(recipient, {
    routeId: undefined,
    chatId: undefined,
  });

  process.env.TELOS_INTERFACE_ROUTE = previousRoute;
  process.env.TELOS_CHAT_ID = previousChat;
});

test('getMessageApiContext falls back to discovered local api with owner chat id', () => {
  const previousRoute = process.env.TELOS_INTERFACE_ROUTE;
  const previousChat = process.env.TELOS_CHAT_ID;
  const previousApi = process.env.TELOS_API_URL;
  const previousInterfaceApi = process.env.TELOS_INTERFACE_API_URL;
  const previousInternalPort = process.env.TELOS_INTERNAL_API_PORT;

  delete process.env.TELOS_INTERFACE_ROUTE;
  delete process.env.TELOS_CHAT_ID;
  delete process.env.TELOS_API_URL;
  delete process.env.TELOS_INTERFACE_API_URL;
  process.env.TELOS_INTERNAL_API_PORT = '11342';

  const context = __internals.getMessageApiContext();

  assert.equal(context.explicitApiUrl, undefined);
  assert.equal(context.apiUrl, 'http://localhost:11342');
  assert.deepEqual(context.recipient, { routeId: undefined, chatId: '5033134196' });

  process.env.TELOS_INTERFACE_ROUTE = previousRoute;
  process.env.TELOS_CHAT_ID = previousChat;
  process.env.TELOS_API_URL = previousApi;
  process.env.TELOS_INTERFACE_API_URL = previousInterfaceApi;
  process.env.TELOS_INTERNAL_API_PORT = previousInternalPort;
});

test('getMessageApiContext preserves HEARTBEAT_ROUTE for the heartbeat thread api flow', () => {
  const previousRoute = process.env.TELOS_INTERFACE_ROUTE;
  const previousChat = process.env.TELOS_CHAT_ID;
  const previousApi = process.env.TELOS_API_URL;
  const previousInterfaceApi = process.env.TELOS_INTERFACE_API_URL;

  delete process.env.TELOS_INTERFACE_ROUTE;
  process.env.TELOS_CHAT_ID = 'HEARTBEAT_ROUTE';
  process.env.TELOS_API_URL = 'http://localhost:11342';
  delete process.env.TELOS_INTERFACE_API_URL;

  const context = __internals.getMessageApiContext();

  assert.equal(context.explicitApiUrl, 'http://localhost:11342');
  assert.equal(context.apiUrl, 'http://localhost:11342');
  assert.deepEqual(context.recipient, { chatId: 'HEARTBEAT_ROUTE' });
  assert.equal(__internals.shouldFallbackToLegacyFromApi(new Error('fetch failed'), context.explicitApiUrl), false);

  process.env.TELOS_INTERFACE_ROUTE = previousRoute;
  process.env.TELOS_CHAT_ID = previousChat;
  process.env.TELOS_API_URL = previousApi;
  process.env.TELOS_INTERFACE_API_URL = previousInterfaceApi;
});
