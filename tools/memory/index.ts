import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  getMemoryRuntime,
  type CandidateSelectionOptions,
  type IngestTextInput,
  type MemoryRuntimeConfig,
} from '../../src/memory_system/index.js';
import { resolveProjectMemoryCategory } from '../../src/memory_system/projectCategory.js';
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
import { getContentMemoryService, ContentMemoryService, type ContentSearchOptions } from '../../src/content_memory/service.js';
import { CombinedMemoryHintsService, type CombinedHintsOptions } from '../../src/combined_memory_hints/service.js';
import { AgentLoader } from '../../src/loaders/AgentLoader.js';
import { ToolLoader } from '../../src/loaders/ToolLoader.js';
import { getEffectiveMemoryCategories } from '../../src/core/memoryToolDocs.js';
import { RealtimeAdvisorStore } from '../../src/interfaces/realtime-advisor/store.js';

interface MemorySearchOptions {
  mode?: 'auto' | 'top-k';
  count?: number;
  phraseWeighting?: 'llm' | 'embedding';
}

interface MemorySearchInput extends MemorySearchOptions {
  query?: string;
  text?: string;
}

interface NotesSearchOptions extends ContentSearchOptions {}

interface MemoryAddOptions {
  retrievalHints?: string[] | string;
  agentExclusive?: boolean;
  projectExclusive?: boolean;
  /** @deprecated Use agentExclusive instead. */
  exclusive?: boolean;
}

interface MemoryAddInput extends MemoryAddOptions {
  text?: string;
  content?: string;
  topics?: string[];
}

