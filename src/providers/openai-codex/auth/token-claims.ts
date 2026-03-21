export interface TokenClaims {
  email?: string;
  name?: string;
  chatgpt_account_id?: string;
  organizations?: Array<{ id: string }>;
  [key: string]: unknown;
}

const OPENAI_AUTH_CLAIMS_KEY = 'https://api.openai.com/auth';

export function parseJwtClaims(token?: string): TokenClaims | undefined {
  if (!token) return undefined;
  const parts = token.split('.');
  if (parts.length !== 3) return undefined;

  try {
    const payload = JSON.parse(Buffer.from(parts[1] ?? '', 'base64url').toString('utf8')) as TokenClaims & {
      [OPENAI_AUTH_CLAIMS_KEY]?: TokenClaims;
    };
    const nestedClaims = payload[OPENAI_AUTH_CLAIMS_KEY];
    if (nestedClaims && typeof nestedClaims === 'object') {
      return {
        ...nestedClaims,
        email: nestedClaims.email ?? payload.email,
        name: nestedClaims.name ?? payload.name,
      };
    }
    return payload;
  } catch {
    return undefined;
  }
}

export function extractAccountId(claims?: TokenClaims): string | undefined {
  if (!claims) return undefined;
  return claims.chatgpt_account_id || claims.organizations?.[0]?.id;
}
