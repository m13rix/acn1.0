import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { createPkcePair } from '../src/providers/openai-codex/auth/pkce.js';
import { buildAuthorizeUrl } from '../src/providers/openai-codex/auth/login.js';
import { parseRedirectUrl } from '../src/providers/openai-codex/auth/manual-paste.js';
import { OpenAICodexAuthStore } from '../src/providers/openai-codex/auth/auth-store.js';
import { extractAccountId, parseJwtClaims } from '../src/providers/openai-codex/auth/token-claims.js';
import { getValidProfile } from '../src/providers/openai-codex/auth/refresh.js';
import { resolveOpenAICodexModel } from '../src/providers/openai-codex/models.js';

function createJwt(payload: Record<string, unknown>): string {
  const encode = (value: string) => Buffer.from(value).toString('base64url');
  return `${encode(JSON.stringify({ alg: 'none', typ: 'JWT' }))}.${encode(JSON.stringify(payload))}.signature`;
}

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'acn-codex-'));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test('pkce pair uses distinct verifier and challenge', () => {
  const pair = createPkcePair();
  assert.ok(pair.verifier.length > 20);
  assert.ok(pair.challenge.length > 20);
  assert.notEqual(pair.verifier, pair.challenge);
});

test('parseRedirectUrl extracts code and state from pasted redirect', () => {
  const parsed = parseRedirectUrl('Done: http://127.0.0.1:1455/auth/callback?code=abc123&state=xyz789');
  assert.deepEqual(parsed, { code: 'abc123', state: 'xyz789' });
});

test('parseJwtClaims extracts email and account id', () => {
  const token = createJwt({
    email: 'max@example.com',
    chatgpt_account_id: 'acct_123',
  });
  const claims = parseJwtClaims(token);
  assert.equal(claims?.email, 'max@example.com');
  assert.equal(extractAccountId(claims), 'acct_123');
});

test('parseJwtClaims reads nested OpenAI auth claims and preserves email', () => {
  const token = createJwt({
    email: 'max@example.com',
    'https://api.openai.com/auth': {
      chatgpt_account_id: 'acct_nested',
      organizations: [{ id: 'org_nested' }],
    },
  });

  const claims = parseJwtClaims(token);
  assert.equal(claims?.email, 'max@example.com');
  assert.equal(extractAccountId(claims), 'acct_nested');
});

test('buildAuthorizeUrl matches Codex-style OAuth parameters', () => {
  const url = new URL(buildAuthorizeUrl({
    authorizeUrl: 'https://auth.openai.com/oauth/authorize',
    clientId: 'app_test',
    redirectUri: 'http://127.0.0.1:1455/auth/callback',
    challenge: 'challenge123',
    state: 'state123',
  }));

  assert.equal(url.searchParams.get('client_id'), 'app_test');
  assert.equal(url.searchParams.get('redirect_uri'), 'http://localhost:1455/auth/callback');
  assert.equal(url.searchParams.get('code_challenge'), 'challenge123');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('state'), 'state123');
  assert.equal(url.searchParams.get('id_token_add_organizations'), 'true');
  assert.equal(url.searchParams.get('codex_cli_simplified_flow'), 'true');
  assert.equal(url.searchParams.get('originator'), 'codex_cli_rs');
  assert.match(url.searchParams.get('scope') || '', /api\.connectors\.read/);
  assert.match(url.searchParams.get('scope') || '', /api\.connectors\.invoke/);
});

test('resolveOpenAICodexModel keeps legacy gpt-5.4 alias working', () => {
  const model = resolveOpenAICodexModel('openai-codex/gpt-5.4');
  assert.equal(model.publicId, 'gpt-5-codex');
  assert.equal(model.backendId, 'gpt-5-codex');
});

test('auth store keeps active profile and login sessions', async () => {
  await withTempDir(async (dir) => {
    const store = new OpenAICodexAuthStore(dir);
    await store.upsertProfile({
      id: 'openai-codex:personal',
      provider: 'openai-codex',
      type: 'oauth-chatgpt',
      accessToken: 'access',
      refreshToken: 'refresh',
      expiresAt: Date.now() + 60_000,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    const active = await store.getActiveProfile();
    assert.equal(active?.id, 'openai-codex:personal');

    await store.createLoginSession({
      id: 'login-1',
      state: 'state-1',
      codeVerifier: 'verifier',
      codeChallenge: 'challenge',
      authorizeUrl: 'https://auth.example/authorize',
      tokenUrl: 'https://auth.example/token',
      redirectUri: 'http://localhost:1455/auth/callback',
      clientId: 'client',
      scopes: ['openid'],
      createdAt: Date.now(),
      expiresAt: Date.now() + 60_000,
    });

    const session = await store.getLoginSession('login-1');
    assert.equal(session?.state, 'state-1');
  });
});

test('getValidProfile refreshes expired token once under lock', async () => {
  await withTempDir(async (dir) => {
    const store = new OpenAICodexAuthStore(dir);
    await store.upsertProfile({
      id: 'openai-codex:personal',
      provider: 'openai-codex',
      type: 'oauth-chatgpt',
      accessToken: 'old-access',
      refreshToken: 'refresh-token',
      expiresAt: Date.now() - 5_000,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    let refreshCalls = 0;
    const fetchImpl: typeof fetch = async () => {
      refreshCalls += 1;
      return new Response(JSON.stringify({
        access_token: 'new-access',
        refresh_token: 'new-refresh',
        expires_in: 3600,
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };

    const [first, second] = await Promise.all([
      getValidProfile({ authStore: store, tokenUrl: 'https://auth.example/token', clientId: 'client', fetchImpl }),
      getValidProfile({ authStore: store, tokenUrl: 'https://auth.example/token', clientId: 'client', fetchImpl }),
    ]);

    assert.equal(refreshCalls, 1);
    assert.equal(first?.accessToken, 'new-access');
    assert.equal(second?.accessToken, 'new-access');
  });
});
