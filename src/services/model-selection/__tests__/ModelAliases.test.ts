import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveModelAlias } from '../ModelAliases.js';

test('resolveModelAlias maps provider-qualified source to provider-qualified string target', () => {
  const result = resolveModelAlias({
    aliases: {
      'openai-codex/gpt-5.5': 'openrouter/moonshotai/kimi-k2.6',
    },
  }, 'openai-codex', 'gpt-5.5');

  assert.deepEqual(result, {
    provider: 'openrouter',
    model: 'moonshotai/kimi-k2.6',
    changed: true,
  });
});

test('resolveModelAlias maps bare model source to object target', () => {
  const result = resolveModelAlias({
    aliases: {
      'gpt-5.4-mini': {
        provider: 'openrouter',
        model: 'openai/gpt-oss-20b',
      },
    },
  }, 'openai-codex', 'gpt-5.4-mini');

  assert.equal(result.provider, 'openrouter');
  assert.equal(result.model, 'openai/gpt-oss-20b');
  assert.equal(result.changed, true);
});

test('resolveModelAlias prefers provider-qualified aliases over bare aliases', () => {
  const result = resolveModelAlias({
    aliases: {
      'gpt-5.5': 'openrouter/openai/gpt-oss-20b',
      'openai-codex/gpt-5.5': 'openrouter/moonshotai/kimi-k2.6',
    },
  }, 'openai-codex', 'gpt-5.5');

  assert.equal(result.provider, 'openrouter');
  assert.equal(result.model, 'moonshotai/kimi-k2.6');
});
