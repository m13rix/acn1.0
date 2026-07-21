import * as lancedb from '@lancedb/lancedb';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PhraseType, WeightedQueryPhrase } from './phrases.js';
import type { FactRecord, LinkRecord, PhraseAggregationMode, RetrievalHintRecord, SeedFactScore } from './types.js';
import { FastMemoryMatrix, type MatrixSourceCounts } from './FastMemoryMatrix.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', '..', 'data', 'memory');
const INDEX_VERSION = 1;
const SOURCE_BATCH_SIZE = 24;
const VECTOR_WRITE_BATCH_SIZE = 384;
const GLOBAL_CANDIDATE_LIMIT = 256;
const PHRASE_CANDIDATE_LIMIT = 384;

type RawPhrase = { text?: unknown; embedding?: unknown };
type RawPhraseSet = Record<PhraseType, RawPhrase[]>;

export interface FastSearchQuery {
  globalEmbedding: number[];
  phrases: Array<WeightedQueryPhrase & { embedding: number[] }>;
}

export interface FastSearchScope {
  allowedCategories: Set<string>;
  includeUncategorized: boolean;
  fallbackCategory: string | null;
  excludedFactIds: Set<string>;
  categoryMultipliers?: Record<string, number>;
}

export interface FastGraphResult {
  text: string;
  factIds: string[];
}

function sanitizeTableName(value: string): string {
  const sanitized = value.replace(/[^a-zA-Z0-9_]/g, '_');
  return sanitized.length > 0 ? sanitized : 'global_memory_v2';
}

function parseJson<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== 'string') return fallback;
  try { return JSON.parse(raw) as T; } catch { return fallback; }
}

function vector(raw: unknown): number[] {
  const parsed = Array.isArray(raw)
    ? raw
    : raw && typeof raw === 'object' && typeof (raw as ArrayLike<unknown>).length === 'number'
      ? Array.from(raw as ArrayLike<unknown>)
      : parseJson<unknown[]>(raw, []);
  if (!Array.isArray(parsed)) return [];
  return parsed.map(Number).map((value) => Number.isFinite(value) ? value : 0);
}

function quote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function visible(category: string, scope: FastSearchScope): boolean {
  const normalized = category.trim().toLowerCase();
  if (!normalized) {
    if (scope.includeUncategorized) return true;
    return Boolean(scope.fallbackCategory && scope.allowedCategories.has(scope.fallbackCategory));
  }
  return scope.allowedCategories.has(normalized);
}

function dot(a: ArrayLike<number>, b: ArrayLike<number>): number {
  if (!a || !b || a.length === 0 || a.length !== b.length) return 0;
  let total = 0;
  for (let index = 0; index < a.length; index++) total += Number(a[index]) * Number(b[index]);
  return Number.isFinite(total) ? total : 0;
}

function cosineDistanceToSimilarity(distance: unknown): number {
  const value = Number(distance);
  return Number.isFinite(value) ? Math.max(0, 1 - value) : 0;
}

async function rowsInBatches(
  table: lancedb.Table,
  columns: string[],
  onBatch: (rows: Record<string, unknown>[]) => Promise<void>,
): Promise<void> {
  const total = await table.countRows();
  for (let offset = 0; offset < total; offset += SOURCE_BATCH_SIZE) {
    const rows = await table.query().select(columns).offset(offset).limit(SOURCE_BATCH_SIZE).toArray() as Record<string, unknown>[];
    if (rows.length > 0) await onBatch(rows);
  }
}

export class FastMemoryIndex {
  private readonly namespace: string;
  private db: lancedb.Connection | null = null;
  private globals: lancedb.Table | null = null;
  private phrases: lancedb.Table | null = null;
  private facts: lancedb.Table | null = null;
  private links: lancedb.Table | null = null;
  private readonly matrix: FastMemoryMatrix;
  private sourceCounts: MatrixSourceCounts | null = null;

  constructor(namespace: string) {
    this.namespace = sanitizeTableName(namespace);
    this.matrix = new FastMemoryMatrix(this.namespace);
  }

