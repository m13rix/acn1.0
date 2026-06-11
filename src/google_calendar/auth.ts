import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import open from 'open';
import { startOAuthCallbackServer } from '../providers/openai-codex/auth/callback-server.js';
import { createPkcePair, randomState } from '../providers/openai-codex/auth/pkce.js';
import { parseJwtClaims } from '../providers/openai-codex/auth/token-claims.js';
import {
  GoogleCalendarAuthStore,
  type GoogleCalendarOAuthClientConfig,
  type GoogleCalendarProfile,
} from './auth-store.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const DATA_DIR = path.join(PROJECT_ROOT, 'data', 'google-calendar');

const DEFAULT_REDIRECT_URI = 'http://127.0.0.1:1456/auth/callback';
const DEFAULT_SCOPES = [
  'openid',
  'email',
  'profile',
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/calendar.settings.readonly',
];
const AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const USERINFO_URL = 'https://openidconnect.googleapis.com/v1/userinfo';

interface GoogleTokenResponse {
  access_token: string;
  refresh_token?: string;
  id_token?: string;
  token_type?: string;
  expires_in?: number;
  scope?: string;
}

interface GoogleCalendarAuthStatus {
  authenticated: boolean;
  activeProfileId?: string;
  accountLabel?: string;
  expiresAt?: number;
  scopes?: string[];
  clientConfigured: boolean;
}

let authFlowPromise: Promise<GoogleCalendarProfile> | null = null;

export const googleCalendarAuthStore = new GoogleCalendarAuthStore(DATA_DIR);

function normalizeScopes(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((item) => String(item || '').trim()).filter(Boolean);
  }
  if (typeof value === 'string') {
    return value
      .split(/[\s,]+/)
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return [];
}

function getConfiguredScopes(clientConfig?: GoogleCalendarOAuthClientConfig): string[] {
  const envScopes = normalizeScopes(process.env.GOOGLE_CALENDAR_SCOPES);
  if (envScopes.length > 0) {
    return envScopes;
  }
  if (clientConfig?.scopes?.length) {
    return clientConfig.scopes;
  }
  return [...DEFAULT_SCOPES];
}

function getAuthApiContext(): { apiUrl?: string; routeId?: string } {
  const apiUrl = process.env.TELOS_INTERFACE_API_URL || process.env.TELOS_API_URL;
  const routeId = process.env.TELOS_INTERFACE_ROUTE || process.env.TELOS_CHAT_ID;
  return { apiUrl, routeId };
}

function isTelegramAuthContext(): boolean {
  const context = getAuthApiContext();
  return Boolean(context.apiUrl && context.routeId);
}

async function sendApiRequest<T = unknown>(apiUrl: string, pathName: string, payload: Record<string, unknown>): Promise<T> {
  const response = await fetch(`${apiUrl}${pathName}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Google Calendar auth request failed: ${response.status} ${text}`);
  }

  return response.json() as Promise<T>;
}

async function askTelegram(question: string): Promise<string> {
  const context = getAuthApiContext();
  if (!context.apiUrl || !context.routeId) {
    throw new Error('Telegram auth prompt is unavailable outside Telegram execution context.');
  }

  const result = await sendApiRequest<{ questionId?: string; status?: string; response?: string; error?: string }>(
    context.apiUrl,
    '/api/ask',
    {
      chatId: context.routeId,
      question,
    },
  );

  if (result.status === 'answered' && typeof result.response === 'string') {
    return result.response;
  }

  if (!result.questionId) {
    throw new Error(result.error || 'Google Calendar auth did not receive either a direct answer or questionId.');
  }

  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    const pollResponse = await fetch(`${context.apiUrl}/api/ask/poll?questionId=${encodeURIComponent(result.questionId)}`);
    if (!pollResponse.ok) {
      const text = await pollResponse.text().catch(() => '');
      throw new Error(`Google Calendar auth poll failed: ${pollResponse.status} ${text}`);
    }
    const payload = await pollResponse.json() as { status: string; response?: string };
    if (payload.status === 'answered' && typeof payload.response === 'string') {
      return payload.response;
    }
  }
}

