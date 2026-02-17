import * as lancedb from '@lancedb/lancedb';
import { mkdir } from 'fs/promises';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import type { FactRecord, LinkRecord } from './types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', '..', 'data', 'memory');

function sanitizeTableName(value: string): string {
  const sanitized = value.replace(/[^a-zA-Z0-9_]/g, '_');
  return sanitized.length > 0 ? sanitized : 'global_memory';
}

function quote(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function parseJsonArray<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== 'string') return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
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

  private async ensureFactsTable(): Promise<lancedb.Table> {
    const db = await this.getDb();
    if (await this.tableExists(this.factsTableName)) {
      return db.openTable(this.factsTableName);
    }

    const seed = {
      id: '__init__',
      text: '',
      confidence: 0,
      embeddingJson: '[]',
      topicsJson: '[]',
      topicEmbeddingsJson: '[]',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    const table = await db.createTable(this.factsTableName, [seed]);
    await table.delete('id = "__init__"');
    return table;
  }

  private async ensureLinksTable(): Promise<lancedb.Table> {
    const db = await this.getDb();
    if (await this.tableExists(this.linksTableName)) {
      return db.openTable(this.linksTableName);
    }

    const seed = {
      id: '__init__',
      fromFactId: '',
      toFactId: '',
      relation: '',
      confidence: 0,
      relationEmbeddingJson: '[]',
      directionEmbeddingJson: '[]',
      isManual: false,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    const table = await db.createTable(this.linksTableName, [seed]);
    await table.delete('id = "__init__"');
    return table;
  }

  async getAllFacts(): Promise<FactRecord[]> {
    const db = await this.getDb();
    if (!(await this.tableExists(this.factsTableName))) return [];

    const table = await db.openTable(this.factsTableName);
    const rows = await table.query().toArray();

    const mapped: FactRecord[] = [];
    for (const row of rows) {
      const id = String(row.id ?? '');
      const text = String(row.text ?? '');
      const confidence = Number(row.confidence ?? 0);
      const createdAt = Number(row.createdAt ?? 0);
      const updatedAt = Number(row.updatedAt ?? 0);
      if (!id || !text) continue;

      mapped.push({
        id,
        text,
        confidence,
        embedding: parseJsonArray<number[]>(row.embeddingJson, []),
        topics: parseJsonArray<string[]>(row.topicsJson, []),
        topicEmbeddings: parseJsonArray<number[][]>(row.topicEmbeddingsJson, []),
        createdAt,
        updatedAt,
      });
    }

    return mapped;
  }

  async getAllLinks(): Promise<LinkRecord[]> {
    const db = await this.getDb();
    if (!(await this.tableExists(this.linksTableName))) return [];

    const table = await db.openTable(this.linksTableName);
    const rows = await table.query().toArray();

    const mapped: LinkRecord[] = [];
    for (const row of rows) {
      const id = String(row.id ?? '');
      const fromFactId = String(row.fromFactId ?? '');
      const toFactId = String(row.toFactId ?? '');
      const relation = String(row.relation ?? '');
      const confidence = Number(row.confidence ?? 0);
      const isManual = Boolean(row.isManual ?? false);
      const createdAt = Number(row.createdAt ?? 0);
      const updatedAt = Number(row.updatedAt ?? 0);
      if (!id || !fromFactId || !toFactId || !relation) continue;

      mapped.push({
        id,
        fromFactId,
        toFactId,
        relation,
        confidence,
        relationEmbedding: parseJsonArray<number[]>(row.relationEmbeddingJson, []),
        directionEmbedding: parseJsonArray<number[]>(row.directionEmbeddingJson, []),
        isManual,
        createdAt,
        updatedAt,
      });
    }

    return mapped;
  }

  async addFacts(facts: FactRecord[]): Promise<void> {
    if (facts.length === 0) return;
    const table = await this.ensureFactsTable();
    await table.add(facts.map(fact => ({
      id: fact.id,
      text: fact.text,
      confidence: fact.confidence,
      embeddingJson: JSON.stringify(fact.embedding),
      topicsJson: JSON.stringify(fact.topics),
      topicEmbeddingsJson: JSON.stringify(fact.topicEmbeddings),
      createdAt: fact.createdAt,
      updatedAt: fact.updatedAt,
    })));
  }

  async addLinks(links: LinkRecord[]): Promise<void> {
    if (links.length === 0) return;
    const table = await this.ensureLinksTable();
    await table.add(links.map(link => ({
      id: link.id,
      fromFactId: link.fromFactId,
      toFactId: link.toFactId,
      relation: link.relation,
      confidence: link.confidence,
      relationEmbeddingJson: JSON.stringify(link.relationEmbedding),
      directionEmbeddingJson: JSON.stringify(link.directionEmbedding),
      isManual: link.isManual,
      createdAt: link.createdAt,
      updatedAt: link.updatedAt,
    })));
  }

  async deleteFactsByIds(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    const db = await this.getDb();
    if (!(await this.tableExists(this.factsTableName))) return;
    const table = await db.openTable(this.factsTableName);
    const expr = `id IN (${ids.map(quote).join(',')})`;
    await table.delete(expr);
  }

  async deleteLinksByIds(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    const db = await this.getDb();
    if (!(await this.tableExists(this.linksTableName))) return;
    const table = await db.openTable(this.linksTableName);
    const expr = `id IN (${ids.map(quote).join(',')})`;
    await table.delete(expr);
  }

  async deleteLinksByFactIds(factIds: string[]): Promise<void> {
    if (factIds.length === 0) return;
    const db = await this.getDb();
    if (!(await this.tableExists(this.linksTableName))) return;
    const table = await db.openTable(this.linksTableName);
    const inExpr = `(${factIds.map(quote).join(',')})`;
    const expr = `fromFactId IN ${inExpr} OR toFactId IN ${inExpr}`;
    await table.delete(expr);
  }
}
