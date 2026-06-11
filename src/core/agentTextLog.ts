import { appendFileSync, mkdirSync } from 'fs';
import { readFile } from 'fs/promises';
import { dirname } from 'path';

export type AgentTextLogSource = 'assistant_text' | 'sent_text' | 'response';

export interface AgentTextLogEntry {
  source: AgentTextLogSource;
  text: string;
}

function normalizeLoggedText(text: string): string {
  return String(text || '').replace(/\r\n/g, '\n').trim();
}

export function appendAgentTextLog(
  logPath: string | undefined,
  source: AgentTextLogSource,
  text: string
): void {
  if (!logPath) {
    return;
  }

  const normalized = normalizeLoggedText(text);
  if (!normalized) {
    return;
  }

  mkdirSync(dirname(logPath), { recursive: true });
  appendFileSync(logPath, `${JSON.stringify({ source, text: normalized })}\n`, 'utf-8');
}

export async function readAgentTextLog(logPath: string | undefined): Promise<AgentTextLogEntry[]> {
  if (!logPath) {
    return [];
  }

  try {
    const raw = await readFile(logPath, 'utf-8');
    const entries: AgentTextLogEntry[] = [];

    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }

      try {
        const parsed = JSON.parse(trimmed) as Partial<AgentTextLogEntry>;
        if (typeof parsed.text !== 'string' || typeof parsed.source !== 'string') {
          continue;
        }
        const normalized = normalizeLoggedText(parsed.text);
        if (!normalized) {
          continue;
        }
        entries.push({
          source: parsed.source as AgentTextLogSource,
          text: normalized,
        });
      } catch {
        continue;
      }
    }

    return entries;
  } catch (error: any) {
    if (error?.code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}

export function buildAgentCallTextResult(entries: AgentTextLogEntry[], fallbackResult: string): string {
  const messages = entries
    .map((entry) => normalizeLoggedText(entry.text))
    .filter(Boolean);
  const fallback = normalizeLoggedText(fallbackResult);

  if (messages.length === 0) {
    return fallback;
  }

  if (fallback && messages[messages.length - 1] !== fallback) {
    messages.push(fallback);
  }

  return messages.join('\n\n');
}