  private get sourceFactsName(): string { return `${this.namespace}_facts`; }
  private get sourceHintsName(): string { return `${this.namespace}_hints`; }
  private get sourceLinksName(): string { return `${this.namespace}_links`; }
  private get globalsName(): string { return `${this.namespace}_fast_v${INDEX_VERSION}_globals`; }
  private get phrasesName(): string { return `${this.namespace}_fast_v${INDEX_VERSION}_phrases`; }
  private get factsName(): string { return `${this.namespace}_fast_v${INDEX_VERSION}_facts`; }
  private get linksName(): string { return `${this.namespace}_fast_v${INDEX_VERSION}_links`; }
  private get metaName(): string { return `${this.namespace}_fast_v${INDEX_VERSION}_meta`; }

  private async connection(): Promise<lancedb.Connection> {
    if (!this.db) {
      await mkdir(DATA_DIR, { recursive: true });
      this.db = await lancedb.connect(DATA_DIR);
    }
    return this.db;
  }

  async isCurrent(): Promise<boolean> {
    const db = await this.connection();
    const names = await db.tableNames();
    const required = [this.globalsName, this.phrasesName, this.factsName, this.linksName, this.metaName];
    if (!required.every((name) => names.includes(name))) return false;
    const [sourceFacts, sourceHints, sourceLinks, meta] = await Promise.all([
      names.includes(this.sourceFactsName) ? (await db.openTable(this.sourceFactsName)).countRows() : 0,
      names.includes(this.sourceHintsName) ? (await db.openTable(this.sourceHintsName)).countRows() : 0,
      names.includes(this.sourceLinksName) ? (await db.openTable(this.sourceLinksName)).countRows() : 0,
      db.openTable(this.metaName),
    ]);
    const row = (await meta.query().limit(1).toArray() as Record<string, unknown>[])[0];
    const current = Number(row?.version) === INDEX_VERSION
      && Number(row?.factCount) === sourceFacts
      && Number(row?.hintCount) === sourceHints
      && Number(row?.linkCount) === sourceLinks;
    if (current) this.sourceCounts = { facts: sourceFacts, hints: sourceHints, links: sourceLinks };
    return current;
  }

  async open(): Promise<boolean> {
    if (!(await this.isCurrent())) return false;
    const db = await this.connection();
    [this.globals, this.phrases, this.facts, this.links] = await Promise.all([
      db.openTable(this.globalsName),
      db.openTable(this.phrasesName),
      db.openTable(this.factsName),
      db.openTable(this.linksName),
    ]);
    return true;
  }

