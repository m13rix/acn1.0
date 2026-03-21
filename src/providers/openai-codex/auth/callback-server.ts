import http from 'node:http';
import { URL } from 'node:url';
import { OAuthCallbackTimeoutError } from '../errors.js';

export interface OAuthCallbackResult {
  code: string;
  state: string;
}

export interface OAuthCallbackWaiter {
  waitForResult: Promise<OAuthCallbackResult>;
  close: () => Promise<void>;
}

export async function startOAuthCallbackServer(port = 1455, timeoutMs = 180_000): Promise<OAuthCallbackWaiter> {
  let settled = false;
  let timeout: NodeJS.Timeout | undefined;
  let rejectWaiter: ((reason?: unknown) => void) | undefined;

  const server = http.createServer();

  const waitForResult = new Promise<OAuthCallbackResult>((resolve, reject) => {
    rejectWaiter = reject;
    server.on('request', (req, res) => {
      const url = new URL(req.url ?? '/', `http://localhost:${port}`);
      if (url.pathname !== '/auth/callback') {
        res.statusCode = 404;
        res.end('Not found');
        return;
      }

      const error = url.searchParams.get('error');
      const code = url.searchParams.get('code');
      const state = url.searchParams.get('state');

      if (error) {
        res.statusCode = 400;
        res.end(`OAuth failed: ${error}`);
        settled = true;
        clearTimeout(timeout);
        server.close();
        reject(new Error(`OAuth failed: ${error}`));
        return;
      }

      if (!code || !state) {
        res.statusCode = 400;
        res.end('Missing code or state');
        settled = true;
        clearTimeout(timeout);
        server.close();
        reject(new Error('Missing code or state'));
        return;
      }

      res.statusCode = 200;
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end('<h1>Authorization successful</h1><p>You can close this tab.</p>');

      settled = true;
      clearTimeout(timeout);
      server.close();
      resolve({ code, state });
    });

    server.once('error', (error) => {
      settled = true;
      clearTimeout(timeout);
      reject(error);
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.listen(port, '127.0.0.1', () => resolve());
    server.once('error', reject);
  });

  timeout = setTimeout(() => {
    if (settled) return;
    settled = true;
    server.close();
    rejectWaiter?.(new OAuthCallbackTimeoutError());
  }, timeoutMs);

  return {
    waitForResult,
    close: async () => {
      if (timeout) clearTimeout(timeout);
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
