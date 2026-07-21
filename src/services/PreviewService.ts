import WebSocket from 'ws';

import { ThreadStore } from './thread-store/ThreadStore.js';
import type { StoredPreviewSession } from './thread-store/types.js';

const MAX_REDIRECTS = 5;
const FORBIDDEN_REQUEST_HEADERS = new Set([
  'connection', 'content-length', 'host', 'proxy-authorization', 'proxy-connection', 'te', 'trailer',
  'transfer-encoding', 'upgrade',
]);

export interface PreviewHttpResponse {
  status: number;
  statusText: string;
  headers: Record<string, string[]>;
  finalUrl: string;
  body: AsyncIterable<Uint8Array>;
}

export class PreviewService {
  constructor(
    readonly store: ThreadStore,
    private readonly emit?: (threadId: string, state: string, payload: Record<string, unknown>) => void,
  ) {}

  open(input: { threadId: string; previewSessionId?: string; url: string }): StoredPreviewSession {
    this.requireThread(input.threadId);
    const url = normalizeSessionUrl(input.url);
    const session = this.store.savePreviewSession({
      id: input.previewSessionId,
      threadId: input.threadId,
      url: url.href,
      state: 'open',
    });
    this.emit?.(input.threadId, 'opened', { previewSession: session });
    return session;
  }

  navigate(input: { threadId: string; previewSessionId: string; url: string }): StoredPreviewSession {
    const current = this.requireSession(input.threadId, input.previewSessionId);
    const url = normalizeSessionUrl(input.url, current.url);
    const session = this.store.savePreviewSession({
      id: current.id,
      threadId: current.threadId,
      url: url.href,
      state: 'open',
    });
    this.emit?.(input.threadId, 'navigated', { previewSession: session });
    return session;
  }

  close(input: { threadId: string; previewSessionId: string }): StoredPreviewSession {
    const current = this.requireSession(input.threadId, input.previewSessionId);
    const session = this.store.savePreviewSession({
      id: current.id,
      threadId: current.threadId,
      url: current.url,
      state: 'closed',
    });
    this.emit?.(input.threadId, 'closed', { previewSession: session });
    return session;
  }

  list(threadId: string): StoredPreviewSession[] {
    this.requireThread(threadId);
    return this.store.listPreviewSessions(threadId);
  }

  resolveUrl(threadId: string, previewSessionId: string, requestedUrl?: string): URL {
    const session = this.requireSession(threadId, previewSessionId);
    if (session.state === 'closed') throw new Error(`Preview session is closed: ${previewSessionId}`);
    return normalizePreviewUrl(requestedUrl || session.url, session.url);
  }

  async request(input: {
    threadId: string;
    previewSessionId: string;
    url?: string;
    method?: string;
    headers?: Record<string, string | string[]>;
    body?: Uint8Array;
    signal?: AbortSignal;
  }): Promise<PreviewHttpResponse> {
    let url = this.resolveUrl(input.threadId, input.previewSessionId, input.url);
    const method = String(input.method || 'GET').toUpperCase();
    const headers = sanitizeRequestHeaders(input.headers || {});
    for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
      const response = await fetch(url, {
        method,
        headers,
        body: method === 'GET' || method === 'HEAD' ? undefined : input.body,
        redirect: 'manual',
        signal: input.signal,
      });
      if (response.status >= 300 && response.status < 400 && response.headers.has('location')) {
        if (redirect === MAX_REDIRECTS) throw new Error('Preview request exceeded the redirect limit.');
        url = normalizePreviewUrl(response.headers.get('location')!, url.href);
        continue;
      }
      return {
        status: response.status,
        statusText: response.statusText,
        headers: responseHeaders(response.headers),
        finalUrl: url.href,
        body: responseBody(response.body),
      };
    }
    throw new Error('Preview request failed to resolve.');
  }

  openWebSocket(input: {
    threadId: string;
    previewSessionId: string;
    url?: string;
    protocols?: string[];
    headers?: Record<string, string | string[]>;
  }): WebSocket {
    const httpUrl = this.resolveUrl(input.threadId, input.previewSessionId, input.url);
    httpUrl.protocol = httpUrl.protocol === 'https:' ? 'wss:' : 'ws:';
    return new WebSocket(httpUrl, input.protocols || [], {
      headers: sanitizeRequestHeaders(input.headers || {}),
      followRedirects: false,
    });
  }

  private requireThread(threadId: string): void {
    if (!this.store.getThread(threadId)) throw new Error(`Thread not found: ${threadId}`);
  }

  private requireSession(threadId: string, previewSessionId: string): StoredPreviewSession {
    const session = this.store.getPreviewSession(previewSessionId);
    if (!session || session.threadId !== threadId) {
      throw new Error(`Preview session is not available to this thread: ${previewSessionId}`);
    }
    return session;
  }
}

export function normalizePreviewUrl(value: string, base?: string): URL {
  const url = normalizeSessionUrl(value, base);
  const host = url.hostname.replace(/^\[|\]$/gu, '').toLowerCase();
  if (host !== 'localhost' && host !== '127.0.0.1' && host !== '::1') {
    throw new Error(`Harness previews may access only loopback services, received: ${url.hostname}`);
  }
  return url;
}

function normalizeSessionUrl(value: string, base?: string): URL {
  const url = new URL(value, base);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Harness previews require an HTTP or HTTPS URL.');
  }
  url.username = '';
  url.password = '';
  return url;
}

function sanitizeRequestHeaders(input: Record<string, string | string[]>): Record<string, string> {
  const output: Record<string, string> = {};
  for (const [name, raw] of Object.entries(input)) {
    const normalized = name.toLowerCase();
    if (FORBIDDEN_REQUEST_HEADERS.has(normalized)) continue;
    output[normalized] = Array.isArray(raw) ? raw.join(', ') : String(raw);
  }
  return output;
}

function responseHeaders(headers: Headers): Record<string, string[]> {
  const output: Record<string, string[]> = {};
  headers.forEach((value, name) => {
    (output[name] ||= []).push(value);
  });
  return output;
}

async function* responseBody(body: ReadableStream<Uint8Array> | null): AsyncIterable<Uint8Array> {
  if (!body) return;
  const reader = body.getReader();
  try {
    for (;;) {
      const value = await reader.read();
      if (value.done) return;
      yield value.value;
    }
  } finally {
    reader.releaseLock();
  }
}
