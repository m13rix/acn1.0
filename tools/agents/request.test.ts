import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeAgentRequest } from './request.ts';

test('normalizeAgentRequest passes through string requests', () => {
  assert.equal(normalizeAgentRequest('hello', 'callSelf'), 'hello');
});

test('normalizeAgentRequest extracts instruction objects', () => {
  assert.equal(
    normalizeAgentRequest({ instruction: 'hello from heartbeat' }, 'callSelf'),
    'hello from heartbeat'
  );
});

test('normalizeAgentRequest returns a clear error for unsupported payloads', () => {
  const result = normalizeAgentRequest({ foo: 'bar' }, 'call');
  assert.match(result, /expects a string or an object/i);
});

test('normalizeAgentRequest supports resume method name in errors', () => {
  const result = normalizeAgentRequest({ foo: 'bar' }, 'resume');
  assert.match(result, /agents\.resume\(request\)/i);
});
