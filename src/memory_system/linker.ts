import { getGlobalDisplay } from '../core/GlobalDisplay.js';
import { createProvider } from '../providers/factory.js';
import { mkdir, writeFile } from 'fs/promises';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import type { LinkSuggestion, LinkerInput, MemoryRuntimeConfig } from './types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LINKER_DEBUG_DIR = join(__dirname, '..', '..', 'data', 'memory', 'debug');

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function normalizeRawResponse(text: string): string {
  let normalized = text.trim();
  if (!normalized) return '';

  // Some models return a quoted payload, e.g. "\"links[0,...]\"".
  if (normalized.startsWith('"') && normalized.endsWith('"')) {
    try {
      const parsed = JSON.parse(normalized);
      if (typeof parsed === 'string') {
        normalized = parsed.trim();
      }
    } catch {
      // keep original if not valid JSON string
    }
  }

  // Minimal wrapper cleanup seen in real model outputs.
  normalized = normalized
    .replace(/^<output>\s*/i, '')
    .replace(/\s*<\/output>$/i, '')
    .trim();

  return normalized;
}

function isZeroLinksShorthand(text: string): boolean {
  const t = normalizeRawResponse(text).toLowerCase();
  return /^links\[\s*0\s*,?\s*\]\s*:?\s*$/.test(t) || /^links\[\s*\]\s*:?\s*$/.test(t);
}

function looksLikeIncompleteToon(text: string): boolean {
  const t = normalizeRawResponse(text);
  if (!t) return false;
  if (/^links\[[^\]]+\]\s*$/.test(t)) return true;
  if (/^links\[[^\]]+\]\s*,\s*$/.test(t)) return true;
  return false;
}

function unescapeQuoted(value: string): string {
  return value
    .replace(/\\\\/g, '\\')
    .replace(/\\"/g, '"')
    .replace(/\\n/g, '\n')
    .replace(/\\t/g, '\t')
    .replace(/\\r/g, '\r');
}

function parseDelimitedRow(line: string, delimiter: string): string[] {
  const values: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (!ch) continue;

    if (ch === '"' && line[i - 1] !== '\\') {
      inQuotes = !inQuotes;
      continue;
    }

    if (!inQuotes && ch === delimiter) {
      values.push(current.trim());
      current = '';
      continue;
    }

    current += ch;
  }

  values.push(current.trim());
  return values.map(value => {
    const trimmed = value.trim();
    if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) {
      return unescapeQuoted(trimmed.slice(1, -1));
    }
    return trimmed;
  });
}

