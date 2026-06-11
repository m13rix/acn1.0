export interface ModExecuteResponse {
  success?: boolean;
  value?: unknown;
  error?: unknown;
  consoleLog?: unknown;
  elapsedMillis?: number;
}

export interface ExecuteOptions {
  endpoint?: string;
}

const DEFAULT_ENDPOINT = 'http://127.0.0.1:5200/execute';

type ModScript = string | (() => unknown | Promise<unknown>);

function normalizeScript(script: ModScript): string {
  if (typeof script === 'string') {
    const trimmed = script.trim();
    if (!trimmed) {
      throw new Error('mod.execute requires a non-empty script string.');
    }
    return trimmed;
  }

  if (typeof script !== 'function') {
    throw new Error('mod.execute requires a JavaScript callback or script string.');
  }

  const source = Function.prototype.toString.call(script).trim();
  const bodyStart = source.indexOf('{');
  const bodyEnd = source.lastIndexOf('}');

  if (bodyStart !== -1 && bodyEnd > bodyStart) {
    const body = source.slice(bodyStart + 1, bodyEnd).trim();
    if (!body) {
      throw new Error('mod.execute callback body is empty.');
    }
    return body;
  }

  const arrowIndex = source.indexOf('=>');
  if (arrowIndex !== -1) {
    const expression = source.slice(arrowIndex + 2).trim();
    if (expression) {
      return expression;
    }
  }

  throw new Error('mod.execute could not serialize callback body.');
}

function formatConsoleEntry(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || value === null || value === undefined) {
    return String(value);
  }

  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function formatConsoleLog(consoleLog: unknown): string {
  if (consoleLog === null || consoleLog === undefined) return '';
  if (typeof consoleLog === 'string') return consoleLog.trim();
  if (Array.isArray(consoleLog)) {
    return consoleLog.map(formatConsoleEntry).filter(Boolean).join('\n').trim();
  }
  if (typeof consoleLog === 'object') {
    const entries = Object.entries(consoleLog as Record<string, unknown>);
    if (entries.length === 0) return '';

    return entries
      .sort(([a], [b]) => Number(a) - Number(b))
      .map(([, value]) => {
        if (Array.isArray(value)) {
          return value.map(formatConsoleEntry).join(' ');
        }
        return formatConsoleEntry(value);
      })
      .filter(Boolean)
      .join('\n')
      .trim();
  }

  return formatConsoleEntry(consoleLog).trim();
}

function formatError(error: unknown): string {
  if (typeof error === 'string') return error;
  if (error instanceof Error) return error.message;
  if (error === null || error === undefined) return 'Unknown Minecraft mod sandbox error.';

  try {
    return JSON.stringify(error, null, 2);
  } catch {
    return String(error);
  }
}

/**
 * Execute JavaScript inside the live Minecraft custom mod sandbox.
 *
 * The callback is not invoked locally. Its body is serialized and sent to the
 * mod endpoint as real JavaScript for the Minecraft runtime.
 */
export async function execute(script: ModScript, options: ExecuteOptions = {}): Promise<string> {
  const endpoint = options.endpoint || process.env.MINECRAFT_MOD_EXECUTE_URL || DEFAULT_ENDPOINT;
  const normalizedScript = normalizeScript(script);

  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ script: normalizedScript }),
    });
  } catch (error: any) {
    throw new Error(`Failed to reach Minecraft mod sandbox at ${endpoint}: ${error?.message || String(error)}`);
  }

  const text = await response.text();
  let payload: ModExecuteResponse;
  try {
    payload = text ? JSON.parse(text) as ModExecuteResponse : {};
  } catch {
    throw new Error(`Minecraft mod sandbox returned non-JSON response (${response.status}): ${text}`);
  }

  const logs = formatConsoleLog(payload.consoleLog);
  if (!response.ok || payload.success === false) {
    const errorText = formatError(payload.error || `HTTP ${response.status}`);
    throw new Error(logs ? `${errorText}\n\nConsole output:\n${logs}` : errorText);
  }

  return logs;
}

export const __internals = {
  formatConsoleLog,
  normalizeScript,
};
