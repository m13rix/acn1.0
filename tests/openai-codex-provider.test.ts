import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { OpenRouterProvider } from '../src/providers/openrouter.js';
import { OpenAICodexProvider } from '../src/providers/openai-codex/index.js';
import { OpenAICodexAuthStore } from '../src/providers/openai-codex/auth/auth-store.js';
import { OAuthOnlyModelSelectedViaApiProviderError } from '../src/providers/openai-codex/errors.js';

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'acn-codex-provider-'));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test('OpenRouterProvider rejects oauth-only codex models', async () => {
  const provider = new OpenRouterProvider('test-key');
  await assert.rejects(
    () => provider.complete([{ role: 'user', content: 'hello' }], { model: 'openai-codex/gpt-5-codex' }),
    OAuthOnlyModelSelectedViaApiProviderError
  );
});

test('OpenAICodexProvider completes using stored OAuth profile', async () => {
  await withTempDir(async (dir) => {
    const authStore = new OpenAICodexAuthStore(dir);
    await authStore.upsertProfile({
      id: 'openai-codex:personal',
      provider: 'openai-codex',
      type: 'oauth-chatgpt',
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      accountId: 'acct_1',
      expiresAt: Date.now() + 60_000,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    let seenBody: any;
    const provider = new OpenAICodexProvider(
      {
        dataDir: dir,
        endpoint: 'https://example.com',
      },
      {
        authStore,
        transport: {
          async requestJson() {
            throw new Error('not used');
          },
          async *stream(opts) {
            seenBody = opts.body;
            yield { type: 'text.delta', delta: 'OK' };
            yield { type: 'done' };
          },
        },
      }
    );

    const response = await provider.complete(
      [{ role: 'user', content: 'Reply with OK only.' }],
      { model: 'openai-codex/gpt-5-codex', stream: false }
    );

    assert.equal(response.content, 'OK');
    assert.equal(seenBody?.stream, true);
  });
});
