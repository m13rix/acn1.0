import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  getMemoryRuntime,
  type CandidateSelectionOptions,
  type IngestTextInput,
  type MemoryRuntimeConfig,
} from '../../src/memory_system/index.js';
import {
  list,
  find,
  get,
  put,
  append,
  patch,
  remove,
  archive,
  pin,
  restore,
  createList,
  itemAdd,
  itemCheck,
  itemRemove,
  type NoteDetail,
  type NoteSummary,
} from '../../src/memory_notes/index.js';

interface MemorySearchOptions {
  mode?: 'auto' | 'top-k';
  count?: number;
  phraseWeighting?: 'llm' | 'embedding';
}

interface MemoryAddOptions {
  retrievalHints?: string[];
  exclusive?: boolean;
}

interface MemorySideChannelPayload {
  searches?: Array<{
    factIds: string[];
    text: string;
  }>;
  noteEvents?: Array<{
    action: 'upsert' | 'remove';
    noteId: string;
    sourceLabel?: string;
  }>;
}

type NoteListInput = number | string | {
  limit?: number;
  q?: string;
  query?: string;
  kind?: 'note' | 'list';
  archived?: boolean;
  trashed?: boolean;
};

type CreateListItems = Array<string | { text: string; checked?: boolean }>;

let configKey: string | null = null;

function parseNumber(name: string): number | undefined {
  const raw = process.env[name];
  if (!raw || !raw.trim()) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

function readConfigFromEnv(): Partial<MemoryRuntimeConfig> & {
  queue?: { spacingSeconds?: number };
  notesSync?: { enabled?: boolean; stableDelayMinutes?: number; pollIntervalSeconds?: number };
} {
  const aggregationMode = process.env.MEMORY_SEARCH_DEFAULT_AGGREGATION_MODE;
  const phraseWeightingMode = process.env.MEMORY_SEARCH_DEFAULT_PHRASE_WEIGHTING_MODE;
  const candidateMode = process.env.MEMORY_SEARCH_DEFAULT_CANDIDATE_MODE;

  return {
    table: process.env.MEMORY_TABLE,
    mercuryProvider: process.env.MEMORY_MERCURY_PROVIDER,
    mercuryModel: process.env.MEMORY_MERCURY_MODEL,
    mercuryTemperature: parseNumber('MEMORY_MERCURY_TEMPERATURE'),
    mercuryMaxTokens: parseNumber('MEMORY_MERCURY_MAX_TOKENS'),
    embeddingModel: process.env.MEMORY_EMBEDDING_MODEL,
    linkCandidatePoolMax: parseNumber('MEMORY_LINK_CANDIDATE_POOL_MAX'),
    maxAutoLinksPerFact: parseNumber('MEMORY_MAX_AUTO_LINKS_PER_FACT'),
    semanticMergeThreshold: parseNumber('MEMORY_SEMANTIC_MERGE_THRESHOLD'),
    overallEmbeddingWeight: parseNumber('MEMORY_OVERALL_EMBEDDING_WEIGHT'),
    searchDefaultAggregationMode: aggregationMode === 'sum' ? 'sum' : undefined,
    searchDefaultPhraseWeightingMode: phraseWeightingMode === 'embedding' ? 'embedding' : undefined,
    searchDefaultCandidateMode: candidateMode === 'threshold'
      ? 'threshold'
      : candidateMode === 'range'
        ? 'range'
        : candidateMode === 'top-k'
          ? 'top-k'
          : undefined,
    searchDefaultTopK: parseNumber('MEMORY_SEARCH_DEFAULT_TOP_K'),
    searchDefaultThreshold: parseNumber('MEMORY_SEARCH_DEFAULT_THRESHOLD'),
    searchDefaultRangeMin: parseNumber('MEMORY_SEARCH_DEFAULT_RANGE_MIN'),
    searchDefaultRangeMax: parseNumber('MEMORY_SEARCH_DEFAULT_RANGE_MAX'),
    searchMaxDepth: parseNumber('MEMORY_SEARCH_MAX_DEPTH'),
    searchBeamWidth: parseNumber('MEMORY_SEARCH_BEAM_WIDTH'),
    searchMaxChains: parseNumber('MEMORY_SEARCH_MAX_CHAINS'),
    queue: {
      spacingSeconds: parseNumber('MEMORY_QUEUE_SPACING_SECONDS'),
    },
    notesSync: {
      enabled: process.env.MEMORY_NOTES_SYNC_ENABLED === 'false' ? false : undefined,
      stableDelayMinutes: parseNumber('MEMORY_NOTES_SYNC_STABLE_DELAY_MINUTES'),
      pollIntervalSeconds: parseNumber('MEMORY_NOTES_SYNC_POLL_INTERVAL_SECONDS'),
    },
  };
}

async function ensureRuntime() {
  const config = readConfigFromEnv();
  const nextKey = JSON.stringify(config);
  if (configKey !== nextKey) {
    configKey = nextKey;
  }
  return getMemoryRuntime(config);
}

function getSideChannelPath(): string {
  return path.join(process.cwd(), '.telos-memory.json');
}

async function appendSideChannel(update: MemorySideChannelPayload): Promise<void> {
  const sideChannelPath = getSideChannelPath();
  const current: MemorySideChannelPayload = await readFile(sideChannelPath, 'utf8')
    .then((raw) => JSON.parse(raw) as MemorySideChannelPayload)
    .catch(() => ({}));

  const next: MemorySideChannelPayload = {
    searches: [...(current.searches || []), ...(update.searches || [])],
    noteEvents: [...(current.noteEvents || []), ...(update.noteEvents || [])],
  };

  await mkdir(path.dirname(sideChannelPath), { recursive: true });
  await writeFile(sideChannelPath, JSON.stringify(next, null, 2) + '\n', 'utf8');
}

function parseExcludedFactIds(): string[] {
  try {
    const raw = process.env.TELOS_MEMORY_EXCLUDE_FACT_IDS;
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.map((factId) => String(factId || '').trim()).filter(Boolean)
      : [];
  } catch {
    return [];
  }
}

function parseCategoriesFromEnv(): string[] | undefined {
  try {
    const raw = process.env.TELOS_MEMORY_CATEGORIES;
    if (!raw) return undefined;
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(String).filter(Boolean) : undefined;
  } catch {
    return undefined;
  }
}

function parseCategoryMultipliersFromEnv(): Record<string, number> | undefined {
  try {
    const raw = process.env.TELOS_MEMORY_CATEGORY_MULTIPLIERS;
    if (!raw) return undefined;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return undefined;
    const result: Record<string, number> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === 'number') result[key] = value;
    }
    return Object.keys(result).length > 0 ? result : undefined;
  } catch {
    return undefined;
  }
}

