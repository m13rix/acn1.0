import { createInterface } from 'node:readline/promises';
import { randomUUID } from 'node:crypto';
import { stdin as input, stdout as output } from 'node:process';
import { actionContext } from '../../../core/ActionContext.js';
import type { ProviderAuthChallenge, ProviderAuthCompletion, ProviderAuthStatus } from '../../../types/index.js';
import { OPENAI_CODEX_MODELS } from '../models.js';
import { OAuthStateMismatchError, SubscriptionAuthRequiredError, TokenExchangeFailedError } from '../errors.js';
import { OpenAICodexAuthStore } from './auth-store.js';
import type { LoginSessionRecord, OAuthProfile } from './auth-types.js';
import { createPkcePair, randomState } from './pkce.js';
import { parseRedirectUrl } from './manual-paste.js';
import { extractAccountId, parseJwtClaims } from './token-claims.js';

export interface TokenResponse {
  access_token: string;
  refresh_token: string;
  id_token?: string;
  expires_in?: number;
  scope?: string;
}

const DEFAULT_SCOPES = ['openid', 'profile', 'email', 'offline_access', 'api.connectors.read', 'api.connectors.invoke'];
const DEFAULT_ORIGINATOR = 'codex_cli_rs';

function normalizeRedirectUri(redirectUri: string): string {
  try {
    const url = new URL(redirectUri);
    if (url.hostname === '127.0.0.1') {
      url.hostname = 'localhost';
    }
    return url.toString();
  } catch {
    return redirectUri;
  }
}

export function buildAuthorizeUrl(input: {
  authorizeUrl: string;
  clientId: string;
  redirectUri: string;
  challenge: string;
  state: string;
  scopes?: string[];
  originator?: string;
  allowedWorkspaceId?: string;
}): string {
  const redirectUri = normalizeRedirectUri(input.redirectUri);
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: input.clientId,
    redirect_uri: redirectUri,
    code_challenge: input.challenge,
    code_challenge_method: 'S256',
    state: input.state,
    scope: (input.scopes || DEFAULT_SCOPES).join(' '),
    id_token_add_organizations: 'true',
    codex_cli_simplified_flow: 'true',
    originator: input.originator || DEFAULT_ORIGINATOR,
  });

  if (input.allowedWorkspaceId) {
    params.set('allowed_workspace_id', input.allowedWorkspaceId);
  }

  return `${input.authorizeUrl}?${params.toString()}`;
}

export async function exchangeCodeForTokens(input: {
  tokenUrl: string;
  clientId: string;
  code: string;
  redirectUri: string;
  codeVerifier: string;
  fetchImpl?: typeof fetch;
}): Promise<TokenResponse> {
  const fetchImpl = input.fetchImpl || fetch;
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: input.code,
    redirect_uri: input.redirectUri,
    client_id: input.clientId,
    code_verifier: input.codeVerifier,
  });

  const response = await fetchImpl(input.tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new TokenExchangeFailedError(`Token exchange failed: ${response.status} ${text}`);
  }

  return response.json() as Promise<TokenResponse>;
}

export async function beginLoginSession(input: {
  authStore: OpenAICodexAuthStore;
  authorizeUrl: string;
  tokenUrl: string;
  clientId: string;
  redirectUri: string;
  scopes?: string[];
  originator?: string;
  allowedWorkspaceId?: string;
}): Promise<{ challenge: ProviderAuthChallenge; session: LoginSessionRecord }> {
  const loginId = randomUUID();
  const pkce = createPkcePair();
  const state = randomState();
  const expiresAt = Date.now() + 10 * 60 * 1000;
  const scopes = input.scopes || DEFAULT_SCOPES;
  const redirectUri = normalizeRedirectUri(input.redirectUri);
  const authUrl = buildAuthorizeUrl({
    authorizeUrl: input.authorizeUrl,
    clientId: input.clientId,
    redirectUri,
    challenge: pkce.challenge,
    state,
    scopes,
    originator: input.originator,
    allowedWorkspaceId: input.allowedWorkspaceId,
  });

  const session: LoginSessionRecord = {
    id: loginId,
    state,
    codeVerifier: pkce.verifier,
    codeChallenge: pkce.challenge,
    authorizeUrl: input.authorizeUrl,
    tokenUrl: input.tokenUrl,
    redirectUri,
    clientId: input.clientId,
    scopes,
    createdAt: Date.now(),
    expiresAt,
  };

  await input.authStore.createLoginSession(session);

  return {
    session,
    challenge: {
      provider: 'openai-codex',
      loginId,
      authUrl,
      redirectUri,
      expiresAt,
      manualMessage: [
        'Open the ChatGPT sign-in link.',
        'If automatic callback fails, copy the full final redirect URL and paste it back here.',
        `Expected redirect origin: ${redirectUri}`,
      ].join(' '),
    },
  };
}