async function askConsole(question: string): Promise<string> {
  const rl = createInterface({ input, output });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}

async function promptForCredential(question: string): Promise<string> {
  if (isTelegramAuthContext()) {
    return askTelegram(question);
  }
  return askConsole(question);
}

async function notifyTelegramAboutLogin(authUrl: string, redirectUri: string): Promise<void> {
  const context = getAuthApiContext();
  if (!context.apiUrl || !context.routeId) {
    return;
  }

  await sendApiRequest(context.apiUrl, '/api/sendAuthLink', {
    chatId: context.routeId,
    text: [
      'Google Calendar authorization is required.',
      'Open the sign-in link below, finish login/consent, then paste the full final redirect URL back here.',
      `Redirect URI: ${redirectUri}`,
    ].join('\n\n'),
    url: authUrl,
    label: 'Connect Google Calendar',
  });
}

function parseRedirectPayload(redirectUrl: string): { code: string; state: string } {
  let url: URL;
  try {
    url = new URL(redirectUrl.trim());
  } catch {
    throw new Error('Expected a full redirect URL from Google, but the input was not a valid URL.');
  }

  const error = url.searchParams.get('error');
  if (error) {
    throw new Error(`Google OAuth failed: ${error}`);
  }

  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  if (!code || !state) {
    throw new Error('Redirect URL did not include both "code" and "state" parameters.');
  }
  return { code, state };
}

function getLoopbackCallbackPort(redirectUri: string): number | null {
  try {
    const url = new URL(redirectUri);
    if ((url.hostname === '127.0.0.1' || url.hostname === 'localhost') && url.pathname === '/auth/callback') {
      const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
      return Number.isFinite(port) ? port : null;
    }
  } catch {
    return null;
  }
  return null;
}

function buildAuthorizeUrl(config: GoogleCalendarOAuthClientConfig, state: string, codeChallenge: string): string {
  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: 'code',
    scope: getConfiguredScopes(config).join(' '),
    access_type: 'offline',
    include_granted_scopes: 'true',
    prompt: 'consent',
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  });
  return `${AUTHORIZE_URL}?${params.toString()}`;
}

