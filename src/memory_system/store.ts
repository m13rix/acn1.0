import * as lancedb from '@lancedb/lancedb';
import { mkdir } from 'fs/promises';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import type { FactRecord, LinkRecord, RetrievalHintRecord } from './types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', '..', 'data', 'memory');

function sanitizeTableName(value: string): string {
  const sanitized = value.replace(/[^a-zA-Z0-9_]/g, '_');
  return sanitized.length > 0 ? sanitized : 'global_memory_v2';
}

function quote(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function parseJson<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== 'string') return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function encodeNullableText(value: string | null | undefined): string {
  return typeof value === 'string' ? value : '';
}

function decodeNullableText(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export class MemoryStore {
  private readonly namespace: string;
  private db: lancedb.Connection | null = null;

  constructor(namespace: string) {
    this.namespace = sanitizeTableName(namespace);
  }

  get factsTableName(): string {
    return `${this.namespace}_facts`;
  }

  get hintsTableName(): string {
    return `${this.namespace}_hints`;
  }

  get linksTableName(): string {
    return `${this.namespace}_links`;
  }

  async initialize(): Promise<void> {
    if (this.db) return;
    await mkdir(DATA_DIR, { recursive: true });
    this.db = await lancedb.connect(DATA_DIR);
  }

  private async getDb(): Promise<lancedb.Connection> {
    if (!this.db) {
      await this.initialize();
    }
    if (!this.db) {
      throw new Error('MemoryStore database is not initialized.');
    }
    return this.db;
  }

  private async tableExists(name: string): Promise<boolean> {
    const db = await this.getDb();
    const names = await db.tableNames();
    return names.includes(name);
  }

  private async tableHasColumn(name: string, columnName: string): Promise<boolean> {
    const db = await this.getDb();
    if (!(await this.tableExists(name))) return false;
    const table = await db.openTable(name);
    const schema = await table.schema();
    return schema.fields.some((field) => field.name === columnName);
  }

  private async recreateFactsTableWithMetadata(): Promise<lancedb.Table> {
    const db = await this.getDb();
    const existingTable = await db.openTable(this.factsTableName);
    const rows = await existingTable.query().toArray();
    await db.dropTable(this.factsTableName);
    const migratedRows = rows.map((row) => ({
      id: String(row.id ?? ''),
      text: String(row.text ?? ''),
      language: row.language === 'ru' ? 'ru' : 'en',
      parserMode: row.parserMode === 'ud' ? 'ud' : 'constituency',
      globalEmbeddingJson: String(row.globalEmbeddingJson ?? '[]'),
      constituency: encodeNullableText(typeof row.constituency === 'string' ? row.constituency : null),
      dependenciesJson: String(row.dependenciesJson ?? '[]'),
      phrasesJson: String(row.phrasesJson ?? '{"np":[],"vp":[],"adjp":[]}'),
      exclusiveToAgentName: '',
      sourceId: encodeNullableText(typeof row.sourceId === 'string' ? row.sourceId : null),
      sourceLabel: encodeNullableText(typeof row.sourceLabel === 'string' ? row.sourceLabel : null),
      createdAt: Number(row.createdAt ?? Date.now()),
      updatedAt: Number(row.updatedAt ?? Date.now()),
    })).filter((row) => row.id && row.text);
    if (migratedRows.length > 0) {
      return db.createTable(this.factsTableName, migratedRows);
    }
    const table = await db.createTable(this.factsTableName, [{
      id: '__init__',
      text: '',
      language: 'en',
      parserMode: 'constituency',
      globalEmbeddingJson: '[]',
      constituency: '',
      dependenciesJson: '[]',
      phrasesJson: '{"np":[],"vp":[],"adjp":[]}',
      exclusiveToAgentName: '',
      sourceId: '',
      sourceLabel: '',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }]);
    await table.delete('id = "__init__"');
    return table;
  }

  private async recreateHintsTableWithScope(): Promise<lancedb.Table> {
    const db = await this.getDb();
    const existingTable = await db.openTable(this.hintsTableName);
    const rows = await existingTable.query().toArray();
    await db.dropTable(this.hintsTableName);
    const migratedRows = rows.map((row) => ({
      id: String(row.id ?? ''),
      factId: String(row.factId ?? ''),
      text: String(row.text ?? ''),
      language: row.language === 'ru' ? 'ru' : 'en',
      parserMode: row.parserMode === 'ud' ? 'ud' : 'constituency',
      globalEmbeddingJson: String(row.globalEmbeddingJson ?? '[]'),
      constituency: encodeNullableText(typeof row.constituency === 'string' ? row.constituency : null),
      dependenciesJson: String(row.dependenciesJson ?? '[]'),
      phrasesJson: String(row.phrasesJson ?? '{"np":[],"vp":[],"adjp":[]}'),
      exclusiveToAgentName: '',
      createdAt: Number(row.createdAt ?? Date.now()),
      updatedAt: Number(row.updatedAt ?? Date.now()),
    })).filter((row) => row.id && row.factId && row.text);
    if (migratedRows.length > 0) {
      return db.createTable(this.hintsTableName, migratedRows);
    }
    const table = await db.createTable(this.hintsTableName, [{
      id: '__init__',
      factId: '',
      text: '',
      language: 'en',
      parserMode: 'constituency',
      globalEmbeddingJson: '[]',
      constituency: '',
      dependenciesJson: '[]',
      phrasesJson: '{"np":[],"vp":[],"adjp":[]}',
      exclusiveToAgentName: '',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }]);
    await table.delete('id = "__init__"');
    return table;
  }

  private async recreateLinksTableWithScope(): Promise<lancedb.Table> {
    const db = await this.getDb();
    const existingTable = await db.openTable(this.linksTableName);
    const rows = await existingTable.query().toArray();
    await db.dropTable(this.linksTableName);
    const migratedRows = rows.map((row) => ({
      id: String(row.id ?? ''),
      fromFactId: String(row.fromFactId ?? ''),
      toFactId: String(row.toFactId ?? ''),
      relation: String(row.relation ?? ''),
      confidence: Number(row.confidence ?? 0),
      relationEmbeddingJson: String(row.relationEmbeddingJson ?? '[]'),
      directionEmbeddingJson: String(row.directionEmbeddingJson ?? '[]'),
      exclusiveToAgentName: '',
      createdAt: Number(row.createdAt ?? Date.now()),
      updatedAt: Number(row.updatedAt ?? Date.now()),
    })).filter((row) => row.id && row.fromFactId && row.toFactId && row.relation);
    if (migratedRows.length > 0) {
      return db.createTable(this.linksTableName, migratedRows);
    }
    const table = await db.createTable(this.linksTableName, [{
      id: '__init__',
      fromFactId: '',
      toFactId: '',
      relation: '',
      confidence: 0,
      relationEmbeddingJson: '[]',
      directionEmbeddingJson: '[]',
      exclusiveToAgentName: '',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }]);
    await table.delete('id = "__init__"');
    return table;
  }

  private async ensureFactsTable(): Promise<lancedb.Table> {
    const db = await this.getDb();
    if (await this.tableExists(this.factsTableName)) {
      const hasScope = await this.tableHasColumn(this.factsTableName, 'exclusiveToAgentName');
      const hasSourceId = await this.tableHasColumn(this.factsTableName, 'sourceId');
      const hasSourceLabel = await this.tableHasColumn(this.factsTableName, 'sourceLabel');
      if (!hasScope || !hasSourceId || !hasSourceLabel) {
        return this.recreateFactsTableWithMetadata();
      }
      return db.openTable(this.factsTableName);
    }

    const table = await db.createTable(this.factsTableName, [{
      id: '__init__',
      text: '',
      language: 'en',
      parserMode: 'constituency',
      globalEmbeddingJson: '[]',
      constituency: '',
      dependenciesJson: '[]',
      phrasesJson: '{"np":[],"vp":[],"adjp":[]}',
      exclusiveToAgentName: '',
      sourceId: '',
      sourceLabel: '',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }]);
    await table.delete('id = "__init__"');
    return table;
  }

  private async ensureHintsTable(): Promise<lancedb.Table> {
    const db = await this.getDb();
    if (await this.tableExists(this.hintsTableName)) {
      if (!(await this.tableHasColumn(this.hintsTableName, 'exclusiveToAgentName'))) {
        return this.recreateHintsTableWithScope();
      }
      return db.openTable(this.hintsTableName);
    }

    const table = await db.createTable(this.hintsTableName, [{
      id: '__init__',
      factId: '',
      text: '',
      language: 'en',
      parserMode: 'constituency',
      globalEmbeddingJson: '[]',
      constituency: '',
      dependenciesJson: '[]',
      phrasesJson: '{"np":[],"vp":[],"adjp":[]}',
      exclusiveToAgentName: '',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }]);
    await table.delete('id = "__init__"');
    return table;
  }

  private async ensureLinksTable(): Promise<lancedb.Table> {
    const db = await this.getDb();
    if (await this.tableExists(this.linksTableName)) {
      if (!(await this.tableHasColumn(this.linksTableName, 'exclusiveToAgentName'))) {
        return this.recreateLinksTableWithScope();
      }
      return db.openTable(this.linksTableName);
    }

    const table = await db.createTable(this.linksTableName, [{
      id: '__init__',
      fromFactId: '',
      toFactId: '',
      relation: '',
      confidence: 0,
      relationEmbeddingJson: '[]',
      directionEmbeddingJson: '[]',
      exclusiveToAgentName: '',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }]);
    await table.delete('id = "__init__"');
    return table;
  }

  async getAllFacts(): Promise<FactRecord[]> {
    const db = await this.getDb();
    if (!(await this.tableExists(this.factsTableName))) return [];

    const table = await db.openTable(this.factsTableName);
    const rows = await table.query().toArray();

    return rows
      .map((row) => {
        const id = String(row.id ?? '');
        const text = String(row.text ?? '');
        if (!id || !text) return null;

        return {
          id,
          text,
          language: row.language === 'ru' ? 'ru' : 'en',
          parserMode: row.parserMode === 'ud' ? 'ud' : 'constituency',
          globalEmbedding: parseJson<number[]>(row.globalEmbeddingJson, []),
          constituency: decodeNullableText(row.constituency),
          dependencies: parseJson(row.dependenciesJson, []),
          phrases: parseJson(row.phrasesJson, { np: [], vp: [], adjp: [] }),
          exclusiveToAgentName: decodeNullableText(row.exclusiveToAgentName),
          sourceId: decodeNullableText(row.sourceId),
          sourceLabel: decodeNullableText(row.sourceLabel),
          createdAt: Number(row.createdAt ?? 0),
          updatedAt: Number(row.updatedAt ?? 0),
        } as FactRecord;
      })
      .filter((row): row is FactRecord => Boolean(row));
  }

  async getAllHints(): Promise<RetrievalHintRecord[]> {
    const db = await this.getDb();
    if (!(await this.tableExists(this.hintsTableName))) return [];

    const table = await db.openTable(this.hintsTableName);
    const rows = await table.query().toArray();

    return rows
      .map((row) => {
        const id = String(row.id ?? '');
        const factId = String(row.factId ?? '');
        const text = String(row.text ?? '');
        if (!id || !factId || !text) return null;

        return {
          id,
          factId,
          text,
          language: row.language === 'ru' ? 'ru' : 'en',
          parserMode: row.parserMode === 'ud' ? 'ud' : 'constituency',
          globalEmbedding: parseJson<number[]>(row.globalEmbeddingJson, []),
          constituency: decodeNullableText(row.constituency),
          dependencies: parseJson(row.dependenciesJson, []),
          phrases: parseJson(row.phrasesJson, { np: [], vp: [], adjp: [] }),
          exclusiveToAgentName: decodeNullableText(row.exclusiveToAgentName),
          createdAt: Number(row.createdAt ?? 0),
          updatedAt: Number(row.updatedAt ?? 0),
        } as RetrievalHintRecord;
      })
      .filter((row): row is RetrievalHintRecord => Boolean(row));
  }

  async getAllLinks(): Promise<LinkRecord[]> {
    const db = await this.getDb();
    if (!(await this.tableExists(this.linksTableName))) return [];

    const table = await db.openTable(this.linksTableName);
    const rows = await table.query().toArray();

    return rows
      .map((row) => {
        const id = String(row.id ?? '');
        const fromFactId = String(row.fromFactId ?? '');
        const toFactId = String(row.toFactId ?? '');
        const relation = String(row.relation ?? '');
        if (!id || !fromFactId || !toFactId || !relation) return null;

        return {
          id,
          fromFactId,
          toFactId,
          relation,
          confidence: Number(row.confidence ?? 0),
          relationEmbedding: parseJson<number[]>(row.relationEmbeddingJson, []),
          directionEmbedding: parseJson<number[]>(row.directionEmbeddingJson, []),
          exclusiveToAgentName: decodeNullableText(row.exclusiveToAgentName),
          createdAt: Number(row.createdAt ?? 0),
          updatedAt: Number(row.updatedAt ?? 0),
        } as LinkRecord;
      })
      .filter((row): row is LinkRecord => Boolean(row));
  }

  async addFacts(facts: FactRecord[]): Promise<void> {
    if (facts.length === 0) return;
    const table = await this.ensureFactsTable();
    await table.add(facts.map((fact) => ({
      id: fact.id,
      text: fact.text,
      language: fact.language,
      parserMode: fact.parserMode,
      globalEmbeddingJson: JSON.stringify(fact.globalEmbedding),
      constituency: encodeNullableText(fact.constituency),
      dependenciesJson: JSON.stringify(fact.dependencies),
      phrasesJson: JSON.stringify(fact.phrases),
      exclusiveToAgentName: encodeNullableText(fact.exclusiveToAgentName),
      sourceId: encodeNullableText(fact.sourceId),
      sourceLabel: encodeNullableText(fact.sourceLabel),
      createdAt: fact.createdAt,
      updatedAt: fact.updatedAt,
    })));
  }

  async addHints(hints: RetrievalHintRecord[]): Promise<void> {
    if (hints.length === 0) return;
    const table = await this.ensureHintsTable();
    await table.add(hints.map((hint) => ({
      id: hint.id,
      factId: hint.factId,
      text: hint.text,
      language: hint.language,
      parserMode: hint.parserMode,
      globalEmbeddingJson: JSON.stringify(hint.globalEmbedding),
      constituency: encodeNullableText(hint.constituency),
      dependenciesJson: JSON.stringify(hint.dependencies),
      phrasesJson: JSON.stringify(hint.phrases),
      exclusiveToAgentName: encodeNullableText(hint.exclusiveToAgentName),
      createdAt: hint.createdAt,
      updatedAt: hint.updatedAt,
    })));
  }

  async addLinks(links: LinkRecord[]): Promise<void> {
    if (links.length === 0) return;
    const table = await this.ensureLinksTable();
    await table.add(links.map((link) => ({
      id: link.id,
      fromFactId: link.fromFactId,
      toFactId: link.toFactId,
      relation: link.relation,
      confidence: link.confidence,
      relationEmbeddingJson: JSON.stringify(link.relationEmbedding),
      directionEmbeddingJson: JSON.stringify(link.directionEmbedding),
      exclusiveToAgentName: encodeNullableText(link.exclusiveToAgentName),
      createdAt: link.createdAt,
      updatedAt: link.updatedAt,
    })));
  }

  async deleteFactsByIds(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    const db = await this.getDb();
    if (!(await this.tableExists(this.factsTableName))) return;
    const table = await db.openTable(this.factsTableName);
    await table.delete(`id IN (${ids.map(quote).join(',')})`);
  }

  async getFactIdsBySourceId(sourceId: string): Promise<string[]> {
    const normalizedSourceId = sourceId.trim();
    if (!normalizedSourceId) return [];
    const facts = await this.getAllFacts();
    return facts
      .filter((fact) => fact.sourceId === normalizedSourceId)
      .map((fact) => fact.id);
  }

  async deleteFactsBySourceId(sourceId: string): Promise<string[]> {
    const factIds = await this.getFactIdsBySourceId(sourceId);
    if (factIds.length === 0) {
      return [];
    }

    await Promise.all([
      this.deleteLinksByFactIds(factIds),
      this.deleteHintsByFactIds(factIds),
      this.deleteFactsByIds(factIds),
    ]);
    return factIds;
  }

  async deleteHintsByFactIds(factIds: string[]): Promise<void> {
    if (factIds.length === 0) return;
    const db = await this.getDb();
    if (!(await this.tableExists(this.hintsTableName))) return;
    const table = await db.openTable(this.hintsTableName);
    await table.delete(`factId IN (${factIds.map(quote).join(',')})`);
  }

  async deleteLinksByFactIds(factIds: string[]): Promise<void> {
    if (factIds.length === 0) return;
    const db = await this.getDb();
    if (!(await this.tableExists(this.linksTableName))) return;
    const table = await db.openTable(this.linksTableName);
    const inExpr = `(${factIds.map(quote).join(',')})`;
    await table.delete(`fromFactId IN ${inExpr} OR toFactId IN ${inExpr}`);
  }
}