  async build(onProgress?: (message: string) => void): Promise<void> {
    const db = await this.connection();
    const names = await db.tableNames();
    const sourceFacts = names.includes(this.sourceFactsName) ? await db.openTable(this.sourceFactsName) : null;
    const sourceHints = names.includes(this.sourceHintsName) ? await db.openTable(this.sourceHintsName) : null;
    const sourceLinks = names.includes(this.sourceLinksName) ? await db.openTable(this.sourceLinksName) : null;
    if (!sourceFacts) throw new Error(`Cannot build fast memory index: ${this.sourceFactsName} does not exist.`);

    const completedDataTables = [this.globalsName, this.phrasesName, this.factsName, this.linksName].every((name) => names.includes(name));
    if (completedDataTables && !names.includes(this.metaName)) {
      const [existingGlobals, existingPhrases, existingFacts, existingLinks] = await Promise.all([
        db.openTable(this.globalsName), db.openTable(this.phrasesName), db.openTable(this.factsName), db.openTable(this.linksName),
      ]);
      const expectedHints = sourceHints ? await sourceHints.countRows() : 0;
      const expectedLinks = sourceLinks ? await sourceLinks.countRows() : 0;
      if (
        await existingFacts.countRows() === await sourceFacts.countRows()
        && await existingGlobals.countRows() === await sourceFacts.countRows() + expectedHints
        && await existingLinks.countRows() === expectedLinks
      ) {
        onProgress?.('reusing completed vector tables; finalizing native indexes');
        await Promise.all([
          existingGlobals.createIndex('vector', { config: lancedb.Index.ivfPq({ distanceType: 'cosine', numPartitions: 32, numSubVectors: 64 }) }),
          existingPhrases.createIndex('vector', { config: lancedb.Index.ivfPq({ distanceType: 'cosine', numPartitions: 128, numSubVectors: 64 }) }),
        ]);
        await db.createTable(this.metaName, [{
          id: 'current', version: INDEX_VERSION, factCount: await sourceFacts.countRows(), hintCount: expectedHints,
          linkCount: expectedLinks, builtAt: Date.now(),
        }]);
        this.globals = existingGlobals;
        this.phrases = existingPhrases;
        this.facts = existingFacts;
        this.links = existingLinks;
        onProgress?.('ready');
        return;
      }
    }

    for (const name of [this.globalsName, this.phrasesName, this.factsName, this.linksName, this.metaName]) {
      if ((await db.tableNames()).includes(name)) await db.dropTable(name);
    }

    let globalsTable: lancedb.Table | null = null;
    let phrasesTable: lancedb.Table | null = null;
    let factsTable: lancedb.Table | null = null;
    let linksTable: lancedb.Table | null = null;
    let globalBuffer: Record<string, unknown>[] = [];
    let phraseBuffer: Record<string, unknown>[] = [];
    let factBuffer: Record<string, unknown>[] = [];
    let linkBuffer: Record<string, unknown>[] = [];

    const flush = async (kind: 'global' | 'phrase' | 'fact' | 'link', force = false): Promise<void> => {
      const buffer = kind === 'global' ? globalBuffer : kind === 'phrase' ? phraseBuffer : kind === 'fact' ? factBuffer : linkBuffer;
      if (!force && buffer.length < VECTOR_WRITE_BATCH_SIZE) return;
      if (buffer.length === 0) return;
      const tableName = kind === 'global' ? this.globalsName : kind === 'phrase' ? this.phrasesName : kind === 'fact' ? this.factsName : this.linksName;
      let table = kind === 'global' ? globalsTable : kind === 'phrase' ? phrasesTable : kind === 'fact' ? factsTable : linksTable;
      if (!table) table = await db.createTable(tableName, buffer);
      else await table.add(buffer);
      if (kind === 'global') { globalsTable = table; globalBuffer = []; }
      else if (kind === 'phrase') { phrasesTable = table; phraseBuffer = []; }
      else if (kind === 'fact') { factsTable = table; factBuffer = []; }
      else { linksTable = table; linkBuffer = []; }
    };

    let processedFacts = 0;
    await rowsInBatches(sourceFacts, [
      'id', 'text', 'language', 'parserMode', 'globalEmbeddingJson', 'phrasesJson', 'exclusiveToAgentName',
      'sourceId', 'sourceLabel', 'createdAt', 'updatedAt',
    ], async (rows) => {
      for (const row of rows) {
        const id = String(row.id || '');
        const globalVector = vector(row.globalEmbeddingJson);
        if (!id || globalVector.length === 0) continue;
        const category = String(row.exclusiveToAgentName || '').trim().toLowerCase();
        const phraseSet = parseJson<RawPhraseSet>(row.phrasesJson, { np: [], vp: [], adjp: [] });
        factBuffer.push({
          id, text: String(row.text || ''), language: String(row.language || 'en'), parserMode: String(row.parserMode || 'constituency'),
          category, sourceId: String(row.sourceId || ''), sourceLabel: String(row.sourceLabel || ''),
          createdAt: Number(row.createdAt || 0), updatedAt: Number(row.updatedAt || 0), vector: globalVector,
          npTextsJson: JSON.stringify((phraseSet.np || []).map((item) => String(item.text || '')).filter(Boolean)),
        });
        globalBuffer.push({ id: `fact:${id}`, factId: id, category, kind: 'fact', vector: globalVector });
        for (const type of ['np', 'vp', 'adjp'] as PhraseType[]) {
          for (let index = 0; index < (phraseSet[type] || []).length; index++) {
            const phrase = phraseSet[type]![index]!;
            const phraseVector = vector(phrase.embedding);
            if (phraseVector.length === 0) continue;
            phraseBuffer.push({ id: `fact:${id}:${type}:${index}`, factId: id, category, type, text: String(phrase.text || ''), vector: phraseVector });
          }
        }
        processedFacts += 1;
      }
      await Promise.all([flush('fact'), flush('global'), flush('phrase')]);
      onProgress?.(`facts ${processedFacts}/${await sourceFacts.countRows()}`);
    });

    let processedHints = 0;
    if (sourceHints) {
      await rowsInBatches(sourceHints, ['id', 'factId', 'text', 'globalEmbeddingJson', 'phrasesJson', 'exclusiveToAgentName'], async (rows) => {
        for (const row of rows) {
          const id = String(row.id || '');
          const factId = String(row.factId || '');
          const globalVector = vector(row.globalEmbeddingJson);
          if (!id || !factId || globalVector.length === 0) continue;
          const category = String(row.exclusiveToAgentName || '').trim().toLowerCase();
          globalBuffer.push({ id: `hint:${id}`, factId, category, kind: 'hint', vector: globalVector });
          const phraseSet = parseJson<RawPhraseSet>(row.phrasesJson, { np: [], vp: [], adjp: [] });
          for (const type of ['np', 'vp', 'adjp'] as PhraseType[]) {
            for (let index = 0; index < (phraseSet[type] || []).length; index++) {
              const phrase = phraseSet[type]![index]!;
              const phraseVector = vector(phrase.embedding);
              if (phraseVector.length === 0) continue;
              phraseBuffer.push({ id: `hint:${id}:${type}:${index}`, factId, category, type, text: String(phrase.text || ''), vector: phraseVector });
            }
          }
          processedHints += 1;
        }
        await Promise.all([flush('global'), flush('phrase')]);
        onProgress?.(`hints ${processedHints}/${await sourceHints.countRows()}`);
      });
    }

    let processedLinks = 0;
    if (sourceLinks) {
      await rowsInBatches(sourceLinks, [
        'id', 'fromFactId', 'toFactId', 'relation', 'confidence', 'relationEmbeddingJson', 'directionEmbeddingJson',
        'exclusiveToAgentName', 'createdAt', 'updatedAt',
      ], async (rows) => {
        for (const row of rows) {
          const relationVector = vector(row.relationEmbeddingJson);
          const directionVector = vector(row.directionEmbeddingJson);
          if (!row.id || relationVector.length === 0 || directionVector.length === 0) continue;
          linkBuffer.push({
            id: String(row.id), fromFactId: String(row.fromFactId || ''), toFactId: String(row.toFactId || ''),
            relation: String(row.relation || ''), confidence: Number(row.confidence || 0),
            category: String(row.exclusiveToAgentName || '').trim().toLowerCase(), relationVector, directionVector,
            createdAt: Number(row.createdAt || 0), updatedAt: Number(row.updatedAt || 0),
          });
          processedLinks += 1;
        }
        await flush('link');
        onProgress?.(`links ${processedLinks}/${await sourceLinks.countRows()}`);
      });
    }

    await Promise.all([flush('fact', true), flush('global', true), flush('phrase', true), flush('link', true)]);
    if (!factsTable || !globalsTable || !phrasesTable || !linksTable) throw new Error('Fast memory index build produced an empty table.');
    const builtFactsTable = factsTable as lancedb.Table;
    const builtGlobalsTable = globalsTable as lancedb.Table;
    const builtPhrasesTable = phrasesTable as lancedb.Table;
    const builtLinksTable = linksTable as lancedb.Table;

    onProgress?.('creating native vector and scalar indexes');
    await Promise.all([
      builtGlobalsTable.createIndex('vector', { config: lancedb.Index.ivfPq({ distanceType: 'cosine', numPartitions: 32, numSubVectors: 64 }) }),
      builtPhrasesTable.createIndex('vector', { config: lancedb.Index.ivfPq({ distanceType: 'cosine', numPartitions: 128, numSubVectors: 64 }) }),
    ]);
    await db.createTable(this.metaName, [{
      id: 'current', version: INDEX_VERSION, factCount: await sourceFacts.countRows(),
      hintCount: sourceHints ? await sourceHints.countRows() : 0,
      linkCount: sourceLinks ? await sourceLinks.countRows() : 0,
      builtAt: Date.now(),
    }]);
    this.globals = builtGlobalsTable;
    this.phrases = builtPhrasesTable;
    this.facts = builtFactsTable;
    this.links = builtLinksTable;
    onProgress?.('ready');
  }

