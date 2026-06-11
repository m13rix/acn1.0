import * as lancedb from '@lancedb/lancedb';
import { randomUUID } from 'crypto';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { cosineSimilarity, embedBatch, embedText, normalizeEmbeddingVectorUnit, vectorSubtract } from './embeddings.js';
import {
  appendMemoryDebugEvent,
  createMemoryDebugTrace,
  finalizeMemoryDebugTrace,
  summarizeText,
  type MemoryDebugLogger,
  type MemoryDebugTrace,
} from './debug.js';
import { extractSentencePhrases, flattenPhraseSet, mergePhraseSets, type PhraseType } from './phrases.js';
import { generateAutoLinks, generateProceduralLinks } from './linker.js';
import { normalizeMemoryText, weightQueryPhrases } from './mercury.js';
import {
  analyzeAutoCandidateSelection,
  analyzeAnchorRescue,
  resolveCandidateSelection,
  scoreSeedFacts,
  searchGraphChains,
  selectSeedFacts,
  type IndexedFactRecord,
  type SearchQueryVectors,
} from './search.js';
import { analyzeWithStanza, type StanzaTextAnnotation } from './stanzaRuntime.js';
import { MemoryStore } from './store.js';
import type {
  CandidateSelectionOptions,
  EmbeddedPhraseRecord,
  FactRecord,
  IngestTextInput,
  IngestTextResult,
  LinkRecord,
  MemoryLinkSuggestion,
  MemoryRuntimeConfig,
  PhraseAggregationMode,
  QueryPhraseWeightingMode,
  PhraseRecordSet,
  QueryPhraseCandidate,
  RetrievalHintRecord,
  SearchOptions,
  SearchResult,
  SeedFactScore,
} from './types.js';
import { DEFAULT_MEMORY_CONFIG } from './types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MEMORY_DATA_DIR = join(__dirname, '..', '..', 'data', 'memory');

interface MemoryItemDraft {
  id?: string;
  text: string;
  language: 'en' | 'ru';
  parserMode: 'constituency' | 'ud';
  constituency: string | null;
  dependencies: StanzaTextAnnotation['sentences'][number]['dependencies'];
  phraseTexts: {
    np: string[];
    vp: string[];
    adjp: string[];
  };
  createdAt?: number;
  updatedAt?: number;
}

interface EmbeddedMemoryItem {
  id: string;
  text: string;
  language: 'en' | 'ru';
  parserMode: 'constituency' | 'ud';
  constituency: string | null;
  dependencies: StanzaTextAnnotation['sentences'][number]['dependencies'];
  globalEmbedding: number[];
  phrases: PhraseRecordSet;
  createdAt: number;
  updatedAt: number;
}

interface LegacyFactRow {
  id: string;
  text: string;
  createdAt: number;
  updatedAt: number;
}

