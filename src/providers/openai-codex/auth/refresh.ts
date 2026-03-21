import type { OAuthProfile } from './auth-types.js';
import { OpenAICodexAuthStore } from './auth-store.js';
import { TokenRefreshFailedError } from '../errors.js';
import { withRefreshLock } from './auth-lock.js';

interface TokenRefreshResponse {
  access_token: string;
  refresh_token?: string;
  id_token?: string;
  expires_in?: number;
}

export async function refreshAccessToken(input: {
  tokenUrl: string;
  clientId: string;
  refreshToken: string;
  fetchImpl?: typeof fetch;
}): Promise<TokenRefreshResponse> {
  const fetchImpl = input.fetchImpl || fetch;
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: input.refreshToken,
    client_id: input.clientId,
  });

  const response = await fetchImpl(input.tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new TokenRefreshFailedError(`Token refresh failed: ${response.status} ${text}`);
  }

  return response.json() as Promise<TokenRefreshResponse>;
}

export async function getValidProfile(input: {
  authStore: OpenAICodexAuthStore;
  tokenUrl: string;
  clientId: string;
  fetchImpl?: typeof fetch;
}): Promise<OAuthProfile | undefined> {
  const current = await input.authStore.getActiveProfile();
  if (!current) return undefined;

  if (current.expiresAt > Date.now() + 30_000) {
    return current;
  }

  return withRefreshLock(input.authStore.refreshLockPath, async () => {
    const latest = await input.authStore.getActiveProfile();
    if (!latest) return undefined;
    if (latest.expiresAt > Date.now() + 30_000) return latest;

    const refreshed = await refreshAccessToken({
      tokenUrl: input.tokenUrl,
      clientId: input.clientId,
      refreshToken: latest.refreshToken,
      fetchImpl: input.fetchImpl,
    });

    const updated: OAuthProfile = {
      ...latest,
      accessToken: refreshed.access_token,
      refreshToken: refreshed.refresh_token ?? latest.refreshToken,
      idToken: refreshed.id_token ?? latest.idToken,
      expiresAt: Date.now() + (refreshed.expires_in ?? 3600) * 1000,
      updatedAt: Date.now(),
    };

    await input.authStore.upsertProfile(updated);
    return updated;
  });
}
