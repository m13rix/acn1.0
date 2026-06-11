import assert from 'node:assert/strict';
import test from 'node:test';
import { ask } from '../tools/message/index.ts';

const ORIGINAL_FETCH = globalThis.fetch;

function setEnv(name: string, value: string | undefined): string | undefined {
  const previous = process.env[name];
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
  return previous;
}

test('message.ask supports async question polling via the API bridge', async () => {
  const previousApiUrl = setEnv('TELOS_INTERFACE_API_URL', 'http://example.test');
  const previousRoute = setEnv('TELOS_INTERFACE_ROUTE', 'route-1');
  const previousPollInterval = setEnv('TELOS_MESSAGE_ASK_POLL_INTERVAL_MS', '1');
  const previousAskTimeout = setEnv('TELOS_MESSAGE_ASK_TIMEOUT_MS', '500');

  let pollCount = 0;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);

    if (url.endsWith('/api/ask')) {
      return new Response(JSON.stringify({ questionId: 'q_1' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }

    if (url.includes('/api/ask/poll?questionId=q_1')) {
      pollCount += 1;
      return new Response(JSON.stringify(
        pollCount >= 2
          ? { status: 'answered', response: 'final answer' }
          : { status: 'waiting' }
      ), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }

    throw new Error(`Unexpected URL: ${url}`);
  }) as typeof fetch;

  try {
    const answer = await ask('Question?');
    assert.equal(answer, 'final answer');
    assert.equal(pollCount, 2);
  } finally {
    globalThis.fetch = ORIGINAL_FETCH;
    setEnv('TELOS_INTERFACE_API_URL', previousApiUrl);
    setEnv('TELOS_INTERFACE_ROUTE', previousRoute);
    setEnv('TELOS_MESSAGE_ASK_POLL_INTERVAL_MS', previousPollInterval);
    setEnv('TELOS_MESSAGE_ASK_TIMEOUT_MS', previousAskTimeout);
  }
});

test('message.ask retries transient API failures before succeeding', async () => {
  const previousApiUrl = setEnv('TELOS_INTERFACE_API_URL', 'http://example.test');
  const previousRoute = setEnv('TELOS_INTERFACE_ROUTE', 'route-2');

  let attempts = 0;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (!url.endsWith('/api/ask')) {
      throw new Error(`Unexpected URL: ${url}`);
    }

    attempts += 1;
    if (attempts === 1) {
      return new Response(JSON.stringify({ error: 'rate limit' }), {
        status: 429,
        headers: {
          'content-type': 'application/json',
          'retry-after': '0.001',
        },
      });
    }

    return new Response(JSON.stringify({ status: 'answered', response: 'ok after retry' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;

  try {
    const answer = await ask('Retry?');
    assert.equal(answer, 'ok after retry');
    assert.equal(attempts, 2);
  } finally {
    globalThis.fetch = ORIGINAL_FETCH;
    setEnv('TELOS_INTERFACE_API_URL', previousApiUrl);
    setEnv('TELOS_INTERFACE_ROUTE', previousRoute);
  }
});

test('message.ask keeps retrying API bridge requests until they succeed', async () => {
  const previousApiUrl = setEnv('TELOS_INTERFACE_API_URL', 'http://example.test');
  const previousRoute = setEnv('TELOS_INTERFACE_ROUTE', 'route-3');

  let attempts = 0;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (!url.endsWith('/api/ask')) {
      throw new Error(`Unexpected URL: ${url}`);
    }

    attempts += 1;
    if (attempts <= 6) {
      throw new Error('Timed out after 60000ms');
    }

    return new Response(JSON.stringify({ status: 'answered', response: 'eventual success' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;

  try {
    const answer = await ask('Keep waiting?');
    assert.equal(answer, 'eventual success');
    assert.equal(attempts, 7);
  } finally {
    globalThis.fetch = ORIGINAL_FETCH;
    setEnv('TELOS_INTERFACE_API_URL', previousApiUrl);
    setEnv('TELOS_INTERFACE_ROUTE', previousRoute);
  }
});