  private async refreshMeta(): Promise<void> {
    const db = await this.connection();
    const names = await db.tableNames();
    const [factCount, hintCount, linkCount] = await Promise.all([
      names.includes(this.sourceFactsName) ? (await db.openTable(this.sourceFactsName)).countRows() : 0,
      names.includes(this.sourceHintsName) ? (await db.openTable(this.sourceHintsName)).countRows() : 0,
      names.includes(this.sourceLinksName) ? (await db.openTable(this.sourceLinksName)).countRows() : 0,
    ]);
    if (!names.includes(this.metaName)) {
      await db.createTable(this.metaName, [{ id: 'current', version: INDEX_VERSION, factCount, hintCount, linkCount, builtAt: Date.now() }]);
      return;
    }
    const meta = await db.openTable(this.metaName);
    await meta.mergeInsert('id').whenMatchedUpdateAll().whenNotMatchedInsertAll().execute([
      { id: 'current', version: INDEX_VERSION, factCount, hintCount, linkCount, builtAt: Date.now() },
    ]);
    this.sourceCounts = { facts: factCount, hints: hintCount, links: linkCount };
  }

  async append(facts: FactRecord[], hints: RetrievalHintRecord[], links: LinkRecord[]): Promise<void> {
    if ((!this.facts || !this.globals || !this.phrases || !this.links) && !(await this.open())) return;
    const factRows: Record<string, unknown>[] = [];
    const globalRows: Record<string, unknown>[] = [];
    const phraseRows: Record<string, unknown>[] = [];
    const linkRows: Record<string, unknown>[] = [];
    for (const fact of facts) {
      const category = (fact.exclusiveToAgentName || '').trim().toLowerCase();
      factRows.push({
        id: fact.id, text: fact.text, language: fact.language, parserMode: fact.parserMode, category,
        sourceId: fact.sourceId || '', sourceLabel: fact.sourceLabel || '', createdAt: fact.createdAt, updatedAt: fact.updatedAt,
        vector: fact.globalEmbedding, npTextsJson: JSON.stringify(fact.phrases.np.map((phrase) => phrase.text)),
      });
      globalRows.push({ id: `fact:${fact.id}`, factId: fact.id, category, kind: 'fact', vector: fact.globalEmbedding });
      for (const type of ['np', 'vp', 'adjp'] as PhraseType[]) fact.phrases[type].forEach((phrase, index) => {
        phraseRows.push({ id: `fact:${fact.id}:${type}:${index}`, factId: fact.id, category, type, text: phrase.text, vector: phrase.embedding });
      });
    }
    for (const hint of hints) {
      const category = (hint.exclusiveToAgentName || '').trim().toLowerCase();
      globalRows.push({ id: `hint:${hint.id}`, factId: hint.factId, category, kind: 'hint', vector: hint.globalEmbedding });
      for (const type of ['np', 'vp', 'adjp'] as PhraseType[]) hint.phrases[type].forEach((phrase, index) => {
        phraseRows.push({ id: `hint:${hint.id}:${type}:${index}`, factId: hint.factId, category, type, text: phrase.text, vector: phrase.embedding });
      });
    }
    for (const link of links) {
      linkRows.push({
        id: link.id, fromFactId: link.fromFactId, toFactId: link.toFactId, relation: link.relation, confidence: link.confidence,
        category: (link.exclusiveToAgentName || '').trim().toLowerCase(), relationVector: link.relationEmbedding,
        directionVector: link.directionEmbedding, createdAt: link.createdAt, updatedAt: link.updatedAt,
      });
    }
    await Promise.all([
      factRows.length ? this.facts!.add(factRows) : Promise.resolve(),
      globalRows.length ? this.globals!.add(globalRows) : Promise.resolve(),
      phraseRows.length ? this.phrases!.add(phraseRows) : Promise.resolve(),
      linkRows.length ? this.links!.add(linkRows) : Promise.resolve(),
    ]);
    await this.refreshMeta();
  }

