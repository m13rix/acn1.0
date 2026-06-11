import { createHash } from 'crypto';
import { mkdir, appendFile } from 'fs/promises';
import { dirname, join } from 'path';
import type { Message, ProviderConfig } from '../types/index.js';
import type { Session } from './Session.js';

export interface UsageSnapshot {
  inputTokens?: number;
  inputTokensNoCache?: number;
  inputTokensCacheRead?: number;
  inputTokensCacheWrite?: number;
  outputTokens?: number;
  outputTextTokens?: number;
  outputReasoningTokens?: number;
  totalTokens?: number;
  raw?: unknown;
  estimatedCostUsd?: number;
}

export interface CostLedgerEntry {
  timestamp: string;
  sessionId: string;
  agentName: string;
  providerName: string;
  model: string;
  stream: boolean;
  stepNumber?: number;
  reason: string;
  promptCacheKey?: string;
  promptFingerprint: string;
  messageCount: number;
  systemChars: number;
  userChars: number;
  assistantChars: number;
  toolChars: number;
  fileChars: number;
  totalChars: number;
  usage: UsageSnapshot;
}

function projectRoot(): string {
  return process.env.PROJECT_ROOT || process.cwd();
}

function ledgerPath(): string {
  return process.env.TELOS_COST_LEDGER_PATH || join(projectRoot(), 'data', 'cost-ledger.jsonl');
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function stripSessionTimeContext(systemPrompt: string): string {
  return systemPrompt
    .replace(/\n\nLocal device time: [A-Za-z]+, \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\s*$/u, '')
    .trim();
}

function numberFrom(...values: unknown[]): number | undefined {
  for (const value of values) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) {
      return numeric;
    }
  }
  return undefined;
}

export function buildPromptCacheKey(session: Session, config: ProviderConfig): string {
  const stablePayload = JSON.stringify({
    agent: session.agent.config.name,
    provider: config.provider || session.agent.config.provider || session.provider.name,
    prompt: stripSessionTimeContext(session.getSystemPrompt()),
    tools: session.tools.map(tool => tool.config.name).sort(),
    requireFinish: session.agent.config.requireFinish,
  });
  return `telos:${sha256(stablePayload).slice(0, 48)}`;
}

export function extractUsageSnapshot(source: unknown): UsageSnapshot | null {
  if (!source || typeof source !== 'object') {
    return null;
  }

  const usage = source as Record<string, any>;
  const inputTokens = usage.inputTokens;
  const outputTokens = usage.outputTokens;
  const raw = usage.raw && typeof usage.raw === 'object' ? usage.raw as Record<string, any> : undefined;

  const snapshot: UsageSnapshot = {
    inputTokens: numberFrom(inputTokens?.total, usage.promptTokens, usage.input_tokens, raw?.input_tokens, raw?.promptTokens),
    inputTokensNoCache: numberFrom(inputTokens?.noCache, raw?.input_tokens_details?.uncached_tokens),
    inputTokensCacheRead: numberFrom(inputTokens?.cacheRead, raw?.input_tokens_details?.cached_tokens, raw?.prompt_tokens_details?.cached_tokens, raw?.cached_tokens),
    inputTokensCacheWrite: numberFrom(inputTokens?.cacheWrite, raw?.cache_write_tokens),
    outputTokens: numberFrom(outputTokens?.total, usage.completionTokens, usage.output_tokens, raw?.output_tokens, raw?.completionTokens),
    outputTextTokens: numberFrom(outputTokens?.text),
    outputReasoningTokens: numberFrom(outputTokens?.reasoning, raw?.output_tokens_details?.reasoning_tokens, raw?.completion_tokens_details?.reasoning_tokens),
    totalTokens: numberFrom(usage.totalTokens, usage.total_tokens, raw?.total_tokens, raw?.totalTokens),
    estimatedCostUsd: numberFrom(raw?.cost, raw?.costDollars, raw?.total_cost),
    raw: usage.raw ?? usage,
  };

  if (snapshot.totalTokens === undefined && (snapshot.inputTokens !== undefined || snapshot.outputTokens !== undefined)) {
    snapshot.totalTokens = (snapshot.inputTokens || 0) + (snapshot.outputTokens || 0);
  }

  const hasAnyNumber = Object.entries(snapshot).some(([key, value]) => key !== 'raw' && value !== undefined);
  return hasAnyNumber ? snapshot : null;
}

function messageStats(messages: Message[]) {
  const stats = {
    messageCount: messages.length,
    systemChars: 0,
    userChars: 0,
    assistantChars: 0,
    toolChars: 0,
    fileChars: 0,
    totalChars: 0,
  };

  for (const message of messages) {
    const chars = String(message.content || '').length;
    stats.totalChars += chars;
    if (message.role === 'system') stats.systemChars += chars;
    else if (message.role === 'user') stats.userChars += chars;
    else if (message.role === 'assistant') stats.assistantChars += chars;
    else if (message.role === 'tool') stats.toolChars += chars;
    else if (message.role === 'file') stats.fileChars += chars;
  }

  return stats;
}

export async function recordCostLedgerEntry(input: {
  session: Session;
  config: ProviderConfig;
  messages: Message[];
  usage: unknown;
  reason: string;
  stepNumber?: number;
  promptCacheKey?: string;
}): Promise<void> {
  const usage = extractUsageSnapshot(input.usage);
  if (!usage) {
    return;
  }

  const stats = messageStats(input.messages);
  const systemPrompt = input.messages.find(message => message.role === 'system')?.content || '';
  const entry: CostLedgerEntry = {
    timestamp: new Date().toISOString(),
    sessionId: input.session.id,
    agentName: input.session.agent.config.name,
    providerName: input.config.provider || input.session.agent.config.provider || input.session.provider.name,
    model: input.config.model,
    stream: input.config.stream === true,
    stepNumber: input.stepNumber,
    reason: input.reason,
    promptCacheKey: input.promptCacheKey,
    promptFingerprint: sha256(stripSessionTimeContext(systemPrompt)).slice(0, 24),
    ...stats,
    usage,
  };

  const path = ledgerPath();
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(entry)}\n`, 'utf8');
}
