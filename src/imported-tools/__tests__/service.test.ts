import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeInspectPayload } from '../service.js';

test('normalizeInspectPayload maps MCP quick import fields into package source input', () => {
  const normalized = normalizeInspectPayload({
    kind: 'mcp',
    packageName: 'sdamgia-mcp-server',
    displayName: 'SdamGIA',
  });

  assert.equal(normalized.kind, 'mcp');
  assert.equal(normalized.knowledgeMode, 'both');
  assert.deepEqual(normalized.source, {
    type: 'package',
    value: 'sdamgia-mcp-server',
    displayName: 'SdamGIA',
    command: process.platform === 'win32' ? 'npx.cmd' : 'npx',
    args: ['-y', 'sdamgia-mcp-server'],
  });
  assert.deepEqual(normalized.docs, []);
});

test('normalizeInspectPayload keeps explicit source payloads backward-compatible', () => {
  const normalized = normalizeInspectPayload({
    kind: 'clawhub',
    source: {
      type: 'clawhubSlug',
      value: 'openclaw/gog',
    },
    displayName: 'Gog',
    docs: [{ name: 'notes.md', content: 'Compact docs only.' }],
    knowledgeMode: 'description',
  });

  assert.equal(normalized.knowledgeMode, 'description');
  assert.deepEqual(normalized.source, {
    type: 'clawhubSlug',
    value: 'openclaw/gog',
    displayName: 'Gog',
  });
  assert.deepEqual(normalized.docs, [{ name: 'notes.md', content: 'Compact docs only.' }]);
});
