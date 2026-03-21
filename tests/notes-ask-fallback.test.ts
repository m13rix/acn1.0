import test from 'node:test';
import assert from 'node:assert/strict';
import { __internals } from '../tools/heartbeat/sensors/notes/index.js';

test('notes fallback classifier detects obvious homework notes', () => {
  const result = __internals.fallbackHomeworkClassification(`
Определи, является ли эта заметка домашним заданием.
Название заметки: Домашнее задание по истории
Текст заметки: Домашнее задание по истории: параграф 25, сделать конспект и учить.
`);

  assert.deepEqual(result, {
    shouldHandle: true,
    reason: 'Fallback notes heuristic matched multiple school/homework signals in the note text.',
  });
});

test('notes fallback classifier rejects non-study notes', () => {
  const result = __internals.fallbackHomeworkClassification(`
Название заметки: Покупки
Текст заметки: хлеб, молоко, сыр, напомнить купить батарейки
`);

  assert.deepEqual(result, {
    shouldHandle: false,
    reason: 'Fallback notes heuristic did not find enough school/homework signals in the note text.',
  });
});
