import assert from 'node:assert/strict';
import test from 'node:test';
import { __internals } from '../tools/memory/index.ts';

const { resolveMemoryAddCategory, normalizeMemoryAddInput, normalizeRetrievalHints } = __internals;

test('memory accepts natural object-shaped add calls and retrieval hint aliases', () => {
  const normalized = normalizeMemoryAddInput({
    content: 'Verified router setup rule.',
    agentExclusive: true,
    retrievalHints: 'router setup',
    topics: ['Beeline', 'router setup'],
  });

  assert.equal(normalized.text, 'Verified router setup rule.');
  assert.equal(normalized.options.agentExclusive, true);
  assert.deepEqual(normalizeRetrievalHints(normalized.options), ['router setup', 'Beeline']);
});

test('memory.add scope resolver keeps legacy exclusive as agent scope', () => {
  const originalAgentName = process.env.TELOS_AGENT_NAME;
  try {
    process.env.TELOS_AGENT_NAME = 'Telos-Code';
    assert.equal(resolveMemoryAddCategory({ exclusive: true }), 'Telos-Code');
    assert.equal(resolveMemoryAddCategory({ agentExclusive: true }), 'Telos-Code');
  } finally {
    if (originalAgentName === undefined) {
      delete process.env.TELOS_AGENT_NAME;
    } else {
      process.env.TELOS_AGENT_NAME = originalAgentName;
    }
  }
});

test('memory.add scope resolver uses project category for projectExclusive writes', () => {
  const originalProjectCategory = process.env.TELOS_MEMORY_PROJECT_CATEGORY;
  try {
    process.env.TELOS_MEMORY_PROJECT_CATEGORY = 'project:github.com/m13rix/acn1.0';
    assert.equal(
      resolveMemoryAddCategory({ projectExclusive: true }),
      'project:github.com/m13rix/acn1.0',
    );
  } finally {
    if (originalProjectCategory === undefined) {
      delete process.env.TELOS_MEMORY_PROJECT_CATEGORY;
    } else {
      process.env.TELOS_MEMORY_PROJECT_CATEGORY = originalProjectCategory;
    }
  }
});

test('memory.add scope resolver rejects ambiguous agent and project scope', () => {
  assert.throws(
    () => resolveMemoryAddCategory({ agentExclusive: true, projectExclusive: true }),
    /cannot set both agentExclusive and projectExclusive/,
  );
  assert.throws(
    () => resolveMemoryAddCategory({ exclusive: true, projectExclusive: true }),
    /cannot set both agentExclusive and projectExclusive/,
  );
});