interface LegacyLinkRow {
  id: string;
  fromFactId: string;
  toFactId: string;
  relation: string;
  confidence: number;
  createdAt: number;
  updatedAt: number;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function normalizeRelation(relation: string): string {
  return relation.trim().toLowerCase().replace(/\s+/g, ' ');
}

function linkKey(fromFactId: string, toFactId: string, relation: string): string {
  return `${fromFactId}::${toFactId}::${normalizeRelation(relation)}`;
}

function ensureNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${field} must be a non-empty string.`);
  }
  return value.trim();
}

function normalizeCategory(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed.toLocaleLowerCase() : null;
}

function buildAllowedCategories(agentName: string | null, extraCategories: string[] | undefined): Set<string> {
  const set = new Set<string>();
  if (agentName) set.add(agentName);
  if (Array.isArray(extraCategories)) {
    for (const cat of extraCategories) {
      const normalized = normalizeCategory(cat);
      if (normalized) set.add(normalized);
    }
  }
  return set;
}

function isRecordVisibleToCategories(
  exclusiveToAgentName: string | null | undefined,
  allowedCategories: Set<string>,
  includeUncategorized: boolean,
  fallbackCategory?: string | null,
): boolean {
  const normalizedOwner = normalizeCategory(exclusiveToAgentName);
  if (!normalizedOwner) {
    if (includeUncategorized) return true;
    if (fallbackCategory) return allowedCategories.has(fallbackCategory);
    return false;
  }
  return allowedCategories.has(normalizedOwner);
}

function resolveInt(value: unknown, fallback: number, minimum = 1): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(minimum, Math.floor(value));
}

function resolveFloat(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return value;
}

function createEmptyPhraseRecordSet(): PhraseRecordSet {
  return {
    np: [],
    vp: [],
    adjp: [],
  };
}

function resolveDebugTrace(trace: MemoryDebugTrace | undefined, operation: string): { trace: MemoryDebugTrace; log: MemoryDebugLogger } {
  if (trace) {
    return {
      trace,
      log: (scope, message, data) => appendMemoryDebugEvent(trace, scope, message, data),
    };
  }

  return createMemoryDebugTrace(operation);
}

function parseJson<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== 'string') return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function resolveConfig(input?: Partial<MemoryRuntimeConfig>): MemoryRuntimeConfig {
  const cfg = input ?? {};
  const mercuryProvider = typeof cfg.mercuryProvider === 'string' && cfg.mercuryProvider.trim()
    ? cfg.mercuryProvider.trim()
    : typeof cfg.linkerProvider === 'string' && cfg.linkerProvider.trim()
      ? cfg.linkerProvider.trim()
      : DEFAULT_MEMORY_CONFIG.mercuryProvider;
  const mercuryModel = typeof cfg.mercuryModel === 'string' && cfg.mercuryModel.trim()
    ? cfg.mercuryModel.trim()
    : typeof cfg.linkerModel === 'string' && cfg.linkerModel.trim()
      ? cfg.linkerModel.trim()
      : DEFAULT_MEMORY_CONFIG.mercuryModel;
  const mercuryTemperature = resolveFloat(
    cfg.mercuryTemperature ?? cfg.linkerTemperature,
    DEFAULT_MEMORY_CONFIG.mercuryTemperature,
  );
  const mercuryMaxTokens = resolveInt(
    cfg.mercuryMaxTokens ?? cfg.linkerMaxTokens,
    DEFAULT_MEMORY_CONFIG.mercuryMaxTokens,
  );
  const linkCandidatePoolMax = resolveInt(
    cfg.linkCandidatePoolMax ?? cfg.candidatePoolMax,
    DEFAULT_MEMORY_CONFIG.linkCandidatePoolMax,
  );
  const semanticMergeThreshold = clamp01(
    resolveFloat(cfg.semanticMergeThreshold ?? cfg.dedupeThreshold, DEFAULT_MEMORY_CONFIG.semanticMergeThreshold),
  );

  return {
    ...DEFAULT_MEMORY_CONFIG,
    table: typeof cfg.table === 'string' && cfg.table.trim() ? cfg.table.trim() : DEFAULT_MEMORY_CONFIG.table,
    mercuryProvider,
    mercuryModel,
    mercuryTemperature,
    mercuryMaxTokens,
    embeddingModel: typeof cfg.embeddingModel === 'string' && cfg.embeddingModel.trim()
      ? cfg.embeddingModel.trim()
      : DEFAULT_MEMORY_CONFIG.embeddingModel,
    linkCandidatePoolMax,
    maxAutoLinksPerFact: resolveInt(cfg.maxAutoLinksPerFact, DEFAULT_MEMORY_CONFIG.maxAutoLinksPerFact),
    semanticMergeThreshold,
    overallEmbeddingWeight: Math.max(0, resolveFloat(cfg.overallEmbeddingWeight, DEFAULT_MEMORY_CONFIG.overallEmbeddingWeight)),
    searchDefaultAggregationMode: cfg.searchDefaultAggregationMode === 'sum' ? 'sum' : DEFAULT_MEMORY_CONFIG.searchDefaultAggregationMode,
    searchDefaultPhraseWeightingMode: cfg.searchDefaultPhraseWeightingMode === 'embedding'
      ? 'embedding'
      : DEFAULT_MEMORY_CONFIG.searchDefaultPhraseWeightingMode,
    searchDefaultCandidateMode: cfg.searchDefaultCandidateMode === 'threshold'
      ? 'threshold'
      : cfg.searchDefaultCandidateMode === 'range'
        ? 'range'
        : DEFAULT_MEMORY_CONFIG.searchDefaultCandidateMode,
    searchDefaultTopK: resolveInt(cfg.searchDefaultTopK, DEFAULT_MEMORY_CONFIG.searchDefaultTopK),
    searchDefaultThreshold: resolveFloat(cfg.searchDefaultThreshold, DEFAULT_MEMORY_CONFIG.searchDefaultThreshold),
    searchDefaultRangeMin: resolveInt(cfg.searchDefaultRangeMin, DEFAULT_MEMORY_CONFIG.searchDefaultRangeMin),
    searchDefaultRangeMax: resolveInt(cfg.searchDefaultRangeMax, DEFAULT_MEMORY_CONFIG.searchDefaultRangeMax),
    searchMaxDepth: resolveInt(cfg.searchMaxDepth, DEFAULT_MEMORY_CONFIG.searchMaxDepth),
    searchBeamWidth: resolveInt(cfg.searchBeamWidth, DEFAULT_MEMORY_CONFIG.searchBeamWidth),
    searchMaxChains: resolveInt(cfg.searchMaxChains, DEFAULT_MEMORY_CONFIG.searchMaxChains),
  };
}

function normalizeWeightRowsFromScores(
  phraseCandidates: QueryPhraseCandidate[],
  scores: number[],
): Array<{ phrase: string; weight: number }> {
  if (phraseCandidates.length === 0) return [];

  const clamped = scores.map((score) => Math.max(0, Number.isFinite(score) ? score : 0));
  const total = clamped.reduce((sum, score) => sum + score, 0);
  const fallback = phraseCandidates.length > 0 ? 1 / phraseCandidates.length : 0;
  const weights = total > 0
    ? clamped.map((score) => score / total)
    : phraseCandidates.map(() => fallback);

  let running = 0;
  return phraseCandidates.map((phrase, index) => {
    const weight = index === phraseCandidates.length - 1
      ? clamp01(1 - running)
      : Number((weights[index] ?? 0).toFixed(4));
    if (index !== phraseCandidates.length - 1) {
      running += weight;
    }
    return {
      phrase: phrase.text,
      weight,
    };
  });
}

function phraseTextsForType(draft: MemoryItemDraft, type: PhraseType): string[] {
  return draft.phraseTexts[type];
}

function createHintRecord(
  factId: string,
  embeddedItem: EmbeddedMemoryItem,
  exclusiveToAgentName: string | null,
): RetrievalHintRecord {
  return {
    id: randomUUID(),
    factId,
    text: embeddedItem.text,
    language: embeddedItem.language,
    parserMode: embeddedItem.parserMode,
    globalEmbedding: embeddedItem.globalEmbedding,
    constituency: embeddedItem.constituency,
    dependencies: embeddedItem.dependencies,
    phrases: embeddedItem.phrases,
    exclusiveToAgentName,
    createdAt: embeddedItem.createdAt,
    updatedAt: embeddedItem.updatedAt,
  };
}

function normalizePhraseRecordSetInPlace(phrases: PhraseRecordSet): PhraseRecordSet {
  for (const type of ['np', 'vp', 'adjp'] as PhraseType[]) {
    for (const phrase of phrases[type]) {
      phrase.embedding = normalizeEmbeddingVectorUnit(phrase.embedding);
    }
  }
  return phrases;
}

async function readLegacyNamespace(namespace: string): Promise<{ facts: LegacyFactRow[]; links: LegacyLinkRow[] }> {
  const db = await lancedb.connect(MEMORY_DATA_DIR);
  const factsTableName = `${namespace}_facts`;
  const linksTableName = `${namespace}_links`;
  const tableNames = await db.tableNames();

  const facts: LegacyFactRow[] = [];
  const links: LegacyLinkRow[] = [];

  if (tableNames.includes(factsTableName)) {
    const factsTable = await db.openTable(factsTableName);
    const rows = await factsTable.query().toArray();
    for (const row of rows) {
      const id = String(row.id ?? '');
      const text = String(row.text ?? '');
      if (!id || !text) continue;
      facts.push({
        id,
        text,
        createdAt: Number(row.createdAt ?? Date.now()),
        updatedAt: Number(row.updatedAt ?? Date.now()),
      });
    }
  }

  if (tableNames.includes(linksTableName)) {
    const linksTable = await db.openTable(linksTableName);
    const rows = await linksTable.query().toArray();
    for (const row of rows) {
      const id = String(row.id ?? '');
      const fromFactId = String(row.fromFactId ?? '');
      const toFactId = String(row.toFactId ?? '');
      const relation = String(row.relation ?? '');
      if (!id || !fromFactId || !toFactId || !relation) continue;
      links.push({
        id,
        fromFactId,
        toFactId,
        relation,
        confidence: clamp01(Number(row.confidence ?? 0.7)),
        createdAt: Number(row.createdAt ?? Date.now()),
        updatedAt: Number(row.updatedAt ?? Date.now()),
      });
    }
  }

  return { facts, links };
}

export class MemoryService {
  private readonly config: MemoryRuntimeConfig;
  private readonly store: MemoryStore;
  private initialized = false;

  private facts: FactRecord[] = [];
  private hints: RetrievalHintRecord[] = [];
  private links: LinkRecord[] = [];
  private indexedFacts: IndexedFactRecord[] = [];
  private indexedFactsById = new Map<string, IndexedFactRecord>();

  constructor(config?: Partial<MemoryRuntimeConfig>) {
    this.config = resolveConfig(config);
    this.store = new MemoryStore(this.config.table);
  }

  getRuntimeConfig(): MemoryRuntimeConfig {
    return { ...this.config };
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    await this.store.initialize();
    await this.reloadIndex();
    this.initialized = true;
  }

  async getAllFacts(): Promise<FactRecord[]> {
    await this.initialize();
    return this.facts;
  }

  async getAllHints(): Promise<RetrievalHintRecord[]> {
    await this.initialize();
    return this.hints;
  }

  async getAllLinks(): Promise<LinkRecord[]> {
    await this.initialize();
    return this.links;
  }

  async ingestText(input: IngestTextInput, debugTrace?: MemoryDebugTrace): Promise<IngestTextResult> {
    await this.initialize();
    const { trace: localDebug, log: debug } = resolveDebugTrace(debugTrace, 'ingestText');

    const text = ensureNonEmptyString(input.text, 'text');
    const retrievalHints = Array.isArray(input.retrievalHints)
      ? input.retrievalHints
        .map((hint, index) => ensureNonEmptyString(hint, `retrievalHints[${index}]`))
      : [];
    const exclusiveToAgentName = normalizeCategory(input.exclusiveToAgentName);
    const sourceId = typeof input.sourceId === 'string' && input.sourceId.trim() ? input.sourceId.trim() : null;
    const sourceLabel = typeof input.sourceLabel === 'string' && input.sourceLabel.trim() ? input.sourceLabel.trim() : null;
    debug('memory.ingest.start', 'Starting text ingestion.', {
      textLength: text.length,
      retrievalHintCount: retrievalHints.length,
      exclusiveToAgentName,
      sourceId,
      sourceLabel,
      textPreview: summarizeText(text),
      retrievalHints: retrievalHints.map((hint) => summarizeText(hint, 400)),
    });

    const warnings: string[] = [];
    const normalized = await normalizeMemoryText(text, this.config, debug);
    debug('memory.ingest.normalized', 'Received normalized text.', {
      normalizedText: summarizeText(normalized, 4000),
    });
    const factDrafts = await this.analyzeIntoSentenceDrafts(normalized, 'en', debug, 'facts');
    if (factDrafts.length === 0) {
      throw new Error('Normalized text did not produce any standalone facts.');
    }
    debug('memory.ingest.fact_drafts', 'Prepared sentence-level fact drafts.', {
      count: factDrafts.length,
      drafts: factDrafts.map((draft) => ({
        text: draft.text,
        language: draft.language,
        parserMode: draft.parserMode,
        phrases: draft.phraseTexts,
      })),
    });

    const embeddedFacts = await this.embedDrafts(factDrafts, debug, 'facts');
    const factRecords: FactRecord[] = embeddedFacts.map((item) => ({
      id: item.id,
      text: item.text,
      language: item.language,
      parserMode: item.parserMode,
      globalEmbedding: item.globalEmbedding,
      constituency: item.constituency,
      dependencies: item.dependencies,
      phrases: item.phrases,
      exclusiveToAgentName,
      sourceId,
      sourceLabel,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
    }));
    debug('memory.ingest.facts_embedded', 'Generated fact embeddings.', {
      count: factRecords.length,
      facts: factRecords.map((fact) => ({
        id: fact.id,
        text: fact.text,
        phraseCounts: {
          np: fact.phrases.np.length,
          vp: fact.phrases.vp.length,
          adjp: fact.phrases.adjp.length,
        },
      })),
    });

    const hintTemplates = await this.embedRetrievalHintTemplates(retrievalHints, debug);
    const hintRecords: RetrievalHintRecord[] = [];
    for (const fact of factRecords) {
      for (const hintTemplate of hintTemplates) {
        hintRecords.push(createHintRecord(fact.id, hintTemplate, exclusiveToAgentName));
      }
    }
    debug('memory.ingest.hints_embedded', 'Prepared retrieval hint templates.', {
      templateCount: hintTemplates.length,
      attachedHintCount: hintRecords.length,
      templates: hintTemplates.map((hint) => ({
        text: hint.text,
        language: hint.language,
        parserMode: hint.parserMode,
        phrases: {
          np: hint.phrases.np.map((item) => item.text),
          vp: hint.phrases.vp.map((item) => item.text),
          adjp: hint.phrases.adjp.map((item) => item.text),
        },
      })),
    });

    const linkBuildResult = await this.buildLinkRecords(factRecords, debug, exclusiveToAgentName);
    const linkRecords = linkBuildResult.links;
    warnings.push(...linkBuildResult.warnings);
    const factIds = factRecords.map(fact => fact.id);

    try {
      const writeStarted = Date.now();
      await this.store.addFacts(factRecords);
      await this.store.addHints(hintRecords);
      await this.store.addLinks(linkRecords);
      debug('memory.ingest.store_write', 'Persisted facts, hints, and links.', {
        durationMs: Date.now() - writeStarted,
        factCount: factRecords.length,
        hintCount: hintRecords.length,
        linkCount: linkRecords.length,
      });
    } catch (error) {
      await Promise.allSettled([
        this.store.deleteLinksByFactIds(factIds),
        this.store.deleteHintsByFactIds(factIds),
        this.store.deleteFactsByIds(factIds),
      ]);
      throw error;
    }

    this.appendToIndex(factRecords, hintRecords, linkRecords);
    finalizeMemoryDebugTrace(localDebug, true);

    return {
      factIds,
      factCount: factRecords.length,
      hintCount: hintRecords.length,
      linkCount: linkRecords.length,
      ...(warnings.length > 0 ? { warnings } : {}),
    };
  }

  async search(query: string, options: SearchOptions = {}, debugTrace?: MemoryDebugTrace): Promise<SearchResult> {
    await this.initialize();
    const { trace: localDebug, log: debug } = resolveDebugTrace(debugTrace, 'search');
    const cleanQuery = ensureNonEmptyString(query, 'query');
    const normalizedAgentName = normalizeCategory(options.agentName);
    const allowedCategories = buildAllowedCategories(normalizedAgentName, options.categories);
    const includeUncategorized = options.includeUncategorized !== false;
    const fallbackCategory = normalizeCategory(options.fallbackCategory);
    const excludedFactIds = new Set(
      Array.isArray(options.excludeFactIds)
        ? options.excludeFactIds.map((factId) => String(factId || '').trim()).filter(Boolean)
        : [],
    );
    const visibleFacts = this.facts.filter((fact) =>
      !excludedFactIds.has(fact.id) && isRecordVisibleToCategories(fact.exclusiveToAgentName, allowedCategories, includeUncategorized, fallbackCategory),
    );
    const visibleFactIds = new Set(visibleFacts.map((fact) => fact.id));
    const visibleHints = this.hints.filter((hint) =>
      visibleFactIds.has(hint.factId) && isRecordVisibleToCategories(hint.exclusiveToAgentName, allowedCategories, includeUncategorized, fallbackCategory),
    );
    const visibleHintsByFactId = new Map<string, RetrievalHintRecord[]>();
    for (const hint of visibleHints) {
      const bucket = visibleHintsByFactId.get(hint.factId) ?? [];
      bucket.push(hint);
      visibleHintsByFactId.set(hint.factId, bucket);
    }
    const visibleIndexedFacts = visibleFacts.map((fact) => ({
      fact,
      hints: visibleHintsByFactId.get(fact.id) ?? [],
    }));
    const visibleLinks = this.links.filter((link) =>
      isRecordVisibleToCategories(link.exclusiveToAgentName, allowedCategories, includeUncategorized, fallbackCategory)
      && visibleFactIds.has(link.fromFactId)
      && visibleFactIds.has(link.toFactId),
    );
    debug('memory.search.start', 'Starting phrase-aware search.', {
      query: summarizeText(cleanQuery),
      options,
      agentName: normalizedAgentName,
      allowedCategories: Array.from(allowedCategories),
      includeUncategorized,
      indexedFactCount: visibleIndexedFacts.length,
    });
    if (visibleIndexedFacts.length === 0) {
      finalizeMemoryDebugTrace(localDebug, true);
      return {
        text: '',
        chains: [],
        seedFacts: [],
        surfacedFactIds: [],
        queryPhrases: [],
        phraseAggregationMode: options.phraseAggregationMode ?? this.config.searchDefaultAggregationMode,
        candidateSelection: resolveCandidateSelection(this.config, options),
        overallEmbeddingWeight: options.overallEmbeddingWeight ?? this.config.overallEmbeddingWeight,
      };
    }

    const queryAnalysis = await analyzeWithStanza(cleanQuery, undefined, debug);
    const sentencePhraseSets = queryAnalysis.sentences.map((sentence) =>
      extractSentencePhrases(sentence, queryAnalysis.parserMode)
    );
    const mergedPhrases = mergePhraseSets(sentencePhraseSets);
    const phraseCandidates: QueryPhraseCandidate[] = flattenPhraseSet(mergedPhrases);
    debug('memory.search.query_phrases', 'Extracted raw query phrases.', {
      parserMode: queryAnalysis.parserMode,
      language: queryAnalysis.language,
      sentences: queryAnalysis.sentences.map((sentence, index) => ({
        sentenceIndex: index,
        text: sentence.text,
        phrases: sentencePhraseSets[index],
      })),
      mergedPhrases,
      phraseCandidates,
    });
    const phraseWeightingMode: QueryPhraseWeightingMode =
      options.queryPhraseWeightingMode === 'embedding'
        ? 'embedding'
        : options.queryPhraseWeightingMode === 'llm'
          ? 'llm'
          : this.config.searchDefaultPhraseWeightingMode;
    let queryGlobalEmbedding: number[] | null = null;
    let queryPhraseEmbeddingsForCandidates: number[][] | null = null;
    let weightedPhrases: Array<{ phrase: string; weight: number }>;
    if (phraseWeightingMode === 'embedding') {
      const embeddingWeightStarted = Date.now();
      queryGlobalEmbedding = await embedText(cleanQuery, this.config.embeddingModel, debug, 'query.global');
      queryPhraseEmbeddingsForCandidates = phraseCandidates.length > 0
        ? await embedBatch(phraseCandidates.map((phrase) => phrase.text), this.config.embeddingModel, {
          debug,
          label: 'query.phrase_weighting',
        })
        : [];
      weightedPhrases = normalizeWeightRowsFromScores(
        phraseCandidates,
        queryPhraseEmbeddingsForCandidates.map((embedding) => cosineSimilarity(queryGlobalEmbedding!, embedding)),
      );
      debug('memory.search.embedding_weighted_phrases', 'Weighted query phrases with embedding similarity.', {
        durationMs: Date.now() - embeddingWeightStarted,
        phraseWeightingMode,
        weightedPhrases,
      });
    } else {
      weightedPhrases = await weightQueryPhrases(cleanQuery, phraseCandidates, this.config, debug);
    }
    const weightedQueryPhrases = weightedPhrases.map((item) => {
      const match = phraseCandidates.find(phrase => phrase.text === item.phrase);
      return match ? {
        type: match.type,
        text: item.phrase,
        weight: item.weight,
      } : null;
    }).filter((item): item is { type: PhraseType; text: string; weight: number } => Boolean(item));
    debug('memory.search.weighted_phrases', 'Weighted query phrases.', {
      phraseWeightingMode,
      weightedQueryPhrases,
    });

    const queryEmbeddingStarted = Date.now();
    queryGlobalEmbedding ??= await embedText(cleanQuery, this.config.embeddingModel, debug, 'query.global');
    const queryPhraseEmbeddings = weightedQueryPhrases.length > 0
      ? queryPhraseEmbeddingsForCandidates && weightedQueryPhrases.length === phraseCandidates.length
        ? queryPhraseEmbeddingsForCandidates
        : await embedBatch(weightedQueryPhrases.map((phrase) => phrase.text), this.config.embeddingModel, {
        debug,
        label: 'query.phrases',
      })
      : [];
    debug('memory.search.embeddings', 'Generated query embeddings.', {
      durationMs: Date.now() - queryEmbeddingStarted,
      globalDimensions: queryGlobalEmbedding.length,
      phraseEmbeddingCount: queryPhraseEmbeddings.length,
      phraseEmbeddingDimensions: queryPhraseEmbeddings[0]?.length ?? 0,
    });
    const queryVectors: SearchQueryVectors = {
      globalEmbedding: queryGlobalEmbedding,
      phrases: weightedQueryPhrases.map((phrase, index) => ({
        ...phrase,
        embedding: queryPhraseEmbeddings[index] ?? [],
      })),
    };

    const phraseAggregationMode: PhraseAggregationMode = options.phraseAggregationMode ?? this.config.searchDefaultAggregationMode;
    const overallEmbeddingWeight = options.overallEmbeddingWeight ?? this.config.overallEmbeddingWeight;
    const seedScores = scoreSeedFacts(visibleIndexedFacts, queryVectors, phraseAggregationMode, overallEmbeddingWeight, options.categoryMultipliers);
    const candidateSelection = resolveCandidateSelection(this.config, options);
    const autoSelectionAnalysis = candidateSelection.mode === 'auto'
      ? analyzeAutoCandidateSelection(seedScores, candidateSelection)
      : null;
    const initialSeedFacts = candidateSelection.mode === 'auto'
      ? seedScores.filter((score) => score.score >= (autoSelectionAnalysis?.chosenThreshold ?? candidateSelection.threshold))
      : selectSeedFacts(seedScores, candidateSelection);
    const anchorRescueAnalysis = analyzeAnchorRescue(visibleIndexedFacts, seedScores, weightedQueryPhrases);
    const rescuedSeedFacts = anchorRescueAnalysis.rescuedFacts
      .map((item) => ({
        factId: item.factId,
        score: item.score,
      }))
      .filter((item) => !initialSeedFacts.some((seed) => seed.factId === item.factId));
    const seedFacts = [...initialSeedFacts, ...rescuedSeedFacts]
      .sort((a, b) => b.score - a.score);
    const resolvedCandidateSelection = candidateSelection.mode === 'auto' && autoSelectionAnalysis
      ? {
        ...candidateSelection,
        threshold: autoSelectionAnalysis.chosenThreshold,
        maxCandidates: Math.max(candidateSelection.maxCandidates, autoSelectionAnalysis.maxCandidates),
      }
      : candidateSelection;
    debug('memory.search.seeds', 'Scored and selected seed facts.', {
      phraseAggregationMode,
      overallEmbeddingWeight,
      candidateSelection: resolvedCandidateSelection,
      autoSelectionAnalysis,
      anchorRescueAnalysis,
      topScores: seedScores.slice(0, 20),
      rescuedSeedFacts,
      selectedSeedFacts: seedFacts,
    });
    const chainResults = searchGraphChains(
      queryGlobalEmbedding,
      visibleFacts,
      visibleLinks,
      seedFacts,
      {
        maxDepth: resolveInt(options.maxDepth, this.config.searchMaxDepth),
        maxChains: resolveInt(options.maxChains, this.config.searchMaxChains),
        beamWidth: resolveInt(options.beamWidth, this.config.searchBeamWidth),
      },
    );
    debug('memory.search.chains', 'Expanded graph chains from seed facts.', {
      chainCount: chainResults.length,
      chains: chainResults,
    });
    finalizeMemoryDebugTrace(localDebug, true);

    const surfacedFactIds = Array.from(new Set(chainResults.flatMap((chain) => chain.factIds)));
    const chains = chainResults.map((chain) => chain.text);

    return {
      text: chains.join('\n'),
      chains,
      seedFacts,
      surfacedFactIds,
      queryPhrases: weightedQueryPhrases,
      phraseAggregationMode,
      candidateSelection: resolvedCandidateSelection,
      overallEmbeddingWeight,
    };
  }

  async deleteFactsBySourceId(sourceId: string): Promise<string[]> {
    await this.initialize();
    const deletedFactIds = await this.store.deleteFactsBySourceId(sourceId);
    if (deletedFactIds.length > 0) {
      await this.reloadIndex();
    }
    return deletedFactIds;
  }

  async migrateLegacyNamespace(sourceNamespace = 'global_memory', debugTrace?: MemoryDebugTrace): Promise<IngestTextResult> {
    await this.initialize();
    const { trace: localDebug, log: debug } = resolveDebugTrace(debugTrace, 'migrateLegacyNamespace');
    debug('memory.migrate.start', 'Starting legacy namespace migration.', {
      sourceNamespace,
      destinationNamespace: this.config.table,
    });
    if (this.facts.length > 0 || this.hints.length > 0 || this.links.length > 0) {
      throw new Error(`Destination namespace "${this.config.table}" is not empty.`);
    }

    const legacy = await readLegacyNamespace(sourceNamespace);
    debug('memory.migrate.loaded_legacy', 'Loaded legacy namespace rows.', {
      factCount: legacy.facts.length,
      linkCount: legacy.links.length,
    });
    if (legacy.facts.length === 0) {
      finalizeMemoryDebugTrace(localDebug, true);
      return {
        factIds: [],
        factCount: 0,
        hintCount: 0,
        linkCount: 0,
      };
    }

    const factDrafts: MemoryItemDraft[] = [];
    for (const legacyFact of legacy.facts) {
      factDrafts.push(await this.analyzeWholeTextAsDraft(legacyFact.text, undefined, legacyFact.id, legacyFact.createdAt, legacyFact.updatedAt, debug));
    }
    debug('memory.migrate.fact_drafts', 'Rebuilt drafts from legacy facts.', {
      count: factDrafts.length,
    });
    const embeddedFacts = await this.embedDrafts(factDrafts, debug, 'legacy_facts');
    const factRecords: FactRecord[] = embeddedFacts.map((item) => ({
      id: item.id,
      text: item.text,
      language: item.language,
      parserMode: item.parserMode,
      globalEmbedding: item.globalEmbedding,
      constituency: item.constituency,
      dependencies: item.dependencies,
      phrases: item.phrases,
      exclusiveToAgentName: null,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
    }));
    const factsById = new Map(factRecords.map(fact => [fact.id, fact]));

    const relationEmbeddings = legacy.links.length > 0
      ? await embedBatch(legacy.links.map(link => link.relation), this.config.embeddingModel, {
        debug,
        label: 'migration.link_relations',
      })
      : [];
    const linkRecords = legacy.links
      .flatMap((link, index): LinkRecord[] => {
        const fromFact = factsById.get(link.fromFactId);
        const toFact = factsById.get(link.toFactId);
        if (!fromFact || !toFact) return [];
        return [{
          id: link.id,
          fromFactId: link.fromFactId,
          toFactId: link.toFactId,
          relation: link.relation,
          confidence: link.confidence,
          relationEmbedding: relationEmbeddings[index] ?? [],
          directionEmbedding: vectorSubtract(toFact.globalEmbedding, fromFact.globalEmbedding),
          exclusiveToAgentName: null,
          createdAt: link.createdAt,
          updatedAt: link.updatedAt,
        }];
      });

    const writeStarted = Date.now();
    await this.store.addFacts(factRecords);
    await this.store.addLinks(linkRecords);
    debug('memory.migrate.store_write', 'Persisted migrated facts and links.', {
      durationMs: Date.now() - writeStarted,
      factCount: factRecords.length,
      linkCount: linkRecords.length,
    });
    this.appendToIndex(factRecords, [], linkRecords);
    finalizeMemoryDebugTrace(localDebug, true);

    return {
      factIds: factRecords.map(fact => fact.id),
      factCount: factRecords.length,
      hintCount: 0,
      linkCount: linkRecords.length,
    };
  }

  private async reloadIndex(): Promise<void> {
    const [facts, hints, links] = await Promise.all([
      this.store.getAllFacts(),
      this.store.getAllHints(),
      this.store.getAllLinks(),
    ]);

    for (const fact of facts) {
      fact.globalEmbedding = normalizeEmbeddingVectorUnit(fact.globalEmbedding);
      normalizePhraseRecordSetInPlace(fact.phrases);
    }
    for (const hint of hints) {
      hint.globalEmbedding = normalizeEmbeddingVectorUnit(hint.globalEmbedding);
      normalizePhraseRecordSetInPlace(hint.phrases);
    }
    for (const link of links) {
      link.relationEmbedding = normalizeEmbeddingVectorUnit(link.relationEmbedding);
      link.directionEmbedding = normalizeEmbeddingVectorUnit(link.directionEmbedding);
    }

    this.facts = facts;
    this.hints = hints;
    this.links = links;
    this.indexedFactsById.clear();
    const hintsByFactId = new Map<string, RetrievalHintRecord[]>();
    for (const hint of hints) {
      const bucket = hintsByFactId.get(hint.factId) ?? [];
      bucket.push(hint);
      hintsByFactId.set(hint.factId, bucket);
    }
    this.indexedFacts = facts.map((fact) => {
      const entry: IndexedFactRecord = {
        fact,
        hints: hintsByFactId.get(fact.id) ?? [],
        globalSearchEmbeddings: [
          fact.globalEmbedding,
          ...(hintsByFactId.get(fact.id) ?? []).map((hint) => hint.globalEmbedding),
        ].filter((vector) => vector.length > 0),
        phraseSearchEmbeddings: {
          np: [
            ...fact.phrases.np.map((item) => item.embedding),
            ...((hintsByFactId.get(fact.id) ?? []).flatMap((hint) => hint.phrases.np.map((item) => item.embedding))),
          ],
          vp: [
            ...fact.phrases.vp.map((item) => item.embedding),
            ...((hintsByFactId.get(fact.id) ?? []).flatMap((hint) => hint.phrases.vp.map((item) => item.embedding))),
          ],
          adjp: [
            ...fact.phrases.adjp.map((item) => item.embedding),
            ...((hintsByFactId.get(fact.id) ?? []).flatMap((hint) => hint.phrases.adjp.map((item) => item.embedding))),
          ],
        },
      };
      this.indexedFactsById.set(fact.id, entry);
      return entry;
    });
  }

  private appendToIndex(
    facts: FactRecord[],
    hints: RetrievalHintRecord[],
    links: LinkRecord[],
  ): void {
    for (const fact of facts) {
      fact.globalEmbedding = normalizeEmbeddingVectorUnit(fact.globalEmbedding);
      normalizePhraseRecordSetInPlace(fact.phrases);
      this.facts.push(fact);
      const entry: IndexedFactRecord = {
        fact,
        hints: [],
        globalSearchEmbeddings: [fact.globalEmbedding],
        phraseSearchEmbeddings: {
          np: fact.phrases.np.map((item) => item.embedding),
          vp: fact.phrases.vp.map((item) => item.embedding),
          adjp: fact.phrases.adjp.map((item) => item.embedding),
        },
      };
      this.indexedFacts.push(entry);
      this.indexedFactsById.set(fact.id, entry);
    }
    for (const hint of hints) {
      hint.globalEmbedding = normalizeEmbeddingVectorUnit(hint.globalEmbedding);
      normalizePhraseRecordSetInPlace(hint.phrases);
      this.hints.push(hint);
      const entry = this.indexedFactsById.get(hint.factId);
      if (entry) {
        entry.hints.push(hint);
        entry.globalSearchEmbeddings = [...(entry.globalSearchEmbeddings ?? []), hint.globalEmbedding];
        entry.phraseSearchEmbeddings = entry.phraseSearchEmbeddings ?? { np: [], vp: [], adjp: [] };
        entry.phraseSearchEmbeddings.np.push(...hint.phrases.np.map((item) => item.embedding));
        entry.phraseSearchEmbeddings.vp.push(...hint.phrases.vp.map((item) => item.embedding));
        entry.phraseSearchEmbeddings.adjp.push(...hint.phrases.adjp.map((item) => item.embedding));
      }
    }
    for (const link of links) {
      link.relationEmbedding = normalizeEmbeddingVectorUnit(link.relationEmbedding);
      link.directionEmbedding = normalizeEmbeddingVectorUnit(link.directionEmbedding);
      this.links.push(link);
    }
  }


  private async analyzeIntoSentenceDrafts(text: string, language?: string, debug?: MemoryDebugLogger, label = 'text'): Promise<MemoryItemDraft[]> {
    const annotation = await analyzeWithStanza(text, language, debug);
    debug?.('memory.stanza_phrases', `Extracted sentence phrases for ${label}.`, {
      language: annotation.language,
      parserMode: annotation.parserMode,
      sentences: annotation.sentences.map((sentence) => ({
        sentenceIndex: sentence.sentenceIndex,
        text: sentence.text,
        phrases: extractSentencePhrases(sentence, annotation.parserMode),
      })),
    });
    return annotation.sentences
      .map((sentence) => ({
        text: sentence.text.trim(),
        language: annotation.language,
        parserMode: annotation.parserMode,
        constituency: sentence.constituency,
        dependencies: sentence.dependencies,
        phraseTexts: extractSentencePhrases(sentence, annotation.parserMode),
      }))
      .filter((draft) => draft.text.length > 0);
  }

  private async analyzeWholeTextAsDraft(
    text: string,
    language?: string,
    id?: string,
    createdAt?: number,
    updatedAt?: number,
    debug?: MemoryDebugLogger,
  ): Promise<MemoryItemDraft> {
    const annotation = await analyzeWithStanza(text, language, debug);
    const mergedPhrases = mergePhraseSets(
      annotation.sentences.map((sentence) => extractSentencePhrases(sentence, annotation.parserMode)),
    );
    debug?.('memory.stanza_merged', 'Merged phrases across text.', {
      text: summarizeText(text),
      mergedPhrases,
    });

    return {
      id,
      text,
      language: annotation.language,
      parserMode: annotation.parserMode,
      constituency: annotation.sentences.length === 1 ? annotation.sentences[0]?.constituency ?? null : null,
      dependencies: annotation.sentences.length === 1 ? annotation.sentences[0]?.dependencies ?? [] : [],
      phraseTexts: mergedPhrases,
      createdAt,
      updatedAt,
    };
  }

  private async embedDrafts(drafts: MemoryItemDraft[], debug?: MemoryDebugLogger, label = 'drafts'): Promise<EmbeddedMemoryItem[]> {
    if (drafts.length === 0) return [];

    const started = Date.now();
    const globalEmbeddings = await embedBatch(drafts.map((draft) => draft.text), this.config.embeddingModel, {
      debug,
      label: `${label}.global`,
    });

    const perTypeRequests: Record<PhraseType, Array<{ draftIndex: number; text: string }>> = {
      np: [],
      vp: [],
      adjp: [],
    };
    for (let draftIndex = 0; draftIndex < drafts.length; draftIndex++) {
      const draft = drafts[draftIndex];
      for (const type of ['np', 'vp', 'adjp'] as PhraseType[]) {
        for (const text of phraseTextsForType(draft!, type)) {
          perTypeRequests[type].push({ draftIndex, text });
        }
      }
    }

    const perTypeEmbeddings: Record<PhraseType, number[][]> = {
      np: perTypeRequests.np.length > 0 ? await embedBatch(perTypeRequests.np.map(item => item.text), this.config.embeddingModel, {
        debug,
        label: `${label}.np`,
      }) : [],
      vp: perTypeRequests.vp.length > 0 ? await embedBatch(perTypeRequests.vp.map(item => item.text), this.config.embeddingModel, {
        debug,
        label: `${label}.vp`,
      }) : [],
      adjp: perTypeRequests.adjp.length > 0 ? await embedBatch(perTypeRequests.adjp.map(item => item.text), this.config.embeddingModel, {
        debug,
        label: `${label}.adjp`,
      }) : [],
    };
    debug?.('memory.embed.batch', `Generated embeddings for ${label}.`, {
      durationMs: Date.now() - started,
      embeddingModel: this.config.embeddingModel,
      draftCount: drafts.length,
      globalBatchCount: drafts.length,
      phraseBatchCounts: {
        np: perTypeRequests.np.length,
        vp: perTypeRequests.vp.length,
        adjp: perTypeRequests.adjp.length,
      },
      phraseTexts: drafts.map((draft) => ({
        text: draft.text,
        phrases: draft.phraseTexts,
      })),
    });

    const phraseSets = drafts.map(() => createEmptyPhraseRecordSet());
    for (const type of ['np', 'vp', 'adjp'] as PhraseType[]) {
      perTypeRequests[type].forEach((request, index) => {
        const bucket = phraseSets[request.draftIndex]![type] as EmbeddedPhraseRecord[];
        bucket.push({
          text: request.text,
          embedding: perTypeEmbeddings[type][index] ?? [],
        });
      });
    }

    const now = Date.now();
    return drafts.map((draft, index) => ({
      id: draft.id ?? randomUUID(),
      text: draft.text,
      language: draft.language,
      parserMode: draft.parserMode,
      constituency: draft.constituency,
      dependencies: draft.dependencies,
      globalEmbedding: globalEmbeddings[index] ?? [],
      phrases: phraseSets[index] ?? createEmptyPhraseRecordSet(),
      createdAt: draft.createdAt ?? now,
      updatedAt: draft.updatedAt ?? now,
    }));
  }

  private async embedRetrievalHintTemplates(hints: string[], debug?: MemoryDebugLogger): Promise<EmbeddedMemoryItem[]> {
    const drafts: MemoryItemDraft[] = [];
    for (const hint of hints) {
      const analyzed = await this.analyzeIntoSentenceDrafts(hint, undefined, debug, 'retrieval_hint');
      drafts.push(...analyzed);
    }
    return this.embedDrafts(drafts, debug, 'retrieval_hints');
  }

  private async buildLinkRecords(
    newFacts: FactRecord[],
    debug?: MemoryDebugLogger,
    exclusiveToAgentName?: string | null,
  ): Promise<{ links: LinkRecord[]; warnings: string[] }> {
    if (newFacts.length === 0) return { links: [], warnings: [] };
    const warnings: string[] = [];

    const existingKeys = new Set(this.links.map(link => linkKey(link.fromFactId, link.toFactId, link.relation)));
    const allFactsById = new Map(this.facts.map(fact => [fact.id, fact]));
    for (const fact of newFacts) {
      allFactsById.set(fact.id, fact);
    }

    const proceduralMaxLinksPerFact = this.resolveProceduralLinkBudget(newFacts.length);
    const proceduralLinkCountPerNewFact = new Map<string, number>();
    const acceptedProceduralLinks: MemoryLinkSuggestion[] = [];
    const proceduralWindows = this.buildProceduralLinkWindows(newFacts);
    debug?.('memory.links.procedural_plan', 'Prepared procedural linking plan.', {
      factCount: newFacts.length,
      proceduralMaxLinksPerFact,
      windowCount: proceduralWindows.length,
      windows: proceduralWindows.map((window, index) => ({
        windowIndex: index,
        size: window.length,
        factIds: window.map((fact) => fact.id),
      })),
    });

    for (let index = 0; index < proceduralWindows.length; index++) {
      const window = proceduralWindows[index] ?? [];
      const proceduralSuggestions = await generateProceduralLinks({
        newFacts: window.map((fact) => ({ id: fact.id, text: fact.text })),
        maxAutoLinksPerFact: proceduralMaxLinksPerFact,
      }, this.config, debug);
      if (window.length >= 2 && proceduralSuggestions.length === 0) {
        warnings.push(`Procedural linker returned no links for window ${index + 1}.`);
      }
      debug?.('memory.links.procedural_window_suggestions', 'Received procedural window link suggestions.', {
        windowIndex: index,
        windowFactIds: window.map((fact) => fact.id),
        suggestions: proceduralSuggestions,
      });

      const acceptedProcedural = this.acceptLinkSuggestions({
        suggestions: proceduralSuggestions,
        newFacts,
        allFactsById,
        existingKeys,
        linkCountPerNewFact: proceduralLinkCountPerNewFact,
        mode: 'procedural',
        maxLinksPerNewFact: proceduralMaxLinksPerFact,
      });
      acceptedProceduralLinks.push(...acceptedProcedural.accepted);
    }

    const lowCoverageFacts = newFacts.filter((fact) => (proceduralLinkCountPerNewFact.get(fact.id) ?? 0) < 2);
    const coverageWindows = this.buildProceduralCoverageWindows(newFacts, lowCoverageFacts);
    debug?.('memory.links.procedural_coverage_plan', 'Prepared procedural coverage windows for low-degree facts.', {
      lowCoverageFactCount: lowCoverageFacts.length,
      coverageWindowCount: coverageWindows.length,
      coverageWindows: coverageWindows.map((window, index) => ({
        windowIndex: index,
        size: window.length,
        factIds: window.map((fact) => fact.id),
      })),
    });

    for (let index = 0; index < coverageWindows.length; index++) {
      const window = coverageWindows[index] ?? [];
      const proceduralSuggestions = await generateProceduralLinks({
        newFacts: window.map((fact) => ({ id: fact.id, text: fact.text })),
        maxAutoLinksPerFact: proceduralMaxLinksPerFact,
      }, this.config, debug);
      if (window.length >= 2 && proceduralSuggestions.length === 0) {
        warnings.push(`Coverage linker returned no links for window ${index + 1}.`);
      }
      debug?.('memory.links.procedural_coverage_suggestions', 'Received coverage procedural link suggestions.', {
        windowIndex: index,
        windowFactIds: window.map((fact) => fact.id),
        suggestions: proceduralSuggestions,
      });

      const acceptedProcedural = this.acceptLinkSuggestions({
        suggestions: proceduralSuggestions,
        newFacts,
        allFactsById,
        existingKeys,
        linkCountPerNewFact: proceduralLinkCountPerNewFact,
        mode: 'procedural',
        maxLinksPerNewFact: proceduralMaxLinksPerFact,
      });
      acceptedProceduralLinks.push(...acceptedProcedural.accepted);
    }

    debug?.('memory.links.procedural_accepted', 'Accepted procedural intra-document links.', {
      count: acceptedProceduralLinks.length,
      accepted: acceptedProceduralLinks,
      degreeByFactId: Object.fromEntries(newFacts.map((fact) => [fact.id, proceduralLinkCountPerNewFact.get(fact.id) ?? 0])),
    });

    const candidates = this.collectLinkCandidateFacts(newFacts, exclusiveToAgentName ?? null);
    debug?.('memory.links.candidates', 'Collected candidate facts for auto-linking.', {
      newFactCount: newFacts.length,
      candidateCount: candidates.length,
      candidates: candidates.map((fact) => ({
        id: fact.id,
        text: fact.text,
      })),
    });
    const suggestions = await generateAutoLinks({
      newFacts: newFacts.map(fact => ({ id: fact.id, text: fact.text })),
      candidateFacts: candidates.map(fact => ({ id: fact.id, text: fact.text })),
      maxAutoLinksPerFact: this.config.maxAutoLinksPerFact,
    }, this.config, debug);
    if (candidates.length > 0 && suggestions.length === 0) {
      warnings.push('Cross-document linker returned no links.');
    }
    debug?.('memory.links.suggestions', 'Received raw link suggestions.', {
      suggestions,
    });

    const acceptedCrossDocument = this.acceptLinkSuggestions({
      suggestions,
      newFacts,
      allFactsById,
      existingKeys,
      linkCountPerNewFact: new Map<string, number>(),
      mode: 'cross-document',
      maxLinksPerNewFact: this.config.maxAutoLinksPerFact,
    });
    debug?.('memory.links.cross_document_accepted', 'Accepted cross-document links.', {
      count: acceptedCrossDocument.accepted.length,
      accepted: acceptedCrossDocument.accepted,
    });

    const mergeLinks = await this.buildSemanticMergeLinks(newFacts, allFactsById, existingKeys, debug, exclusiveToAgentName ?? null);
    const autoLinkRecords = await this.materializeLinks([
      ...acceptedProceduralLinks,
      ...acceptedCrossDocument.accepted,
    ], allFactsById, debug, exclusiveToAgentName ?? null);
    debug?.('memory.links.final', 'Built final link records.', {
      acceptedProceduralSuggestions: acceptedProceduralLinks,
      acceptedSuggestions: acceptedCrossDocument.accepted,
      autoLinkCount: autoLinkRecords.length,
      semanticMergeLinkCount: mergeLinks.length,
      totalLinkCount: autoLinkRecords.length + mergeLinks.length,
      warnings,
    });
    return {
      links: [...autoLinkRecords, ...mergeLinks],
      warnings,
    };
  }

  private acceptLinkSuggestions(input: {
    suggestions: MemoryLinkSuggestion[];
    newFacts: FactRecord[];
    allFactsById: Map<string, FactRecord>;
    existingKeys: Set<string>;
    linkCountPerNewFact: Map<string, number>;
    mode: 'procedural' | 'cross-document';
    maxLinksPerNewFact: number;
  }): { accepted: MemoryLinkSuggestion[]; linkCountPerNewFact: Map<string, number> } {
    const accepted: MemoryLinkSuggestion[] = [];
    const newFactIds = new Set(input.newFacts.map((fact) => fact.id));

    for (const suggestion of input.suggestions) {
      const fromFactId = suggestion.fromFactId.trim();
      const toFactId = suggestion.toFactId.trim();
      const relation = suggestion.relation.trim();
      if (!fromFactId || !toFactId || !relation) continue;
      if (fromFactId === toFactId) continue;
      if (!input.allFactsById.has(fromFactId) || !input.allFactsById.has(toFactId)) continue;

      const fromIsNew = newFactIds.has(fromFactId);
      const toIsNew = newFactIds.has(toFactId);
      if (!fromIsNew && !toIsNew) continue;
      if (input.mode === 'procedural' && (!fromIsNew || !toIsNew)) continue;
      if (input.mode === 'cross-document' && fromIsNew === toIsNew) continue;

      const impacted = [fromFactId, toFactId].filter((factId) => newFactIds.has(factId));
      if (impacted.some((factId) => (input.linkCountPerNewFact.get(factId) ?? 0) >= input.maxLinksPerNewFact)) {
        continue;
      }

      const key = linkKey(fromFactId, toFactId, relation);
      if (input.existingKeys.has(key)) continue;
      input.existingKeys.add(key);
      impacted.forEach((factId) => {
        input.linkCountPerNewFact.set(factId, (input.linkCountPerNewFact.get(factId) ?? 0) + 1);
      });
      accepted.push({
        fromFactId,
        toFactId,
        relation,
        confidence: clamp01(suggestion.confidence ?? 0.55),
      });
    }

    return {
      accepted,
      linkCountPerNewFact: input.linkCountPerNewFact,
    };
  }

  private resolveProceduralLinkBudget(factCount: number): number {
    if (factCount <= 6) {
      return Math.max(this.config.maxAutoLinksPerFact, 4);
    }
    if (factCount <= 20) {
      return Math.max(this.config.maxAutoLinksPerFact + 2, 6);
    }
    return Math.max(this.config.maxAutoLinksPerFact * 2, 8);
  }

  private buildProceduralLinkWindows(newFacts: FactRecord[]): FactRecord[][] {
    if (newFacts.length <= 12) {
      return [newFacts];
    }

    const windowSize = newFacts.length <= 24 ? Math.min(newFacts.length, 16) : 12;
    const step = Math.max(4, Math.floor(windowSize / 2));
    const windows: FactRecord[][] = [];

    for (let start = 0; start < newFacts.length; start += step) {
      const window = newFacts.slice(start, Math.min(newFacts.length, start + windowSize));
      if (window.length < 2) break;
      windows.push(window);
      if ((start + windowSize) >= newFacts.length) {
        break;
      }
    }

    const tailWindow = newFacts.slice(Math.max(0, newFacts.length - windowSize));
    if (tailWindow.length >= 2) {
      windows.push(tailWindow);
    }

    return this.dedupeFactWindows(windows);
  }

  private buildProceduralCoverageWindows(newFacts: FactRecord[], lowCoverageFacts: FactRecord[]): FactRecord[][] {
    if (newFacts.length < 3 || lowCoverageFacts.length === 0) {
      return [];
    }

    const factIndexById = new Map(newFacts.map((fact, index) => [fact.id, index]));
    const windows: FactRecord[][] = [];
    const prioritizedFacts = lowCoverageFacts.slice(0, 24);

    for (const fact of prioritizedFacts) {
      const index = factIndexById.get(fact.id);
      if (index === undefined) continue;
      const neighborhood = newFacts.slice(Math.max(0, index - 4), Math.min(newFacts.length, index + 5));
      const semanticNeighbors = this.collectProceduralSemanticNeighbors(fact, newFacts, 4);
      const merged = new Map<string, FactRecord>();
      for (const item of neighborhood) {
        merged.set(item.id, item);
      }
      for (const item of semanticNeighbors) {
        merged.set(item.id, item);
      }
      const window = Array.from(merged.values())
        .sort((a, b) => (factIndexById.get(a.id) ?? 0) - (factIndexById.get(b.id) ?? 0));
      if (window.length >= 2) {
        windows.push(window);
      }
    }

    return this.dedupeFactWindows(windows);
  }

  private collectProceduralSemanticNeighbors(targetFact: FactRecord, facts: FactRecord[], limit: number): FactRecord[] {
    return facts
      .filter((fact) => fact.id !== targetFact.id)
      .map((fact) => ({
        fact,
        similarity: cosineSimilarity(targetFact.globalEmbedding, fact.globalEmbedding),
      }))
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, Math.max(0, limit))
      .map((item) => item.fact);
  }

  private dedupeFactWindows(windows: FactRecord[][]): FactRecord[][] {
    const seen = new Set<string>();
    const unique: FactRecord[][] = [];
    for (const window of windows) {
      const key = window.map((fact) => fact.id).join('|');
      if (!key || seen.has(key)) continue;
      seen.add(key);
      unique.push(window);
    }
    return unique;
  }

  private collectLinkCandidateFacts(newFacts: FactRecord[], category: string | null): FactRecord[] {
    if (this.facts.length === 0) return [];
    const allowedCategories = category ? new Set([category]) : new Set<string>();
    const candidateFacts = this.facts.filter((fact) => isRecordVisibleToCategories(fact.exclusiveToAgentName, allowedCategories, true));
    if (candidateFacts.length === 0) return [];

    const bestScoreByFactId = new Map<string, number>();
    for (const newFact of newFacts) {
      for (const existingFact of candidateFacts) {
        const similarity = cosineSimilarity(newFact.globalEmbedding, existingFact.globalEmbedding);
        const previous = bestScoreByFactId.get(existingFact.id);
        if (previous === undefined || similarity > previous) {
          bestScoreByFactId.set(existingFact.id, similarity);
        }
      }
    }

    return Array.from(bestScoreByFactId.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, this.config.linkCandidatePoolMax)
      .map(([factId]) => candidateFacts.find(fact => fact.id === factId))
      .filter((fact): fact is FactRecord => Boolean(fact));
  }

  private async materializeLinks(
    suggestions: MemoryLinkSuggestion[],
    factsById: Map<string, FactRecord>,
    debug?: MemoryDebugLogger,
    exclusiveToAgentName?: string | null,
  ): Promise<LinkRecord[]> {
    if (suggestions.length === 0) return [];

    const relationEmbeddings = await embedBatch(suggestions.map(link => link.relation), this.config.embeddingModel, {
      debug,
      label: 'materialize_links.relations',
    });
    return suggestions.map((suggestion, index) => {
      const fromFact = factsById.get(suggestion.fromFactId)!;
      const toFact = factsById.get(suggestion.toFactId)!;
      return {
        id: randomUUID(),
        fromFactId: suggestion.fromFactId,
        toFactId: suggestion.toFactId,
        relation: suggestion.relation,
        confidence: clamp01(suggestion.confidence ?? 0.55),
        relationEmbedding: relationEmbeddings[index] ?? [],
        directionEmbedding: vectorSubtract(toFact.globalEmbedding, fromFact.globalEmbedding),
        exclusiveToAgentName: exclusiveToAgentName ?? null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
    });
  }

  private async buildSemanticMergeLinks(
    newFacts: FactRecord[],
    factsById: Map<string, FactRecord>,
    existingKeys: Set<string>,
    debug?: MemoryDebugLogger,
    exclusiveToAgentName?: string | null,
  ): Promise<LinkRecord[]> {
    if (this.facts.length === 0 || newFacts.length === 0) {
      return [];
    }

    const relation = 'semantic-near-duplicate';
    const relationEmbedding = await embedText(relation, this.config.embeddingModel, debug, 'semantic_merge.relation');
    const links: LinkRecord[] = [];
    const now = Date.now();

    for (const newFact of newFacts) {
      for (const existingFact of this.facts) {
        if (!isRecordVisibleToCategories(existingFact.exclusiveToAgentName, exclusiveToAgentName ? new Set([exclusiveToAgentName]) : new Set<string>(), true)) continue;
        const similarity = cosineSimilarity(newFact.globalEmbedding, existingFact.globalEmbedding);
        if (similarity < this.config.semanticMergeThreshold) continue;
        const key = linkKey(newFact.id, existingFact.id, relation);
        if (existingKeys.has(key)) continue;
        existingKeys.add(key);

        const toFact = factsById.get(existingFact.id);
        if (!toFact) continue;
        links.push({
          id: randomUUID(),
          fromFactId: newFact.id,
          toFactId: existingFact.id,
          relation,
          confidence: clamp01(similarity),
          relationEmbedding,
          directionEmbedding: vectorSubtract(toFact.globalEmbedding, newFact.globalEmbedding),
          exclusiveToAgentName: exclusiveToAgentName ?? null,
          createdAt: now,
          updatedAt: now,
        });
      }
    }

    return links;
  }
}
