export interface OAuthProfile {
  id: string;
  provider: 'openai-codex';
  type: 'oauth-chatgpt';
  accountId?: string;
  email?: string;
  displayName?: string;
  accessToken: string;
  refreshToken: string;
  idToken?: string;
  expiresAt: number;
  createdAt: number;
  updatedAt: number;
  scopes?: string[];
  meta?: {
    source?: 'browser-pkce' | 'manual-paste';
    workspaceHint?: string;
    clientVariant?: string;
  };
}

export interface AuthStoreShape {
  version: 1;
  activeProfiles: Partial<Record<'openai-codex', string>>;
  profiles: Record<string, OAuthProfile>;
}

export interface LoginSessionRecord {
  id: string;
  state: string;
  codeVerifier: string;
  codeChallenge: string;
  authorizeUrl: string;
  tokenUrl: string;
  redirectUri: string;
  clientId: string;
  scopes: string[];
  createdAt: number;
  expiresAt: number;
}