  async deleteFactIds(factIds: string[]): Promise<void> {
    if (factIds.length === 0 || ((!this.facts || !this.globals || !this.phrases || !this.links) && !(await this.open()))) return;
    for (let start = 0; start < factIds.length; start += 200) {
      const ids = factIds.slice(start, start + 200).map(quote).join(',');
      await Promise.all([
        this.facts!.delete(`id IN (${ids})`),
        this.globals!.delete(`\`factId\` IN (${ids})`),
        this.phrases!.delete(`\`factId\` IN (${ids})`),
        this.links!.delete(`\`fromFactId\` IN (${ids}) OR \`toFactId\` IN (${ids})`),
      ]);
    }
    await this.refreshMeta();
  }

  async loadFacts(): Promise<FactRecord[]> {
    if (!this.facts && !(await this.open())) return [];
    const rows = await this.facts!.query().select([
      'id', 'text', 'language', 'parserMode', 'category', 'sourceId', 'sourceLabel', 'createdAt', 'updatedAt', 'vector', 'npTextsJson',
    ]).toArray() as Record<string, unknown>[];
    return rows.map((row) => ({
      id: String(row.id), text: String(row.text || ''), language: row.language === 'ru' ? 'ru' : 'en',
      parserMode: row.parserMode === 'ud' ? 'ud' : 'constituency', globalEmbedding: vector(row.vector),
      constituency: null, dependencies: [], phrases: {
        np: parseJson<string[]>(row.npTextsJson, []).map((text) => ({ text, embedding: [] })), vp: [], adjp: [],
      },
      exclusiveToAgentName: String(row.category || '') || null, sourceId: String(row.sourceId || '') || null,
      sourceLabel: String(row.sourceLabel || '') || null, createdAt: Number(row.createdAt || 0), updatedAt: Number(row.updatedAt || 0),
    }));
  }