function stripLinkerNoiseLine(line: string): string {
  return line
    .replace(/^\s*\d+\s*,\s*\{?\s*"?links\[[^\]]*\]\{[^}]*\}\s*:\s*/i, '')
    .replace(/^\s*"?links\[[^\]]*\]\{[^}]*\}\s*:\s*/i, '')
    .replace(/^\s*"?links\[[^\]]*\]\s*:\s*/i, '')
    .replace(/^\s*\{\s*"?links\[[^\]]*\]\{[^}]*\}\s*:\s*/i, '')
    .replace(/\s*\}:\s*$/g, '')
    .replace(/\s*\}\s*$/g, '')
    .replace(/\s*TOON\s*$/i, '')
    .trim();
}

function looksLikeLinkCsvRow(line: string): boolean {
  if (!line) return false;
  const parts = parseDelimitedRow(line, ',');
  if (parts.length < 4) return false;
  const from = (parts[0] ?? '').trim();
  const to = (parts[1] ?? '').trim();
  const relation = (parts[2] ?? '').trim();
  return Boolean(from && to && relation);
}

function salvageLinkRowsFromText(text: string): Array<Record<string, unknown>> {
  const rows: Array<Record<string, unknown>> = [];
  const lines = normalizeRawResponse(text).split(/\r?\n/);

  for (const rawLine of lines) {
    const clean = stripLinkerNoiseLine(rawLine);
    if (!clean) continue;
    if (!looksLikeLinkCsvRow(clean)) continue;
    const values = parseDelimitedRow(clean, ',');
    rows.push({
      fromFactId: values[0] ?? '',
      toFactId: values[1] ?? '',
      relation: values[2] ?? '',
      confidence: values[3] ?? '',
    });
  }

  return rows;
}

function parseObjectLikeRow(line: string): Record<string, unknown> | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return null;

  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === 'object') {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // fallback parser below
  }

  const body = trimmed.slice(1, -1);
  const out: Record<string, unknown> = {};
  const parts = body.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/);
  for (const part of parts) {
    const kv = part.split(':');
    if (kv.length < 2) continue;
    const key = kv[0]?.trim().replace(/^["']|["']$/g, '');
    const valueRaw = kv.slice(1).join(':').trim();
    if (!key) continue;
    out[key] = valueRaw.replace(/^["']|["']$/g, '');
  }
  return Object.keys(out).length > 0 ? out : null;
}

function extractToonRows(text: string): Array<Record<string, unknown>> {
  const trimmed = normalizeRawResponse(text);
  if (!trimmed || trimmed === '""' || trimmed === "''" || trimmed === 'null') {
    return [];
  }
  if (isZeroLinksShorthand(trimmed)) {
    return [];
  }
  const fenced = trimmed.match(/```(?:toon)?\s*([\s\S]*?)```/i);
  const payload = (fenced?.[1] ?? trimmed).trim();

  const header = payload.match(/(?:^|[\s>])links(?:\[(\d*)([,\t|;])?\])?(?:\{([^\r\n}]*)\}|\{)?\s*:?/i);
  if (!header || header.index === undefined) {
    throw new Error('Linker response does not contain a TOON links table.');
  }
  const matchedHeader = header[0] ?? '';
  if (!matchedHeader.includes('[') && !matchedHeader.includes('{')) {
    throw new Error('Linker response does not contain a valid TOON links header.');
  }

  const expectedRows = header[1] === undefined || header[1] === '' ? -1 : Number(header[1]);
  const rowDelimiter = (header[2] && header[2].length > 0) ? header[2] : ',';
  if (expectedRows === 0 && !header[3]) {
    return [];
  }

  const columnsRaw = header[3] ?? '';
  const columnsDelimiter = columnsRaw.includes(rowDelimiter) ? rowDelimiter : ',';
  const columns = parseDelimitedRow(columnsRaw, columnsDelimiter).map(value => value.trim()).filter(Boolean);
  const effectiveColumns = columns.length > 0
    ? columns
    : ['fromFactId', 'toFactId', 'relation', 'confidence'];

  const afterHeader = payload.slice(header.index + header[0].length);
  const lines = afterHeader.split(/\r?\n/);
  const rowLines: string[] = [];

  for (const line of lines) {
    const clean = line.trim();
    if (!clean || clean.startsWith('#')) continue;
    rowLines.push(clean.replace(/;$/, '').trim());
  }

  if (expectedRows === 0 && rowLines.length === 0) {
    return [];
  }

  const rows: Array<Record<string, unknown>> = [];
  const limit = rowLines.length;
  for (let i = 0; i < limit; i++) {
    const line = stripLinkerNoiseLine(rowLines[i] ?? '');
    if (!line) continue;
    if (line === '{' || line === '}') continue;

    const objectLike = parseObjectLikeRow(line);
    if (objectLike) {
      rows.push(objectLike);
      continue;
    }

    const values = parseDelimitedRow(line, rowDelimiter);
    if (values.length < 3) continue;
    const row: Record<string, unknown> = {};
    for (let col = 0; col < effectiveColumns.length; col++) {
      const column = effectiveColumns[col];
      if (!column) continue;
      row[column] = values[col] ?? '';
    }
    rows.push(row);
  }

  return rows;
}

function extractJsonObject(text: string): string {
  const trimmed = normalizeRawResponse(text);
  if (!trimmed || trimmed === '""' || trimmed === "''" || trimmed === 'null') {
    return '{"links":[]}';
  }

  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    return `{"links":${trimmed}}`;
  }

  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    return trimmed;
  }

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) {
    return fenced[1].trim();
  }

  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start !== -1 && end !== -1 && end > start) {
    return trimmed.slice(start, end + 1);
  }

  throw new Error('Linker response does not contain a JSON object.');
}

export function parseLinkerRawResponse(text: string): Array<Record<string, unknown>> {
  const normalized = normalizeRawResponse(text);
  if (!normalized || normalized === '""' || normalized === "''" || normalized === 'null') {
    return [];
  }
  if (isZeroLinksShorthand(normalized)) {
    return [];
  }

  try {
    return extractToonRows(normalized);
  } catch {
    const salvaged = salvageLinkRowsFromText(normalized);
    if (salvaged.length > 0) return salvaged;
    const jsonText = extractJsonObject(normalized);
    const parsed = JSON.parse(jsonText) as { links?: Array<Record<string, unknown>> };
    if (Array.isArray(parsed.links)) return parsed.links;
    const nestedSalvaged = salvageLinkRowsFromText(JSON.stringify(parsed));
    return nestedSalvaged;
  }
}

async function writeLinkerDebugSnapshot(
  payload: {
    stage: string;
    provider: string;
    model: string;
    requestPreview?: unknown;
    prompt: string;
    rawResponse: string;
    rawReasoningTail?: string;
    parsedRows?: Array<Record<string, unknown>>;
    eventCounts?: Record<string, number>;
    error?: string;
  },
  enabled: boolean
): Promise<string | null> {
  if (!enabled) return null;
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const filePath = join(LINKER_DEBUG_DIR, `linker-${stamp}.json`);

  await mkdir(LINKER_DEBUG_DIR, { recursive: true });
  await writeFile(filePath, JSON.stringify(payload, null, 2), 'utf8');
  return filePath;
}

function buildPrompt(input: LinkerInput): string {
  return [
    'You are an expert semantic graph linker for a cognitive agent memory system.',
    'Your goal is to generate precise, meaningful directed links between NEW facts and existing knowledge.',
    '',
    '## Relationship Types:',
    'You are encouraged to use specific, descriptive short phrases (verbs or verb phrases) for relations.',
    'Use the following standard types OR create your own precise descriptions that capture the nuance:',
    '- CONTINUES: The new fact is a direct continuation of the narrative or thought process of the source fact.',
    '- ELABORATES: The new fact provides more detail, specifics, or evidence for the source fact.',
    '- EXPLAINS: The new fact provides the reason, cause, or justification for the source fact.',
    '- CAUSES: The source fact leads to or causes the new fact (causality).',
    '- CONTRASTS_WITH: The new fact fundamentally opposes or provides a counter-argument to the source. (Do NOT use for complementary views).',
    '- IS_A: Hierarchical relationship (e.g., "Dog" IS_A "Mammal").',
    '- HAS_PART: Meronymy relationship.',
    '- MENTIONS: Weak relationship, use only if no stronger specific relationship exists.',
    '- [CUSTOM]: Create any precise relationship type that fits (e.g., "MOTIVATED_BY", "REQUESTS", "REJECTS", "SUPPORTED_BY", "PRECEDES", "FOLLOWS").',
    '',
    '## Strict Rules:',
    '1. **Narrative Continuity**: If facts seem to be part of a sequential story or argument, favor `CONTINUES`, `ELABORATES`, or custom sequential types.',
    '2. **No False Contrasts**: Do NOT use `CONTRASTS` for facts that are different aspects of the same topic or complementary hypotheses. Only use it for direct contradictions.',
    '3. **No Self-Links**: Do not link a fact to itself.',
    '4. **New Facts Only**: Each link MUST involve at least one NEW fact (from the NEW_FACTS list).',
    '5. **Precision & Creativity**: Do not limit yourself to the examples. Use any short, precise phrase that captures the essence of the connection.',
    `6. **Quantity**: Keep at most ${input.maxAutoLinksPerFact} links per NEW fact.`,
    '',
    '## Input Data:',
    `NEW_FACTS=${JSON.stringify(input.newFacts)}`,
    `CANDIDATE_FACTS=${JSON.stringify(input.candidateFacts)}`,
    `MANUAL_LINKS=${JSON.stringify(input.manualLinks)}`,
    '',
    '## Output Format:',
    'Return ONLY TOON (Token-Oriented Object Notation), no markdown and no explanations.',
    'Use this exact table schema:',
    'links[N,]{fromFactId,toFactId,relation,confidence}:',
    '<fromFactId>,<toFactId>,<relation>,<confidence>',
    'Where N is the exact number of rows. Use N=0 if there are no links.',
  ].join('\n');
}

export async function generateAutoLinks(
  input: LinkerInput,
  config: MemoryRuntimeConfig
): Promise<LinkSuggestion[]> {
  const display = getGlobalDisplay();
  const prompt = buildPrompt(input);
  const debugFlag = String(process.env.MEMORY_LINKER_DEBUG ?? '').trim().toLowerCase();
  const persistSuccessDebug = debugFlag === '1' || debugFlag === 'true' || debugFlag === 'full';

  if (display) {
    display.showMemoryLLMPrompt(prompt);
  }

  const provider = createProvider(config.linkerProvider);
  const linkerMessages = [
    {
      role: 'system' as const,
      content: 'Reply with TOON only. No markdown, no explanation.',
    },
    {
      role: 'user' as const,
      content: prompt,
    },
  ];
  const linkerConfig = {
    model: config.linkerModel,
    temperature: config.linkerTemperature,
    maxTokens: config.linkerMaxTokens,
    reasoning: 'off' as const,
    stream: true,
  };
  let requestPreview: unknown = undefined;
  if (provider.buildRequest) {
    try {
      requestPreview = provider.buildRequest(linkerMessages, linkerConfig);
    } catch {
      // best effort debug info only
    }
  }

  if (display) {
    display.startMemoryLLMResponse();
  }

  let fullContent = '';
  let fullReasoning = '';
  const eventCounts: Record<string, number> = {};
  if (!provider.streamEvents) {
    throw new Error(`Provider ${config.linkerProvider} does not support streaming.`);
  }

  const stream = await provider.streamEvents(linkerMessages, linkerConfig);

  for await (const event of stream) {
    eventCounts[event.type] = (eventCounts[event.type] ?? 0) + 1;
    if (event.type === 'reasoning.delta' && event.delta) {
      fullReasoning += event.delta;
    }
    if (event.type === 'text.delta' && event.delta) {
      const delta = event.delta;
      fullContent += delta;
      if (display) {
        display.writeMemoryLLMDelta(delta);
      }
    }
  }

  // Some providers/models occasionally finish with empty streamed text.
  // Fallback to non-stream complete() to recover the final payload.
  if (!normalizeRawResponse(fullContent) || looksLikeIncompleteToon(fullContent)) {
    const completion = await provider.complete(
      linkerMessages,
      {
        ...linkerConfig,
        stream: false,
      }
    );
    const completionText = completion.content ?? '';
    if (normalizeRawResponse(completionText)) {
      fullContent = completionText;
    }
    eventCounts['fallback.complete'] = 1;
  }

  if (display) {
    display.endMemoryLLMResponse();
  }

  let rawLinks: Array<Record<string, unknown>> = [];
  try {
    rawLinks = parseLinkerRawResponse(fullContent);
    await writeLinkerDebugSnapshot(
      {
        stage: 'parsed',
        provider: config.linkerProvider,
        model: config.linkerModel,
        requestPreview,
        prompt,
        rawResponse: fullContent,
        rawReasoningTail: fullReasoning.slice(-6000),
        parsedRows: rawLinks,
        eventCounts,
      },
      persistSuccessDebug
    );
  } catch (parseError) {
    let recoveredAfterRetry = false;
    // Retry parse from non-stream complete if we have not retried yet or if stream looked incomplete.
    if (!eventCounts['fallback.complete'] || looksLikeIncompleteToon(fullContent)) {
      const completion = await provider.complete(
        linkerMessages,
        {
          ...linkerConfig,
          stream: false,
        }
      );
      const completionText = completion.content ?? '';
      eventCounts['fallback.complete.retry'] = (eventCounts['fallback.complete.retry'] ?? 0) + 1;
      if (normalizeRawResponse(completionText)) {
        try {
          rawLinks = parseLinkerRawResponse(completionText);
          fullContent = completionText;
          recoveredAfterRetry = true;
          await writeLinkerDebugSnapshot(
            {
              stage: 'parsed_after_retry',
              provider: config.linkerProvider,
              model: config.linkerModel,
              requestPreview,
              prompt,
              rawResponse: fullContent,
              rawReasoningTail: fullReasoning.slice(-6000),
              parsedRows: rawLinks,
              eventCounts,
            },
            true
          );
        } catch {
          // keep original parse error path below
        }
      }
      if (isZeroLinksShorthand(fullContent)) recoveredAfterRetry = true;
    }

    if (recoveredAfterRetry || isZeroLinksShorthand(fullContent)) {
      // recovered in retry path
    } else {
    const debugPath = await writeLinkerDebugSnapshot(
      {
        stage: 'parse_error',
        provider: config.linkerProvider,
        model: config.linkerModel,
        requestPreview,
        prompt,
        rawResponse: fullContent,
        rawReasoningTail: fullReasoning.slice(-6000),
        eventCounts,
        error: parseError instanceof Error ? parseError.message : String(parseError),
      },
      true
    );
    const reason = parseError instanceof Error ? parseError.message : String(parseError);
    const where = debugPath ? ` Debug snapshot: ${debugPath}` : '';
    throw new Error(`Failed to parse linker response as TOON or JSON (${reason}).${where}`);
    }
  }

  if (!normalizeRawResponse(fullContent)) {
    const debugPath = await writeLinkerDebugSnapshot(
      {
        stage: 'empty_response',
        provider: config.linkerProvider,
        model: config.linkerModel,
        requestPreview,
        prompt,
        rawResponse: fullContent,
        parsedRows: rawLinks,
        eventCounts,
      },
      true
    );
    if (display) {
      const suffix = debugPath ? ` (${debugPath})` : '';
      display.showMemoryStep(`Linker returned empty content, interpreted as 0 links${suffix}`);
    }
  }

  const links: LinkSuggestion[] = [];
  for (const item of rawLinks) {
    const fromFactId = String(item.fromFactId ?? '').trim();
    const toFactId = String(item.toFactId ?? '').trim();
    const relation = String(item.relation ?? '').trim();
    const confidenceRaw = String(item.confidence ?? '0.5').trim();
    const confidence = clamp01(
      Number.isFinite(Number(confidenceRaw))
        ? Number(confidenceRaw)
        : Number.parseFloat(confidenceRaw.replace(/[^\d.+-]/g, ''))
    );
    if (!fromFactId || !toFactId || !relation) continue;
    if (fromFactId === toFactId) continue;
    links.push({ fromFactId, toFactId, relation, confidence });
  }

  return links;
}
