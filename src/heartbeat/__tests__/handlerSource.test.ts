import test from 'node:test';
import assert from 'node:assert/strict';
import { serializeHandlerSource } from '../handlerSource.js';

test('serializes plain async handlers', () => {
  const source = serializeHandlerSource(async (event: any, ctx: any) => {
    console.log(event.payload?.text);
    await ctx.unbind();
  }, ['heartbeat']);

  assert.match(source, /async/);
  assert.match(source, /ctx\.unbind/);
});

test('rejects closure-dependent handlers', () => {
  const prefix = 'note:';

  assert.throws(() => serializeHandlerSource(async () => {
    console.log(prefix);
  }, ['heartbeat']), /closes over unsupported identifiers: prefix/);
});