function parseIncludeUncategorizedFromEnv(): boolean | undefined {
  const raw = process.env.TELOS_MEMORY_INCLUDE_UNCATEGORIZED;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  return undefined;
}

function resolveCandidateSelection(options?: MemorySearchOptions): CandidateSelectionOptions {
  const count = typeof options?.count === 'number' && Number.isFinite(options.count)
    ? Math.max(1, Math.floor(options.count))
    : 5;
  return options?.mode === 'top-k'
    ? { mode: 'top-k', topK: count }
    : { mode: 'auto', maxCandidates: count, topK: count };
}

function noteEventActionFromDetail(detail: NoteSummary | NoteDetail, kind: 'upsert' | 'remove'): MemorySideChannelPayload['noteEvents'][number] {
  return {
    action: kind,
    noteId: detail.id,
    sourceLabel: detail.logicalTitle || detail.title,
  };
}

class MemoryNoteHandle {
  id: string;
  serverId?: string | null;
  title: string;
  logicalTitle: string;
  rawTitle: string;
  kind: 'note' | 'list';
  owner: 'system' | 'owner' | 'user';
  archived: boolean;
  trashed: boolean;
  pinned: boolean;
  createdAt?: string | null;
  updatedAt?: string | null;
  preview: string;
  text?: string;
  items?: NoteDetail['items'];

  constructor(note: NoteSummary | NoteDetail) {
    this.id = note.id;
    this.serverId = note.serverId;
    this.title = note.title;
    this.logicalTitle = note.logicalTitle;
    this.rawTitle = note.rawTitle;
    this.kind = note.kind;
    this.owner = note.owner;
    this.archived = note.archived;
    this.trashed = note.trashed;
    this.pinned = note.pinned;
    this.createdAt = note.createdAt;
    this.updatedAt = note.updatedAt;
    this.preview = note.preview;
    if ('text' in note) {
      this.text = note.text;
      this.items = note.items;
    }
  }

  private static from(note: NoteSummary | NoteDetail): MemoryNoteHandle {
    return new MemoryNoteHandle(note);
  }

  async get(): Promise<MemoryNoteHandle> {
    return MemoryNoteHandle.from(await get(this.id));
  }

  async put(text: string): Promise<MemoryNoteHandle> {
    const detail = await put({ note: this.id, title: this.logicalTitle || this.title, text });
    await appendSideChannel({ noteEvents: [noteEventActionFromDetail(detail, 'upsert')] });
    return MemoryNoteHandle.from(detail);
  }

  async append(text: string): Promise<MemoryNoteHandle> {
    const detail = await append({ note: this.id, text });
    await appendSideChannel({ noteEvents: [noteEventActionFromDetail(detail, 'upsert')] });
    return MemoryNoteHandle.from(detail);
  }

  async patch(searchText: string, replace: string): Promise<MemoryNoteHandle> {
    const detail = await patch({ note: this.id, search: searchText, replace });
    await appendSideChannel({ noteEvents: [noteEventActionFromDetail(detail, 'upsert')] });
    return MemoryNoteHandle.from(detail);
  }

