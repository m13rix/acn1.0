import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildNoteFingerprint,
  classifyNotePage,
  hasFingerprintChanged,
  hasMeaningfulContentChange,
  noteModifiedAt,
  noteText,
  shouldIgnoreSystemNote,
} from './index.ts';

test('classifyNotePage allows meaningful note text without trailing punctuation', () => {
  const result = classifyNotePage({ title: 'Homework' }, 'дз русский упражнение 262');
  assert.equal(result.emit, true);
});

test('classifyNotePage ignores tiny untitled placeholder pages', () => {
  const result = classifyNotePage({ title: 'Untitled page', id: 'x' }, 'hi');
  assert.equal(result.emit, false);
  assert.match(result.reason, /placeholder/i);
});

test('noteText formats checklist notes into plain text lines', () => {
  const result = noteText({
    id: '1',
    title: 'Checklist',
    logicalTitle: 'Checklist',
    rawTitle: 'Checklist',
    kind: 'list',
    owner: 'user',
    archived: false,
    trashed: false,
    pinned: false,
    createdAt: null,
    updatedAt: null,
    preview: '',
    text: '',
    items: [
      { id: 'a', text: 'milk', checked: false, sort: null },
      { id: 'b', text: 'bread', checked: true, sort: null },
    ],
  });

  assert.equal(result, '[ ] milk\n[x] bread');
});

test('shouldIgnoreSystemNote filters Telos-owned notes', () => {
  assert.equal(shouldIgnoreSystemNote({ owner: 'system' }), true);
  assert.equal(shouldIgnoreSystemNote({ owner: 'user' }), false);
  assert.equal(shouldIgnoreSystemNote({ owner: 'owner' }), false);
});

test('noteModifiedAt prefers updatedAt and falls back to createdAt', () => {
  assert.equal(noteModifiedAt({ updatedAt: '2026-04-07T10:00:00Z', createdAt: '2026-04-06T10:00:00Z' }), '2026-04-07T10:00:00Z');
  assert.equal(noteModifiedAt({ updatedAt: null, createdAt: '2026-04-06T10:00:00Z' }), '2026-04-06T10:00:00Z');
  assert.equal(noteModifiedAt({ updatedAt: null, createdAt: null }), null);
});

test('hasFingerprintChanged detects content and timestamp changes', () => {
  const previous = { modifiedAt: '2026-04-07T10:00:00Z', contentHash: 'abc' };

  assert.equal(hasFingerprintChanged(previous, { modifiedAt: '2026-04-07T10:00:00Z', contentHash: 'abc' }), false);
  assert.equal(hasFingerprintChanged(previous, { modifiedAt: '2026-04-07T10:00:01Z', contentHash: 'abc' }), true);
  assert.equal(hasFingerprintChanged(previous, { modifiedAt: '2026-04-07T10:00:00Z', contentHash: 'def' }), true);
});

test('hasMeaningfulContentChange ignores timestamp-only note updates', () => {
  const previous = { modifiedAt: '2026-04-07T10:00:00Z', contentHash: 'abc' };

  assert.equal(hasMeaningfulContentChange(previous, { modifiedAt: '2026-04-07T10:00:01Z', contentHash: 'abc' }), false);
  assert.equal(hasMeaningfulContentChange(previous, { modifiedAt: '2026-04-07T10:00:00Z', contentHash: 'def' }), true);
  assert.equal(hasMeaningfulContentChange(undefined, { modifiedAt: '2026-04-07T10:00:00Z', contentHash: 'abc' }), true);
});

test('buildNoteFingerprint normalizes modifiedAt and hashes normalized text', () => {
  const fingerprint = buildNoteFingerprint({
    id: '1',
    title: 'Checklist',
    logicalTitle: 'Checklist',
    rawTitle: 'Checklist',
    kind: 'list',
    owner: 'user',
    archived: false,
    trashed: false,
    pinned: false,
    createdAt: '2026-04-06T10:00:00Z',
    updatedAt: '2026-04-07T10:00:00Z',
    preview: '',
    text: '',
    items: [
      { id: 'a', text: 'milk', checked: false, sort: null },
      { id: 'b', text: 'bread', checked: true, sort: null },
    ],
  }, '[ ] milk\n[x] bread');

  assert.equal(fingerprint.modifiedAt, '2026-04-07T10:00:00Z');
  assert.equal(typeof fingerprint.contentHash, 'string');
  assert.notEqual(fingerprint.contentHash.length, 0);
});
