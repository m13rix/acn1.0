import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveMethodName, deriveNamespace, toSafeIdentifier, toSafeSlug } from '../naming.js';

test('transliterates Cyrillic names into safe namespaces', () => {
  assert.equal(deriveNamespace('СДАМ ГИА'), 'sdamGia');
  assert.equal(toSafeSlug('СДАМ ГИА'), 'sdam-gia');
});

test('strips duplicated prefixes and resolves collisions', () => {
  assert.equal(deriveMethodName('sdamgia_get_problem', 'sdamgia'), 'getProblem');
  assert.equal(deriveMethodName('get_problem', 'sdamgia', ['getProblem']), 'getProblem2');
  assert.equal(toSafeIdentifier('class'), 'classTool');
});
