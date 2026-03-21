export function parseRedirectUrl(redirectUrl: string): { code: string; state: string } {
  const text = String(redirectUrl || '').trim();
  const httpIndex = text.indexOf('http://');
  const httpsIndex = text.indexOf('https://');
  const sliceStart = httpIndex >= 0 ? httpIndex : httpsIndex;
  const normalized = sliceStart >= 0 ? text.slice(sliceStart) : text;

  const url = new URL(normalized);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  if (!code || !state) {
    throw new Error('Invalid redirect URL. Expected both code and state query params.');
  }
  return { code, state };
}