async function exchangeCodeForTokens(input: {
  clientId: string;
  clientSecret?: string;
  redirectUri: string;
  code: string;
  codeVerifier: string;
}): Promise<GoogleTokenResponse> {
  const body = new URLSearchParams({
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    code: input.code,
    code_verifier: input.codeVerifier,
    grant_type: 'authorization_code',
  });
  if (input.clientSecret) {
    body.set('client_secret', input.clientSecret);
  }

  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Google token exchange failed: ${response.status} ${text}`);
  }

  return response.json() as Promise<GoogleTokenResponse>;
}

export async function resolveOAuthClientConfig(): Promise<GoogleCalendarOAuthClientConfig> {
  const stored = await googleCalendarAuthStore.readClientConfig();
  const clientId = process.env.GOOGLE_CALENDAR_CLIENT_ID
    || process.env.GOOGLE_CLIENT_ID
    || stored?.clientId;
  const clientSecret = process.env.GOOGLE_CALENDAR_CLIENT_SECRET
    || process.env.GOOGLE_CLIENT_SECRET
    || stored?.clientSecret;
  const redirectUri = process.env.GOOGLE_CALENDAR_REDIRECT_URI
    || stored?.redirectUri
    || DEFAULT_REDIRECT_URI;
  const scopes = getConfiguredScopes(stored);

  let nextClientId = clientId;
  if (!nextClientId) {
    nextClientId = String(await promptForCredential(
      [
        'Google Calendar OAuth client configuration is missing.',
        'Paste the OAuth client ID for a Google project with Calendar API enabled:',
      ].join('\n'),
    ) || '').trim();
  }

  if (!nextClientId) {
    throw new Error('Google Calendar OAuth client ID is required.');
  }

  let nextClientSecret = clientSecret;
  if (nextClientSecret === undefined && !process.env.GOOGLE_CALENDAR_CLIENT_ID && !process.env.GOOGLE_CLIENT_ID && !stored?.clientSecret) {
    const promptedSecret = await promptForCredential(
      [
        'Optional: paste the OAuth client secret.',
        'Leave blank if you are using a Desktop client with PKCE and no secret.',
      ].join('\n'),
    );
    nextClientSecret = String(promptedSecret || '').trim() || undefined;
  }

  const config: GoogleCalendarOAuthClientConfig = {
    clientId: nextClientId,
    clientSecret: nextClientSecret,
    redirectUri,
    scopes,
    updatedAt: Date.now(),
  };

  await googleCalendarAuthStore.writeClientConfig(config);
  return config;
}

export async function refreshGoogleCalendarProfile(
  profile: GoogleCalendarProfile,
  clientConfig?: GoogleCalendarOAuthClientConfig,
): Promise<GoogleCalendarProfile> {
  const resolvedClientConfig = clientConfig || await resolveOAuthClientConfig();
  if (!profile.refreshToken) {
    throw new Error('Google Calendar profile does not have a refresh token. Re-authenticate with consent.');
  }

  const body = new URLSearchParams({
    client_id: resolvedClientConfig.clientId,
    refresh_token: profile.refreshToken,
    grant_type: 'refresh_token',
  });
  if (resolvedClientConfig.clientSecret) {
    body.set('client_secret', resolvedClientConfig.clientSecret);
  }

  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Google token refresh failed: ${response.status} ${text}`);
  }

  const payload = await response.json() as GoogleTokenResponse;
  const now = Date.now();
  const nextProfile: GoogleCalendarProfile = {
    ...profile,
    accessToken: payload.access_token,
    tokenType: payload.token_type || profile.tokenType,
    idToken: payload.id_token || profile.idToken,
    expiresAt: payload.expires_in ? now + payload.expires_in * 1000 : profile.expiresAt,
    scopes: payload.scope ? normalizeScopes(payload.scope) : profile.scopes,
    updatedAt: now,
  };
  await googleCalendarAuthStore.upsertProfile(nextProfile);
  return nextProfile;
}

async function fetchGoogleUserInfo(accessToken: string): Promise<{ email?: string; name?: string }> {
  const response = await fetch(USERINFO_URL, {
    headers: {
      authorization: `Bearer ${accessToken}`,
    },
  });

  if (!response.ok) {
    return {};
  }

  const payload = await response.json() as { email?: string; name?: string };
  return {
    email: payload.email,
    name: payload.name,
  };
}

function buildProfileId(email?: string, displayName?: string): string {
  const value = email || displayName || randomState();
  return `google-calendar:${String(value).trim().toLowerCase()}`;
}

