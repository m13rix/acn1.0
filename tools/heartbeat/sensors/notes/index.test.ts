import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import {
  buildAttachmentPayload,
  buildNotePayload,
  classifyNotePage,
  fingerprintFromSnapshot,
  fingerprintsEqual,
  hasMeaningfulContentChange,
  hashContent,
  isPreexistingAtStartup,
  isMarkdownPath,
  isTechnicalPath,
  normalizeRelativePath,
} from './index.ts';

const sampleSnapshot = {
  id: 'School/Homework.md',
  name: 'Homework.md',
  relativePath: 'School/Homework.md',
  path: 'E:\\My Drive\\Notes\\Main\\School\\Homework.md',
  extension: '.md',
  mimeType: 'text/markdown',
  isMarkdown: true,
  createdAt: '2026-07-05T10:00:00.000Z',
  modifiedAt: '2026-07-05T10:05:00.000Z',
  birthtimeMs: 1000,
  mtimeMs: 2000,
  size: 42,
  contentHash: hashContent('homework text'),
};

test('classifyNotePage allows meaningful note text without trailing punctuation', () => {
  const result = classifyNotePage({ title: 'Homework' }, 'дз русский упражнение 262');
  assert.equal(result.emit, true);
});

test('classifyNotePage ignores tiny untitled placeholder pages', () => {
  const result = classifyNotePage({ title: 'Untitled page', id: 'x' }, 'hi');
  assert.equal(result.emit, false);
  assert.match(result.reason, /placeholder/i);
});

test('isMarkdownPath detects Obsidian note files', () => {
  assert.equal(isMarkdownPath('note.md'), true);
  assert.equal(isMarkdownPath('note.MD'), true);
  assert.equal(isMarkdownPath('image.png'), false);
});

test('isTechnicalPath ignores Obsidian and sync internals', () => {
  assert.equal(isTechnicalPath('.obsidian/workspace.json'), true);
  assert.equal(isTechnicalPath('folder/.git/config'), true);
  assert.equal(isTechnicalPath('data/tool-output/action-observation-abc.txt'), true);
  assert.equal(isTechnicalPath('exec_12.cts'), true);
  assert.equal(isTechnicalPath('folder/photo.png'), false);
});

test('normalizeRelativePath uses vault-relative slash paths', () => {
  const vault = 'E:\\My Drive\\Notes\\Main';
  const file = path.join(vault, 'Folder', 'Note.md');
  assert.equal(normalizeRelativePath(file, vault), 'Folder/Note.md');
});

test('fingerprints include modified time, size, and content hash', () => {
  const fingerprint = fingerprintFromSnapshot(sampleSnapshot);
  assert.deepEqual(fingerprint, {
    modifiedAtMs: 2000,
    size: 42,
    contentHash: sampleSnapshot.contentHash,
  });
});

test('fingerprintsEqual requires exact stable file metadata', () => {
  const fingerprint = fingerprintFromSnapshot(sampleSnapshot);
  assert.equal(fingerprintsEqual(fingerprint, { ...fingerprint }), true);
  assert.equal(fingerprintsEqual(fingerprint, { ...fingerprint, modifiedAtMs: 3000 }), false);
});

test('hasMeaningfulContentChange ignores timestamp-only updates', () => {
  const previous = fingerprintFromSnapshot(sampleSnapshot);
  assert.equal(hasMeaningfulContentChange(previous, { ...previous, modifiedAtMs: 3000 }), false);
  assert.equal(hasMeaningfulContentChange(previous, { ...previous, contentHash: 'changed' }), true);
  assert.equal(hasMeaningfulContentChange(undefined, previous), true);
});

test('isPreexistingAtStartup recognizes files older than the sensor start grace window', () => {
  assert.equal(isPreexistingAtStartup({
    ...sampleSnapshot,
    birthtimeMs: 1_000,
    mtimeMs: 2_000,
  }, 10_000), true);

  assert.equal(isPreexistingAtStartup({
    ...sampleSnapshot,
    birthtimeMs: 9_500,
    mtimeMs: 9_500,
  }, 10_000), false);
});

test('buildNotePayload includes note name, contents, path, and dates', () => {
  const payload = buildNotePayload(sampleSnapshot, 'homework text');
  assert.deepEqual(payload, {
    id: 'School/Homework.md',
    name: 'Homework.md',
    title: 'Homework',
    path: 'E:\\My Drive\\Notes\\Main\\School\\Homework.md',
    relativePath: 'School/Homework.md',
    contents: 'homework text',
    createdAt: '2026-07-05T10:00:00.000Z',
    modifiedAt: '2026-07-05T10:05:00.000Z',
  });
});

test('buildAttachmentPayload includes attachment mime type and file path', () => {
  const payload = buildAttachmentPayload({
    ...sampleSnapshot,
    id: 'Images/photo.png',
    name: 'photo.png',
    relativePath: 'Images/photo.png',
    path: 'E:\\My Drive\\Notes\\Main\\Images\\photo.png',
    extension: '.png',
    mimeType: 'image/png',
    isMarkdown: false,
    size: 2048,
  });

  assert.equal(payload.name, 'photo.png');
  assert.equal(payload.mimeType, 'image/png');
  assert.equal(payload.path, 'E:\\My Drive\\Notes\\Main\\Images\\photo.png');
  assert.equal(payload.size, 2048);
});
