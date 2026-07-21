import assert from 'node:assert/strict';
import test from 'node:test';
import { toTavilyTimeoutSeconds } from '../tools/search/index.ts';

test('converts the public millisecond timeout contract to Tavily seconds', () => {
  assert.equal(toTavilyTimeoutSeconds(undefined), 60);
  assert.equal(toTavilyTimeoutSeconds(1_000), 1);
  assert.equal(toTavilyTimeoutSeconds(60_000), 60);
  assert.equal(toTavilyTimeoutSeconds(180_000), 120);
});
