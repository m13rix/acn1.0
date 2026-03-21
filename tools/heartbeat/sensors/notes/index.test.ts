import test from 'node:test';
import assert from 'node:assert/strict';

import { classifyNotePage } from './index.ts';

test('classifyNotePage allows meaningful note text without trailing punctuation', () => {
  const result = classifyNotePage({ title: 'Homework' }, 'дз русский упражнение 262');
  assert.equal(result.emit, true);
});

test('classifyNotePage ignores tiny untitled placeholder pages', () => {
  const result = classifyNotePage({ title: 'Untitled page', id: 'x' }, 'hi');
  assert.equal(result.emit, false);
  assert.match(result.reason, /placeholder/i);
});
