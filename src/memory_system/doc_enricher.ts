import { mkdir, writeFile } from 'fs/promises';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { createProvider } from '../providers/factory.js';
import type { MemoryRuntimeConfig } from './types.js';
import { parseToonTables } from './toon.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEBUG_DIR = join(__dirname, '..', '..', 'data', 'memory', 'debug');

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

async function writeDebug(payload: unknown): Promise<string> {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const filePath = join(DEBUG_DIR, `doc-enricher-${stamp}.json`);
  await mkdir(DEBUG_DIR, { recursive: true });
  await writeFile(filePath, JSON.stringify(payload, null, 2), 'utf8');
  return filePath;
}

function parseTopics(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map(v => String(v ?? '').trim()).filter(Boolean);
  }
  const raw = String(value ?? '').trim();
  if (!raw) return [];

  if (raw.startsWith('[') && raw.endsWith(']')) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed.map(v => String(v ?? '').trim()).filter(Boolean);
      }
    } catch {
      // ignore
    }
  }

  return raw
    .split(/[|,]/g)
    .map(item => item.trim())
    .filter(Boolean);
}

export interface DocFactEnrichment {
  id: number;
  topics: string[];
  confidence: number;
}

export async function enrichDocFacts(
  facts: Array<{ id: number; content: string }>,
  config: MemoryRuntimeConfig
): Promise<DocFactEnrichment[]> {
  const provider = createProvider(config.docEnricherProvider);
  const prompt = [
    'You enrich extracted document facts for memory ingestion.',
    'For each fact id, infer:',
    '- topics: concise semantic tags (3-8 items)',
    '- confidence: factual reliability [0..1]',
    '',
    'Return ONLY TOON. No markdown.',
    'Schema:',
    'facts[N,]{id,topics,confidence}:',
    '<id>,<topics as JSON array string>,<confidence>',
    '',
    `INPUT_FACTS=${JSON.stringify(facts)}`,
  ].join('\n');

  const messages = [
    { role: 'system' as const, content: 'Return only TOON. No markdown.' },
    { role: 'user' as const, content: prompt },
  ];

  let fullContent = '';
  const eventCounts: Record<string, number> = {};

  if (!provider.streamEvents) {
    throw new Error(`Provider ${config.docEnricherProvider} does not support streaming.`);
  }

  const stream = await provider.streamEvents(messages, {
    model: config.docEnricherModel,
    temperature: config.docEnricherTemperature,
    maxTokens: config.docEnricherMaxTokens,
    reasoning: 'off',
    stream: true,
  });

  for await (const event of stream) {
    eventCounts[event.type] = (eventCounts[event.type] ?? 0) + 1;
    if (event.type === 'text.delta' && event.delta) {
      fullContent += event.delta;
    }
  }

  if (!fullContent.trim()) {
    const completion = await provider.complete(messages, {
      model: config.docEnricherModel,
      temperature: config.docEnricherTemperature,
      maxTokens: config.docEnricherMaxTokens,
      reasoning: 'off',
    });
    fullContent = completion.content ?? '';
    eventCounts['fallback.complete'] = 1;
  }

  try {
    const tables = parseToonTables(fullContent, ['facts']);
    const factsTable = tables.facts;
    if (!factsTable) throw new Error('facts table is missing.');

    const result: DocFactEnrichment[] = [];
    for (let i = 0; i < factsTable.rows.length; i++) {
      const row = factsTable.rows[i];
      if (!row) continue;
      const id = Number(row.id);
      if (!Number.isInteger(id)) continue;
      const topics = parseTopics(row.topics);
      const confidence = clamp01(Number(row.confidence ?? NaN));
      if (topics.length === 0 || !Number.isFinite(Number(row.confidence))) continue;
      result.push({ id, topics, confidence });
    }
    return result;
  } catch (error) {
    const path = await writeDebug({
      stage: 'doc_enrich_error',
      provider: config.docEnricherProvider,
      model: config.docEnricherModel,
      prompt,
      rawResponse: fullContent,
      eventCounts,
      error: error instanceof Error ? error.message : String(error),
    });
    throw new Error(`Failed to parse doc enricher output. Debug snapshot: ${path}`);
  }
}
