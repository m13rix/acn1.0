import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveTextLanguageModel } from './model-registry.js';

test('resolveTextLanguageModel registers vllm as an OpenAI-compatible local provider', () => {
  const resolved = resolveTextLanguageModel('vllm', {
    provider: 'vllm',
    model: 'Qwen/Qwen3.6-27B-GPTQ-Int4',
    top_k: 20,
    providerOptions: {
      vllm: {
        chat_template_kwargs: {
          enable_thinking: true,
        },
      },
    },
  });

  assert.ok(resolved.model);
  assert.deepEqual(resolved.providerOptions, {
    vllm: {
      chat_template_kwargs: {
        enable_thinking: true,
      },
      top_k: 20,
    },
  });
});

test('resolveTextLanguageModel resolves opencode as OpenAI-compatible provider', () => {
  const previous = process.env.OPENCODE_API_KEY;
  process.env.OPENCODE_API_KEY = 'test-key';
  try {
    const resolved = resolveTextLanguageModel('opencode', {
      provider: 'opencode',
      model: 'kimi-k2.6',
    });

    assert.ok(resolved.model);
    // OpenAI-compatible providers like opencode don't set providerOptions by default
    // unless caller-supplied providerOptions are provided.
    assert.equal(resolved.providerOptions, undefined);
  } finally {
    if (previous === undefined) {
      delete process.env.OPENCODE_API_KEY;
    } else {
      process.env.OPENCODE_API_KEY = previous;
    }
  }
});