export async function completeLoginSession(input: {
  authStore: OpenAICodexAuthStore;
  payload: ProviderAuthCompletion;
  fetchImpl?: typeof fetch;
  probeProfile: (profile: OAuthProfile) => Promise<void>;
}): Promise<ProviderAuthStatus> {
  const session = await input.authStore.getLoginSession(input.payload.loginId);
  if (!session) {
    throw new SubscriptionAuthRequiredError('Login session was not found or already expired.');
  }

  const callback = normalizeCompletionPayload(input.payload);
  if (callback.state !== session.state) {
    throw new OAuthStateMismatchError();
  }

  const tokens = await exchangeCodeForTokens({
    tokenUrl: session.tokenUrl,
    clientId: session.clientId,
    code: callback.code,
    redirectUri: session.redirectUri,
    codeVerifier: session.codeVerifier,
    fetchImpl: input.fetchImpl,
  });

  const claims = parseJwtClaims(tokens.id_token) ?? parseJwtClaims(tokens.access_token);
  const accountId = extractAccountId(claims);
  const email = typeof claims?.email === 'string' ? claims.email : undefined;
  const displayName = typeof claims?.name === 'string' ? claims.name : undefined;
  const now = Date.now();
  const profile: OAuthProfile = {
    id: `openai-codex:${email ?? accountId ?? randomUUID()}`,
    provider: 'openai-codex',
    type: 'oauth-chatgpt',
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    idToken: tokens.id_token,
    expiresAt: now + (tokens.expires_in ?? 3600) * 1000,
    accountId,
    email,
    displayName,
    createdAt: now,
    updatedAt: now,
    scopes: tokens.scope ? tokens.scope.split(/\s+/).filter(Boolean) : session.scopes,
    meta: {
      source: input.payload.redirectUrl ? 'manual-paste' : 'browser-pkce',
      clientVariant: 'telos-openai-codex',
    },
  };

  await input.probeProfile(profile);
  await input.authStore.upsertProfile(profile);
  await input.authStore.deleteLoginSession(session.id);

  return {
    provider: 'openai-codex',
    authenticated: true,
    activeProfileId: profile.id,
    accountLabel: profile.email ?? profile.accountId ?? profile.displayName,
    expiresAt: profile.expiresAt,
    modelsAvailable: OPENAI_CODEX_MODELS.map(item => item.ref),
  };
}

function normalizeCompletionPayload(payload: ProviderAuthCompletion): { code: string; state: string } {
  if (payload.redirectUrl) {
    return parseRedirectUrl(payload.redirectUrl);
  }

  if (payload.callbackCode && payload.callbackState) {
    return { code: payload.callbackCode, state: payload.callbackState };
  }

  throw new SubscriptionAuthRequiredError('Login completion requires either a redirect URL or callback code/state.');
}

export async function promptConsoleForRedirectUrl(challenge: ProviderAuthChallenge): Promise<string> {
  const rl = createInterface({ input, output });
  try {
    return await rl.question(`Paste the full redirect URL for ${challenge.provider}: `);
  } finally {
    rl.close();
  }
}

async function sendApiRequest<T = unknown>(apiUrl: string, path: string, payload: Record<string, unknown>): Promise<T> {
  const response = await fetch(`${apiUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Auth UI request failed: ${response.status} ${text}`);
  }

  return response.json() as Promise<T>;
}

export async function notifyTelegramAboutLogin(challenge: ProviderAuthChallenge): Promise<void> {
  const env = actionContext.getStore()?.env;
  const chatId = actionContext.getStore()?.chatId;
  const apiUrl = env?.TELOS_API_URL;
  if (!apiUrl || !chatId) {
    throw new Error('Telegram auth notification is unavailable outside Telegram execution context.');
  }

  await sendApiRequest(apiUrl, '/api/sendAuthLink', {
    chatId,
    text: [
      'OpenAI ChatGPT sign-in is required for this model.',
      'Open the link below on the same machine if possible.',
      challenge.manualMessage,
    ].join('\n\n'),
    url: challenge.authUrl,
    label: 'Connect OpenAI',
  });
}

export async function askTelegramForRedirectUrl(challenge: ProviderAuthChallenge): Promise<string> {
  const env = actionContext.getStore()?.env;
  const chatId = actionContext.getStore()?.chatId;
  const apiUrl = env?.TELOS_API_URL;
  if (!apiUrl || !chatId) {
    throw new Error('Telegram auth prompt is unavailable outside Telegram execution context.');
  }

  const result = await sendApiRequest<{ questionId?: string; status?: string; response?: string; error?: string }>(apiUrl, '/api/ask', {
    chatId,
    question: [
      'After signing in, paste the full redirect URL here.',
      `Auth link: ${challenge.authUrl}`,
      `Redirect URI: ${challenge.redirectUri}`,
    ].join('\n\n'),
  });

  if (result.status === 'answered' && result.response) {
    return result.response;
  }

  const questionId = result.questionId;
  if (!questionId) {
    throw new Error(result.error || 'Auth prompt did not receive either a direct answer or questionId.');
  }
  for (;;) {
    await new Promise(resolve => setTimeout(resolve, 2000));
    const pollResponse = await fetch(`${apiUrl}/api/ask/poll?questionId=${encodeURIComponent(questionId)}`);
    if (!pollResponse.ok) {
      const text = await pollResponse.text().catch(() => '');
      throw new Error(`Telegram auth poll failed: ${pollResponse.status} ${text}`);
    }
    const payload = await pollResponse.json() as { status: string; response?: string };
    if (payload.status === 'answered' && payload.response) {
      return payload.response;
    }
  }
}

export function isTelegramAuthContext(): boolean {
  const store = actionContext.getStore();
  return Boolean(store?.chatId && store?.env?.TELOS_API_URL);
}
