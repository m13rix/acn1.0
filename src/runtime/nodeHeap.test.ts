import test from 'node:test';
import assert from 'node:assert/strict';

import {
  hasOldSpaceArg,
  parseOldSpaceMb,
  resolveMainOldSpaceMb,
} from './nodeHeap.js';

test('parseOldSpaceMb accepts positive integer-like values', () => {
  assert.equal(parseOldSpaceMb('32768'), 32768);
  assert.equal(parseOldSpaceMb('4096.9'), 4096);
});

test('parseOldSpaceMb falls back for missing or invalid values', () => {
  assert.equal(parseOldSpaceMb('', 1234), 1234);
  assert.equal(parseOldSpaceMb('nope', 1234), 1234);
  assert.equal(parseOldSpaceMb('-1', 1234), 1234);
});

test('resolveMainOldSpaceMb honors action worker env as compatibility fallback', () => {
  assert.equal(resolveMainOldSpaceMb({ TELOS_ACTION_WORKER_OLD_SPACE_MB: '32768' }), 32768);
  assert.equal(resolveMainOldSpaceMb({ TELOS_NODE_MAX_OLD_SPACE_MB: '16384', TELOS_ACTION_WORKER_OLD_SPACE_MB: '32768' }), 16384);
  assert.equal(resolveMainOldSpaceMb({ TELOS_MAIN_OLD_SPACE_MB: '24576', TELOS_NODE_MAX_OLD_SPACE_MB: '16384' }), 24576);
});

test('hasOldSpaceArg detects existing Node heap flags', () => {
  assert.equal(hasOldSpaceArg(['--max-old-space-size=8192']), true);
  assert.equal(hasOldSpaceArg(['--inspect', '--max-old-space-size', '8192']), true);
  assert.equal(hasOldSpaceArg(['--inspect']), false);
});