  async loadLinkMetadata(): Promise<LinkRecord[]> {
    if (!this.links && !(await this.open())) return [];
    const rows = await this.links!.query().select([
      'id', 'fromFactId', 'toFactId', 'relation', 'confidence', 'category', 'createdAt', 'updatedAt',
    ]).toArray() as Record<string, unknown>[];
    return rows.map((row) => ({
      id: String(row.id), fromFactId: String(row.fromFactId), toFactId: String(row.toFactId), relation: String(row.relation),
      confidence: Number(row.confidence || 0), relationEmbedding: [], directionEmbedding: [],
      exclusiveToAgentName: String(row.category || '') || null, createdAt: Number(row.createdAt || 0), updatedAt: Number(row.updatedAt || 0),
    }));
  }

  async lookupPhraseEmbeddings(phrases: Array<{ type: PhraseType; text: string }>): Promise<Map<string, number[]>> {
    if (!this.phrases && !(await this.open())) return new Map();
    const normalizedTexts = Array.from(new Set(phrases.map((phrase) => phrase.text.trim().toLowerCase()).filter(Boolean)));
    if (normalizedTexts.length === 0) return new Map();
    const found = new Map<string, number[]>();
    for (let start = 0; start < normalizedTexts.length; start += 100) {
      const values = normalizedTexts.slice(start, start + 100).map(quote).join(',');
      const rows = await this.phrases!.query()
        .where(`lower(text) IN (${values})`)
        .select(['type', 'text', 'vector'])
        .toArray() as Record<string, unknown>[];
      for (const row of rows) {
        const key = `${String(row.type)}\u0000${String(row.text || '').trim().toLowerCase()}`;
        if (!found.has(key)) found.set(key, vector(row.vector));
      }
    }
    return found;
  }