async function runInteractiveLogin(): Promise<GoogleCalendarProfile> {
  const clientConfig = await resolveOAuthClientConfig();
  const pkce = createPkcePair();
  const state = randomState();
  const authUrl = buildAuthorizeUrl(clientConfig, state, pkce.challenge);

  let callbackCode: string | undefined;
  let callbackState: string | undefined;

  if (isTelegramAuthContext()) {
    await notifyTelegramAboutLogin(authUrl, clientConfig.redirectUri);
    const redirectUrl = await askTelegram(
      [
        'Finish Google Calendar login using the link that was sent.',
        `If you only have the raw link, use this: ${authUrl}`,
        'After Google redirects, paste the full final redirect URL here.',
      ].join('\n\n'),
    );
    const parsed = parseRedirectPayload(redirectUrl);
    callbackCode = parsed.code;
    callbackState = parsed.state;
  } else {
    const callbackPort = getLoopbackCallbackPort(clientConfig.redirectUri);
    let opened = false;

    if (callbackPort) {
      try {
        const waiter = await startOAuthCallbackServer(callbackPort, 180_000);
        try {
          await open(authUrl);
          opened = true;
        } catch {
          // Fall through to manual instructions below.
        }

        try {
          const result = await waiter.waitForResult;
          callbackCode = result.code;
          callbackState = result.state;
        } finally {
          await waiter.close().catch(() => {});
        }
      } catch {
        // Fall back to manual paste below.
      }
    }

    if (!callbackCode || !callbackState) {
      if (!opened) {
        try {
          await open(authUrl);
          opened = true;
        } catch {
          // Manual fallback only.
        }
      }

      const redirectUrl = await promptForCredential(
        [
          'Google Calendar login required.',
          opened ? 'A browser should already be open.' : `Open this URL in your browser:\n${authUrl}`,
          `After consent, paste the full redirect URL here.\nRedirect URI: ${clientConfig.redirectUri}`,
        ].join('\n\n'),
      );
      const parsed = parseRedirectPayload(redirectUrl);
      callbackCode = parsed.code;
      callbackState = parsed.state;
    }
  }

  if (callbackState !== state || !callbackCode) {
    throw new Error('Google OAuth state mismatch. Please retry login.');
  }

  const tokens = await exchangeCodeForTokens({
    clientId: clientConfig.clientId,
    clientSecret: clientConfig.clientSecret,
    redirectUri: clientConfig.redirectUri,
    code: callbackCode,
    codeVerifier: pkce.verifier,
  });

  const claims = parseJwtClaims(tokens.id_token);
  const userInfo = await fetchGoogleUserInfo(tokens.access_token);
  const email = userInfo.email || (typeof claims?.email === 'string' ? claims.email : undefined);
  const displayName = userInfo.name || (typeof claims?.name === 'string' ? claims.name : undefined);
  const now = Date.now();

  const profile: GoogleCalendarProfile = {
    id: buildProfileId(email, displayName),
    provider: 'google-calendar',
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    idToken: tokens.id_token,
    tokenType: tokens.token_type,
    email,
    displayName,
    expiresAt: tokens.expires_in ? now + tokens.expires_in * 1000 : undefined,
    scopes: tokens.scope ? normalizeScopes(tokens.scope) : clientConfig.scopes,
    createdAt: now,
    updatedAt: now,
  };

  await googleCalendarAuthStore.upsertProfile(profile);
  return profile;
}

export async function getRequiredGoogleCalendarProfile(): Promise<GoogleCalendarProfile> {
  const existing = await googleCalendarAuthStore.getActiveProfile();
  if (existing) {
    return existing;
  }

  if (!authFlowPromise) {
    authFlowPromise = runInteractiveLogin().finally(() => {
      authFlowPromise = null;
    });
  }

  return authFlowPromise;
}

export async function ensureFreshGoogleCalendarProfile(): Promise<GoogleCalendarProfile> {
  const profile = await getRequiredGoogleCalendarProfile();
  const expiresSoon = typeof profile.expiresAt === 'number' && profile.expiresAt - Date.now() < 60_000;
  if (!expiresSoon) {
    return profile;
  }
  return refreshGoogleCalendarProfile(profile);
}

export async function loginGoogleCalendar(force = false): Promise<GoogleCalendarAuthStatus> {
  if (force) {
    const profile = await runInteractiveLogin();
    return {
      authenticated: true,
      activeProfileId: profile.id,
      accountLabel: profile.email || profile.displayName,
      expiresAt: profile.expiresAt,
      scopes: profile.scopes,
      clientConfigured: true,
    };
  }

  const profile = await getRequiredGoogleCalendarProfile();
  return {
    authenticated: true,
    activeProfileId: profile.id,
    accountLabel: profile.email || profile.displayName,
    expiresAt: profile.expiresAt,
    scopes: profile.scopes,
    clientConfigured: true,
  };
}