  async remove(): Promise<MemoryNoteHandle> {
    const detail = await remove(this.id);
    await appendSideChannel({ noteEvents: [noteEventActionFromDetail(detail, 'remove')] });
    return MemoryNoteHandle.from(detail);
  }

  async archive(archived = true): Promise<MemoryNoteHandle> {
    const detail = await archive(this.id, archived);
    await appendSideChannel({ noteEvents: [noteEventActionFromDetail(detail, archived ? 'remove' : 'upsert')] });
    return MemoryNoteHandle.from(detail);
  }

  async pin(pinned = true): Promise<MemoryNoteHandle> {
    const detail = await pin(this.id, pinned);
    await appendSideChannel({ noteEvents: [noteEventActionFromDetail(detail, 'upsert')] });
    return MemoryNoteHandle.from(detail);
  }

  async restore(): Promise<MemoryNoteHandle> {
    const detail = await restore(this.id);
    await appendSideChannel({ noteEvents: [noteEventActionFromDetail(detail, 'upsert')] });
    return MemoryNoteHandle.from(detail);
  }

  async itemAdd(text: string, checked = false): Promise<MemoryNoteHandle> {
    const detail = await itemAdd(this.id, text, checked);
    await appendSideChannel({ noteEvents: [noteEventActionFromDetail(detail, 'upsert')] });
    return MemoryNoteHandle.from(detail);
  }

  async itemCheck(item: string, checked = true): Promise<MemoryNoteHandle> {
    const detail = await itemCheck(this.id, item, checked);
    await appendSideChannel({ noteEvents: [noteEventActionFromDetail(detail, 'upsert')] });
    return MemoryNoteHandle.from(detail);
  }

  async itemRemove(item: string): Promise<MemoryNoteHandle> {
    const detail = await itemRemove(this.id, item);
    await appendSideChannel({ noteEvents: [noteEventActionFromDetail(detail, 'upsert')] });
    return MemoryNoteHandle.from(detail);
  }
}

function toHandle(note: NoteSummary | NoteDetail): MemoryNoteHandle {
  return new MemoryNoteHandle(note);
}

export async function add(text: string, options?: MemoryAddOptions) {
  const runtime = await ensureRuntime();
  const exclusiveToAgentName = options?.exclusive ? (process.env.TELOS_AGENT_NAME || null) : null;
  return runtime.queue.enqueue({
    text,
    retrievalHints: Array.isArray(options?.retrievalHints) ? options?.retrievalHints : [],
    exclusiveToAgentName,
  });
}

export async function search(query: string, options?: MemorySearchOptions): Promise<string> {
  const runtime = await ensureRuntime();
  const result = await runtime.service.search(query, {
    candidateSelection: resolveCandidateSelection(options),
    excludeFactIds: parseExcludedFactIds(),
    agentName: process.env.TELOS_AGENT_NAME,
    categories: parseCategoriesFromEnv(),
    includeUncategorized: parseIncludeUncategorizedFromEnv(),
    categoryMultipliers: parseCategoryMultipliersFromEnv(),
    fallbackCategory: parseFallbackCategoryFromEnv(),
    queryPhraseWeightingMode: options?.phraseWeighting,
  });

  if (result.surfacedFactIds.length > 0 || result.text) {
    await appendSideChannel({
      searches: [{
        factIds: result.surfacedFactIds,
        text: result.text,
      }],
    });
  }

  return result.text || '';
}

async function listHandles(input?: NoteListInput): Promise<MemoryNoteHandle[]> {
  return (await list(input)).map(toHandle);
}

async function findHandles(query: string, input?: number | Omit<Exclude<NoteListInput, number | string>, 'query' | 'q'>): Promise<MemoryNoteHandle[]> {
  return (await find(query, input as any)).map(toHandle);
}

async function createNote(title: string, text: string): Promise<MemoryNoteHandle> {
  const detail = await put({ title, text, owner: 'system', createOnly: true });
  await appendSideChannel({ noteEvents: [noteEventActionFromDetail(detail, 'upsert')] });
  return toHandle(detail);
}

async function createChecklist(title: string, items: CreateListItems = []): Promise<MemoryNoteHandle> {
  const detail = await createList({ title, items, owner: 'system', createOnly: true });
  await appendSideChannel({ noteEvents: [noteEventActionFromDetail(detail, 'upsert')] });
  return toHandle(detail);
}

export const notes = {
  list: listHandles,
  find: findHandles,
  create: createNote,
  createList: createChecklist,
};

function parseFallbackCategoryFromEnv(): string | undefined {
  const raw = process.env.TELOS_MEMORY_FALLBACK_CATEGORY;
  return typeof raw === 'string' && raw.trim() ? raw.trim() : undefined;
}