  async score(
    query: FastSearchQuery,
    aggregation: PhraseAggregationMode,
    overallEmbeddingWeight: number,
    scope: FastSearchScope,
  ): Promise<SeedFactScore[]> {
    if ((!this.globals || !this.phrases) && !(await this.open())) return [];
    if (this.sourceCounts) {
      try {
        const matrixResult = await this.matrix.scoreRaw(query, aggregation, overallEmbeddingWeight, this.sourceCounts);
        if (matrixResult) {
          const scores: SeedFactScore[] = [];
          for (let index = 0; index < matrixResult.factIds.length; index++) {
            const factId = matrixResult.factIds[index]!;
            const category = matrixResult.categories[index] || '';
            if (scope.excludedFactIds.has(factId) || !visible(category, scope)) continue;
            const multiplier = category ? (scope.categoryMultipliers?.[category] ?? 1) : 1;
            scores.push({ factId, score: Number(matrixResult.scores[index] || 0) * multiplier });
          }
          return scores.sort((a, b) => b.score - a.score);
        }
      } catch (error) {
        console.warn('[memory.fast-matrix] Falling back to Lance scoring:', error instanceof Error ? error.message : String(error));
      }
    }
    const contributions = new Map<string, { global: number; phrases: number[]; category: string }>();
    const ensure = (factId: string, category: string) => {
      let item = contributions.get(factId);
      if (!item) {
        item = { global: 0, phrases: new Array(query.phrases.length).fill(0), category };
        contributions.set(factId, item);
      }
      return item;
    };

    const globalRowsPromise = this.globals!.vectorSearch(query.globalEmbedding)
      .column('vector').distanceType('cosine').nprobes(16).refineFactor(1)
      .select(['factId', 'category', '_distance']).limit(GLOBAL_CANDIDATE_LIMIT).toArray() as Promise<Record<string, unknown>[]>;
    const phraseRowsPromises = query.phrases.map((phrase) => this.phrases!.vectorSearch(phrase.embedding)
      .column('vector').distanceType('cosine').nprobes(24).refineFactor(1)
      .where(`type = ${quote(phrase.type)}`).select(['factId', 'category', '_distance'])
      .limit(aggregation === 'sum' ? PHRASE_CANDIDATE_LIMIT * 2 : PHRASE_CANDIDATE_LIMIT).toArray() as Promise<Record<string, unknown>[]>);
    const [globalRows, phraseRows] = await Promise.all([globalRowsPromise, Promise.all(phraseRowsPromises)]);

    for (const row of globalRows) {
      const factId = String(row.factId || '');
      const category = String(row.category || '');
      if (!factId || scope.excludedFactIds.has(factId) || !visible(category, scope)) continue;
      const item = ensure(factId, category);
      item.global = Math.max(item.global, cosineDistanceToSimilarity(row._distance));
    }
    phraseRows.forEach((rows, phraseIndex) => {
      for (const row of rows) {
        const factId = String(row.factId || '');
        const category = String(row.category || '');
        if (!factId || scope.excludedFactIds.has(factId) || !visible(category, scope)) continue;
        const item = ensure(factId, category);
        const similarity = cosineDistanceToSimilarity(row._distance);
        item.phrases[phraseIndex] = aggregation === 'sum'
          ? item.phrases[phraseIndex]! + similarity
          : Math.max(item.phrases[phraseIndex]!, similarity);
      }
    });

    // ANN is only used to generate a high-recall candidate union. Lance then
    // performs exact flat cosine scans inside that much smaller union and the
    // original aggregation formula is applied without transferring vectors to JS.
    const candidateIds = Array.from(contributions.keys());
    const exact = new Map<string, { global: number; phrases: number[]; category: string }>();
    for (const [factId, item] of contributions) {
      exact.set(factId, { global: 0, phrases: new Array(query.phrases.length).fill(0), category: item.category });
    }
    const candidatePredicate = `\`factId\` IN (${candidateIds.map(quote).join(',')})`;
    const [exactGlobals, exactPhraseRows] = await Promise.all([
      this.globals!.vectorSearch(query.globalEmbedding).column('vector').distanceType('cosine').bypassVectorIndex()
        .where(candidatePredicate).select(['factId', 'category', '_distance']).limit(50_000).toArray() as Promise<Record<string, unknown>[]>,
      Promise.all(query.phrases.map((phrase) => this.phrases!.vectorSearch(phrase.embedding)
        .column('vector').distanceType('cosine').bypassVectorIndex()
        .where(`${candidatePredicate} AND type = ${quote(phrase.type)}`).select(['factId', 'category', '_distance'])
        .limit(50_000).toArray() as Promise<Record<string, unknown>[]>)),
    ]);
    for (const row of exactGlobals) {
      const item = exact.get(String(row.factId || ''));
      if (!item) continue;
      item.global = Math.max(item.global, cosineDistanceToSimilarity(row._distance));
    }
    exactPhraseRows.forEach((rows, phraseIndex) => {
      for (const row of rows) {
        const item = exact.get(String(row.factId || ''));
        if (!item) continue;
        const similarity = cosineDistanceToSimilarity(row._distance);
        item.phrases[phraseIndex] = aggregation === 'sum'
          ? item.phrases[phraseIndex]! + similarity
          : Math.max(item.phrases[phraseIndex]!, similarity);
      }
    });

    return Array.from(exact.entries()).map(([factId, item]) => {
      let score = item.global * overallEmbeddingWeight;
      for (let index = 0; index < query.phrases.length; index++) score += item.phrases[index]! * query.phrases[index]!.weight;
      score *= item.category ? (scope.categoryMultipliers?.[item.category] ?? 1) : 1;
      return { factId, score };
    }).sort((a, b) => b.score - a.score);
  }