export async function getGoogleCalendarAuthStatus(): Promise<GoogleCalendarAuthStatus> {
  const profile = await googleCalendarAuthStore.getActiveProfile();
  const clientConfig = await googleCalendarAuthStore.readClientConfig();
  return {
    authenticated: Boolean(profile),
    activeProfileId: profile?.id,
    accountLabel: profile?.email || profile?.displayName,
    expiresAt: profile?.expiresAt,
    scopes: profile?.scopes,
    clientConfigured: Boolean(process.env.GOOGLE_CALENDAR_CLIENT_ID || process.env.GOOGLE_CLIENT_ID || clientConfig?.clientId),
  };
}

export async function listGoogleCalendarProfiles(): Promise<Array<{
  id: string;
  email?: string;
  displayName?: string;
  expiresAt?: number;
  active: boolean;
  scopes: string[];
}>> {
  const active = await googleCalendarAuthStore.getActiveProfile();
  const profiles = await googleCalendarAuthStore.listProfiles();
  return profiles.map((profile) => ({
    id: profile.id,
    email: profile.email,
    displayName: profile.displayName,
    expiresAt: profile.expiresAt,
    active: profile.id === active?.id,
    scopes: profile.scopes,
  }));
}

export async function useGoogleCalendarProfile(profileIdOrEmail: string) {
  const profile = await googleCalendarAuthStore.setActiveProfile(profileIdOrEmail);
  return {
    activeProfileId: profile.id,
    accountLabel: profile.email || profile.displayName,
  };
}

export async function logoutGoogleCalendar(profileIdOrEmail?: string): Promise<GoogleCalendarAuthStatus> {
  await googleCalendarAuthStore.removeProfile(profileIdOrEmail);
  return getGoogleCalendarAuthStatus();
}

export async function configureGoogleCalendarClient(input: {
  clientId: string;
  clientSecret?: string;
  redirectUri?: string;
  scopes?: string[];
}) {
  const current = await googleCalendarAuthStore.readClientConfig();
  const config: GoogleCalendarOAuthClientConfig = {
    clientId: String(input.clientId || current?.clientId || '').trim(),
    clientSecret: input.clientSecret ?? current?.clientSecret,
    redirectUri: String(input.redirectUri || current?.redirectUri || DEFAULT_REDIRECT_URI).trim(),
    scopes: input.scopes?.length ? input.scopes : getConfiguredScopes(current),
    updatedAt: Date.now(),
  };

  if (!config.clientId) {
    throw new Error('clientId is required.');
  }

  await googleCalendarAuthStore.writeClientConfig(config);
  return {
    clientId: config.clientId,
    redirectUri: config.redirectUri,
    scopes: config.scopes,
    hasClientSecret: Boolean(config.clientSecret),
    updatedAt: config.updatedAt,
  };
}

export async function getGoogleCalendarClientConfigSummary() {
  const config = await googleCalendarAuthStore.readClientConfig();
  const envClientId = process.env.GOOGLE_CALENDAR_CLIENT_ID || process.env.GOOGLE_CLIENT_ID;
  const envClientSecret = process.env.GOOGLE_CALENDAR_CLIENT_SECRET || process.env.GOOGLE_CLIENT_SECRET;
  const envRedirectUri = process.env.GOOGLE_CALENDAR_REDIRECT_URI;

  const clientId = envClientId || config?.clientId;
  if (!clientId) {
    return {
      configured: false,
      redirectUri: envRedirectUri || config?.redirectUri || DEFAULT_REDIRECT_URI,
      scopes: getConfiguredScopes(config),
    };
  }

  return {
    configured: true,
    clientId,
    redirectUri: envRedirectUri || config?.redirectUri || DEFAULT_REDIRECT_URI,
    scopes: getConfiguredScopes(config),
    hasClientSecret: Boolean(envClientSecret || config?.clientSecret),
    source: envClientId ? 'env' : 'store',
  };
}

export {
  DATA_DIR as GOOGLE_CALENDAR_DATA_DIR,
  DEFAULT_REDIRECT_URI as GOOGLE_CALENDAR_DEFAULT_REDIRECT_URI,
  DEFAULT_SCOPES as GOOGLE_CALENDAR_DEFAULT_SCOPES,
};