interface MemorySideChannelPayload {
  searches?: Array<{
    factIds: string[];
    text: string;
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
    embeddingProvider: process.env.MEMORY_EMBEDDING_PROVIDER === 'openrouter'
      ? 'openrouter'
      : process.env.MEMORY_EMBEDDING_PROVIDER === 'google'
        ? 'google'
        : process.env.MEMORY_EMBEDDING_PROVIDER === 'ollama'
          ? 'ollama'
          : undefined,
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

function resolveMemoryAddCategory(options?: MemoryAddOptions): string | null {
  const agentExclusive = Boolean(options?.agentExclusive || options?.exclusive);
  const projectExclusive = Boolean(options?.projectExclusive);
  if (agentExclusive && projectExclusive) {
    throw new Error('memory.add options cannot set both agentExclusive and projectExclusive.');
  }
  if (projectExclusive) {
    const category = process.env.TELOS_MEMORY_PROJECT_CATEGORY
      || resolveProjectMemoryCategory(true);
    if (!category) {
      throw new Error('memory.add({ projectExclusive: true }) could not resolve a project memory category.');
    }
    return category;
  }
  return agentExclusive ? (process.env.TELOS_AGENT_NAME || null) : null;
}

function resolveCandidateSelection(options?: MemorySearchOptions): CandidateSelectionOptions {
  const count = typeof options?.count === 'number' && Number.isFinite(options.count)
    ? Math.max(1, Math.floor(options.count))
    : 5;
  return options?.mode === 'top-k'
    ? { mode: 'top-k', topK: count }
    : { mode: 'auto', maxCandidates: count, topK: count };
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
    return MemoryNoteHandle.from(detail);
  }

  async append(text: string): Promise<MemoryNoteHandle> {
    const detail = await append({ note: this.id, text });
    return MemoryNoteHandle.from(detail);
  }

  async patch(searchText: string, replace: string): Promise<MemoryNoteHandle> {
    const detail = await patch({ note: this.id, search: searchText, replace });
    return MemoryNoteHandle.from(detail);
  }

  async remove(): Promise<MemoryNoteHandle> {
    const detail = await remove(this.id);
    return MemoryNoteHandle.from(detail);
  }

  async archive(archived = true): Promise<MemoryNoteHandle> {
    const detail = await archive(this.id, archived);
    return MemoryNoteHandle.from(detail);
  }

  async pin(pinned = true): Promise<MemoryNoteHandle> {
    const detail = await pin(this.id, pinned);
    return MemoryNoteHandle.from(detail);
  }

  async restore(): Promise<MemoryNoteHandle> {
    const detail = await restore(this.id);
    return MemoryNoteHandle.from(detail);
  }

  async itemAdd(text: string, checked = false): Promise<MemoryNoteHandle> {
    const detail = await itemAdd(this.id, text, checked);
    return MemoryNoteHandle.from(detail);
  }

  async itemCheck(item: string, checked = true): Promise<MemoryNoteHandle> {
    const detail = await itemCheck(this.id, item, checked);
    return MemoryNoteHandle.from(detail);
  }

  async itemRemove(item: string): Promise<MemoryNoteHandle> {
    const detail = await itemRemove(this.id, item);
    return MemoryNoteHandle.from(detail);
  }
}

function toHandle(note: NoteSummary | NoteDetail): MemoryNoteHandle {
  return new MemoryNoteHandle(note);
}

function normalizeRetrievalHints(options?: MemoryAddOptions & { topics?: string[] }): string[] {
  const explicit = Array.isArray(options?.retrievalHints)
    ? options.retrievalHints
    : typeof options?.retrievalHints === 'string'
      ? [options.retrievalHints]
      : [];
  const topics = Array.isArray(options?.topics) ? options.topics : [];
  return [...new Set([...explicit, ...topics].map(String).map((value) => value.trim()).filter(Boolean))];
}

function normalizeMemoryAddInput(
  input: string | MemoryAddInput,
  options?: MemoryAddOptions,
): { text: string; options: MemoryAddOptions & { topics?: string[] } } {
  const merged = typeof input === 'string' ? { ...options } : { ...options, ...input };
  const text = (typeof input === 'string' ? input : input.text ?? input.content ?? '').trim();
  if (!text) throw new Error('memory.add requires non-empty text or content.');
  return { text, options: merged };
}

export async function add(input: string | MemoryAddInput, options?: MemoryAddOptions) {
  const normalized = normalizeMemoryAddInput(input, options);
  const runtime = await ensureRuntime();
  const exclusiveToAgentName = resolveMemoryAddCategory(normalized.options);
  return runtime.queue.enqueue({
    text: normalized.text,
    retrievalHints: normalizeRetrievalHints(normalized.options),
    exclusiveToAgentName,
  });
}

export async function search(input: string | MemorySearchInput, options?: MemorySearchOptions): Promise<string> {
  const merged = typeof input === 'string' ? { ...options, query: input } : { ...options, ...input };
  const query = String(merged.query || merged.text || '').trim();
  if (!query) throw new Error('memory.search requires a non-empty query.');
  const runtime = await ensureRuntime();
  const result = await runtime.service.search(query, {
    candidateSelection: resolveCandidateSelection(merged),
    excludeFactIds: parseExcludedFactIds(),
    agentName: process.env.TELOS_AGENT_NAME,
    categories: parseCategoriesFromEnv(),
    includeUncategorized: parseIncludeUncategorizedFromEnv(),
    categoryMultipliers: parseCategoryMultipliersFromEnv(),
    fallbackCategory: parseFallbackCategoryFromEnv(),
    queryPhraseWeightingMode: merged.phraseWeighting,
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

function defaultContextOptions(agent: Awaited<ReturnType<AgentLoader['loadByName']>>): CombinedHintsOptions {
  const memory = agent?.config.memory;
  const topK = Math.max(1, Math.floor(memory?.autoHints?.topK ?? 5));
  const memoryCandidateSelection: CandidateSelectionOptions = {
    mode: 'auto',
    topK,
    minCandidates: 2,
    maxCandidates: Math.max(topK, 8),
  };
  const contentCandidateSelection: CandidateSelectionOptions = {
    mode: 'top-k',
    topK: 3,
    minCandidates: 2,
    maxCandidates: 3,
  };
  const sentenceSelection: CandidateSelectionOptions = {
    mode: 'top-k',
    topK: 4,
    minCandidates: 2,
    maxCandidates: 4,
  };
  return {
    queryKind: 'user',
    maxQueryLength: 4000,
    queryPhraseWeightingMode: 'embedding',
    memory: {
      weight: 1,
      maxDepth: memory?.searchMaxDepth ?? 3,
      beamWidth: memory?.searchBeamWidth ?? 8,
      maxChains: memory?.searchMaxChains ?? 8,
      overallEmbeddingWeight: memory?.overallEmbeddingWeight ?? 0.35,
      phraseAggregationMode: memory?.searchDefaultAggregationMode ?? 'max',
      includeUncategorized: memory?.includeUncategorized,
      fallbackCategory: memory?.fallbackCategory,
      candidateSelection: memoryCandidateSelection,
    },
    notes: {
      weight: 0.8,
      recencyBias: 0,
      candidateSelection: contentCandidateSelection,
      sentenceSelection,
    },
    conversations: {
      weight: 1,
      recencyBias: 0.5,
      candidateSelection: contentCandidateSelection,
      sentenceSelection,
    },
  };
}

/**
 * Retrieve the same formatted combined context used by automatic memory hints,
 * but for an agent-supplied query rather than the latest user message.
 */
export async function context(input: string | { query?: string; text?: string }): Promise<string> {
  const cleanQuery = String(typeof input === 'string' ? input : input?.query || input?.text || '').trim();
  if (!cleanQuery) throw new Error('memory.context(query) requires a non-empty query.');
  const agentName = String(process.env.TELOS_AGENT_NAME || '').trim();
  if (!agentName) throw new Error('memory.context(query) requires TELOS_AGENT_NAME.');

  const agentLoader = new AgentLoader();
  const agent = await agentLoader.loadByName(agentName);
  if (!agent) throw new Error(`memory.context(query) could not load agent ${agentName}.`);
  const toolLoader = new ToolLoader();
  const agentTools = await toolLoader.loadByNames(agent.config.tools || []);
  const effectiveCategories = getEffectiveMemoryCategories(agent, agentTools) || [];
  const categoryMultipliers = Object.fromEntries(
    effectiveCategories
      .filter((category) => typeof category.multiplier === 'number')
      .map((category) => [category.name, category.multiplier!]),
  );
  const identities = new RealtimeAdvisorStore(path.resolve(
    process.env.TELOS_REALTIME_ADVISOR_DATA_DIR || path.join(process.env.TELOS_PROJECT_ROOT || process.cwd(), 'data', 'realtime-advisor'),
  ));
  await identities.initialize();

  const result = await new CombinedMemoryHintsService().test({
    query: cleanQuery,
    agent,
    categories: effectiveCategories.map((category) => category.name),
    categoryMultipliers,
    identities: identities.listSpeakers().map((identity) => ({
      id: identity.id,
      name: identity.name,
      description: identity.description,
    })),
    options: defaultContextOptions(agent),
  });
  const memoryResult = result.memory as { surfacedFactIds?: unknown; text?: unknown } | undefined;
  const factIds = Array.isArray(memoryResult?.surfacedFactIds)
    ? memoryResult!.surfacedFactIds.map(String).filter(Boolean)
    : [];
  const memoryText = typeof memoryResult?.text === 'string' ? memoryResult.text : '';
  if (factIds.length > 0 || memoryText) {
    await appendSideChannel({ searches: [{ factIds, text: memoryText }] });
  }
  return typeof result.text === 'string' ? result.text : '';
}

async function listHandles(input?: NoteListInput): Promise<MemoryNoteHandle[]> {
  return (await list(input)).map(toHandle);
}

async function findHandles(query: string, input?: number | Omit<Exclude<NoteListInput, number | string>, 'query' | 'q'>): Promise<MemoryNoteHandle[]> {
  return (await find(query, input as any)).map(toHandle);
}

async function createNote(title: string, text: string): Promise<MemoryNoteHandle> {
  const detail = await put({ title, text, owner: 'system', createOnly: true });
  return toHandle(detail);
}

async function createChecklist(title: string, items: CreateListItems = []): Promise<MemoryNoteHandle> {
  const detail = await createList({ title, items, owner: 'system', createOnly: true });
  return toHandle(detail);
}

export const notes = {
  path(): string {
    return ContentMemoryService.notesPath();
  },
  async search(query = '', options?: NotesSearchOptions) {
    await getContentMemoryService().settleNotesVault();
    return getContentMemoryService().search('notes', query, {
      ...options,
      recencyBias: options?.recencyBias ?? 0,
    });
  },
  async import(noteId: string): Promise<string> {
    return getContentMemoryService().importNote(noteId);
  },
  async backup() {
    return getContentMemoryService().settleNotesVault();
  },
  /** @deprecated Obsidian notes are files. Use memory.notes.path(), edit markdown files directly, then search/import archives. */
  list: listHandles,
  /** @deprecated Use memory.notes.search(query, options?) for archived notes or search files under memory.notes.path() directly. */
  find: findHandles,
  /** @deprecated Create a markdown file under memory.notes.path(); Telos-created note filenames must contain TELOS. */
  create: createNote,
  /** @deprecated Create a markdown checklist file under memory.notes.path(); Telos-created note filenames must contain TELOS. */
  createList: createChecklist,
};

export const conversations = {
  transcript: {
    search(query = '', options?: ContentSearchOptions) {
      return getContentMemoryService().search('conversation_transcripts', query, {
        ...options,
        recencyBias: options?.recencyBias ?? 0.5,
      });
    },
  },
  context: {
    search(query = '', options?: Omit<ContentSearchOptions, 'transcriptLabel'>) {
      return getContentMemoryService().search('advisor_context', query, {
        ...options,
        recencyBias: options?.recencyBias ?? 0.5,
      });
    },
  },
};

export const __internals = {
  resolveMemoryAddCategory,
  normalizeMemoryAddInput,
  normalizeRetrievalHints,
};

function parseFallbackCategoryFromEnv(): string | undefined {
  const raw = process.env.TELOS_MEMORY_FALLBACK_CATEGORY;
  return typeof raw === 'string' && raw.trim() ? raw.trim() : undefined;
}
