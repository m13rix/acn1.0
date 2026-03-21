import type { ProviderStreamEvent } from '../../types/index.js';
import {
  CodexRateLimitedError,
  CodexTransportFailedError,
  CodexUnauthorizedError,
} from './errors.js';
import { createCodexStreamAccumulator, mapCodexSseEvent } from './invoke.js';

export interface CodexTransportOptions {
  endpoint: string;
  headers: Record<string, string>;
  body: unknown;
}

export interface CodexTransport {
  requestJson(opts: CodexTransportOptions): Promise<any>;
  stream(opts: CodexTransportOptions): AsyncIterable<ProviderStreamEvent>;
}

export class SseCodexTransport implements CodexTransport {
  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  async requestJson(opts: CodexTransportOptions): Promise<any> {
    const response = await this.fetchImpl(opts.endpoint, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        ...opts.headers,
      },
      body: JSON.stringify(opts.body),
    });

    await assertOk(response);

    const contentType = response.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      return response.json();
    }

    const text = await response.text();
    return text ? JSON.parse(text) : {};
  }

  async *stream(opts: CodexTransportOptions): AsyncIterable<ProviderStreamEvent> {
    const response = await this.fetchImpl(opts.endpoint, {
      method: 'POST',
      headers: {
        accept: 'text/event-stream',
        ...opts.headers,
      },
      body: JSON.stringify(opts.body),
    });

    await assertOk(response);

    if (!response.body) {
      throw new CodexTransportFailedError('Expected an SSE response body but received an empty stream.');
    }

    const decoder = new TextDecoder();
    const reader = response.body.getReader();
    const state = createCodexStreamAccumulator();
    let buffer = '';

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let boundaryIndex = buffer.indexOf('\n\n');
        while (boundaryIndex >= 0) {
          const block = buffer.slice(0, boundaryIndex);
          buffer = buffer.slice(boundaryIndex + 2);

          const parsed = parseSseBlock(block);
          if (parsed) {
            for (const event of mapCodexSseEvent(parsed.event, parsed.data, state)) {
              yield event;
            }
          }

          boundaryIndex = buffer.indexOf('\n\n');
        }
      }

      if (buffer.trim()) {
        const parsed = parseSseBlock(buffer);
        if (parsed) {
          for (const event of mapCodexSseEvent(parsed.event, parsed.data, state)) {
            yield event;
          }
        }
      }
    } catch (error) {
      throw new CodexTransportFailedError(`Failed while reading SSE stream: ${String((error as Error)?.message ?? error)}`, { cause: error });
    }
  }
}

async function assertOk(response: Response): Promise<void> {
  if (response.ok) return;
  const text = await response.text().catch(() => '');
  if (response.status === 401) {
    throw new CodexUnauthorizedError(text || 'Unauthorized');
  }
  if (response.status === 429) {
    throw new CodexRateLimitedError(text || 'Rate limited');
  }
  throw new CodexTransportFailedError(`openai-codex request failed with ${response.status}: ${text}`);
}

function parseSseBlock(block: string): { event: string; data: any } | null {
  const lines = block
    .split(/\r?\n/)
    .map(line => line.trimEnd())
    .filter(Boolean);

  let event = 'message';
  const dataLines: string[] = [];

  for (const line of lines) {
    if (line.startsWith('event:')) {
      event = line.slice('event:'.length).trim();
    } else if (line.startsWith('data:')) {
      dataLines.push(line.slice('data:'.length).trim());
    }
  }

  if (dataLines.length === 0) return null;
  const dataText = dataLines.join('\n');
  if (dataText === '[DONE]') {
    return { event: 'response.completed', data: {} };
  }

  try {
    return { event, data: JSON.parse(dataText) };
  } catch {
    return { event, data: { text: dataText } };
  }
}