  async searchGraph(
    queryGlobalEmbedding: number[],
    facts: FactRecord[],
    seeds: SeedFactScore[],
    scope: FastSearchScope,
    config: { maxDepth: number; maxChains: number; beamWidth: number },
  ): Promise<FastGraphResult[]> {
    if (!this.links && !(await this.open())) return [];
    const factById = new Map(facts.map((fact) => [fact.id, fact]));
    type PathState = { factIds: string[]; links: LinkRecord[]; score: number };
    let beam: PathState[] = seeds.filter((seed) => factById.has(seed.factId)).map((seed) => ({ factIds: [seed.factId], links: [], score: seed.score }));
    const completed: PathState[] = [];
    for (let depth = 0; depth < Math.max(1, config.maxDepth); depth++) {
      const fromIds = Array.from(new Set(beam.map((state) => state.factIds[state.factIds.length - 1]).filter(Boolean) as string[]));
      if (fromIds.length === 0) break;
      const predicate = `\`fromFactId\` IN (${fromIds.map(quote).join(',')})`;
      const rows = await this.links!.query().where(predicate).select([
        'id', 'fromFactId', 'toFactId', 'relation', 'confidence', 'category', 'relationVector', 'directionVector', 'createdAt', 'updatedAt',
      ]).toArray() as Record<string, unknown>[];
      const outgoing = new Map<string, LinkRecord[]>();
      for (const row of rows) {
        const category = String(row.category || '');
        if (!visible(category, scope) || !factById.has(String(row.toFactId))) continue;
        const link: LinkRecord = {
          id: String(row.id), fromFactId: String(row.fromFactId), toFactId: String(row.toFactId), relation: String(row.relation),
          confidence: Number(row.confidence || 0), relationEmbedding: vector(row.relationVector), directionEmbedding: vector(row.directionVector),
          exclusiveToAgentName: category || null, createdAt: Number(row.createdAt || 0), updatedAt: Number(row.updatedAt || 0),
        };
        const bucket = outgoing.get(link.fromFactId) || [];
        bucket.push(link);
        outgoing.set(link.fromFactId, bucket);
      }
      const next: PathState[] = [];
      for (const state of beam) {
        const currentId = state.factIds[state.factIds.length - 1]!;
        for (const link of outgoing.get(currentId) || []) {
          if (state.factIds.includes(link.toFactId)) continue;
          const relationSim = Math.max(0, dot(queryGlobalEmbedding, link.relationEmbedding));
          const alignment = Math.max(0, dot(link.relationEmbedding, link.directionEmbedding));
          const candidate = {
            factIds: [...state.factIds, link.toFactId], links: [...state.links, link],
            score: state.score + relationSim * 0.45 + alignment * 0.15 + Math.max(0, link.confidence) * 0.4,
          };
          next.push(candidate);
          completed.push(candidate);
        }
      }
      if (next.length === 0) break;
      next.sort((a, b) => b.score - a.score);
      beam = next.slice(0, Math.max(1, config.beamWidth));
    }
    const candidates = completed.length > 0 ? completed.sort((a, b) => b.score - a.score) : beam;
    const used = new Set<string>();
    const seen = new Set<string>();
    const results: FastGraphResult[] = [];
    for (const path of candidates) {
      if (path.factIds.some((id) => used.has(id))) continue;
      let text = factById.get(path.factIds[0] || '')?.text || '';
      for (let index = 0; index < path.links.length; index++) {
        const link = path.links[index]!;
        const nextFact = factById.get(path.factIds[index + 1] || '');
        if (nextFact) text += ` ->${link.relation.toUpperCase()}-> ${nextFact.text}`;
      }
      if (!text || seen.has(text)) continue;
      seen.add(text);
      path.factIds.forEach((id) => used.add(id));
      results.push({ text, factIds: path.factIds });
      if (results.length >= Math.max(1, config.maxChains)) break;
    }
    return results;
  }
}
