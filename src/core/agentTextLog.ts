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
  const fallback = normalizeLoggedText(fallbackResult);
  const last = (source: AgentTextLogSource): string => {
    for (let index = entries.length - 1; index >= 0; index--) {
      const entry = entries[index];
      if (entry?.source === source) {
        const text = normalizeLoggedText(entry.text);
        if (text) return text;
      }
    }
    return '';
  };

  // `assistant_text` is emitted for every provider turn, including progress
  // narration before tool calls. It is trace data, not an agent-call result.
  // `response` is emitted only when the executor reaches its terminal response.
  const terminalResponse = last('response');
  if (terminalResponse) {
    return terminalResponse;
  }

  if (fallback) {
    return fallback;
  }

  // Agents that deliberately suppress their provider completion may deliver
  // their terminal outcome through the message tool instead.
  return last('sent_text') || last('assistant_text');
}
