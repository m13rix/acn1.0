/**
 * Skills Service
 *
 * Central service for managing agent skills retrieval using example-based semantic matching.
 */

import { embed, embedBatch } from './embeddings.js';
import { retrieve, SkillEntry, DEFAULT_SCORE_THRESHOLD } from './retriever.js';
import * as lancedb from '@lancedb/lancedb';
import { v4 as uuidv4 } from 'uuid';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import type { Message, ToolSkillEntry } from '../types/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', '..', 'data', 'skills');
const SEARCH_CACHE_LIMIT = 32;
const SEARCH_TEXT_MAX_CHARS = 12_000;

export interface SearchableMessage {
  role: Message['role'];
  content: string;
  filename?: string;
  toolName?: string;
}

/**
 * Default score threshold for automated skill retrieval (85%)
 */
export const SCORE_THRESHOLD = DEFAULT_SCORE_THRESHOLD;

/**
 * Result from automatic skills search (returns multiple entries)
 */
export interface SkillsSearchResult {
  entries: Array<{
    content: string;
    score: number;
    entry: SkillEntry;
  }>;
  topScore: number | null;
  query: string;
}

/**
 * Result from manual skills search (single entry with score)
 */
export interface ManualSearchResult {
  content: string;
  score: number;
  entry: SkillEntry;
}

/**
 * Skills Service - manages skill retrieval for a single agent
 */
export class SkillsService {
  private tableName?: string;
  private db: lancedb.Connection | null = null;
  private initialized = false;
  private entriesCache: SkillEntry[] | null = null;
  private localEntriesCache: SkillEntry[] | null = null;
  private readonly searchCache = new Map<string, SkillsSearchResult>();
  private readonly localEntries: ToolSkillEntry[];

  constructor(tableName?: string, localEntries: ToolSkillEntry[] = []) {
    this.tableName = tableName;
    this.localEntries = localEntries;
  }

  /**
   * Initialize the service and connect to LanceDB
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    if (this.tableName) {
      this.db = await lancedb.connect(DATA_DIR);
    }
    this.initialized = true;
  }

  private async getTableEntries(): Promise<SkillEntry[]> {
    if (!this.tableName || !this.db) {
      return [];
    }

    try {
      const table = await this.db.openTable(this.tableName);
      const results = await table.query().toArray();

      const mapped: (SkillEntry | null)[] = results.map(row => {
        let exampleVectors: number[][] = [];
        try {
          const vectorsJson = row.exampleVectorsJson as string | undefined;
          if (vectorsJson) {
            exampleVectors = JSON.parse(vectorsJson);
          }
        } catch {
          return null;
        }

        let examples: string[] = [];
        try {
          if (row.examples) {
            if (Array.isArray(row.examples)) {
              examples = row.examples as string[];
            } else if (typeof row.examples === 'string') {
              examples = JSON.parse(row.examples);
            } else if (typeof row.examples === 'object' && row.examples !== null) {
              try {
                examples = Array.from(row.examples as any) as string[];
              } catch {
                if ('toArray' in row.examples && typeof (row.examples as any).toArray === 'function') {
                  examples = (row.examples as any).toArray() as string[];
                }
              }
            }
          }
        } catch {
          return null;
        }

        if (!examples || examples.length === 0 || !exampleVectors || exampleVectors.length === 0) {
          return null;
        }

        if (exampleVectors.length !== examples.length) {
          return null;
        }

        return {
          id: row.id as string,
          content: row.content as string,
          examples,
          exampleVectors,
          scoreThreshold: row.scoreThreshold as number | undefined,
          updatedAt: row.updatedAt as number,
        };
      });

      return mapped.filter((entry): entry is SkillEntry => entry !== null);
    } catch {
      return [];
    }
  }

  private async getLocalEntries(): Promise<SkillEntry[]> {
    if (this.localEntriesCache) {
      return this.localEntriesCache;
    }

    const normalized = this.localEntries
      .filter((entry) => entry.content.trim() && entry.examples.length > 0)
      .map((entry) => ({
        ...entry,
        content: entry.content.trim(),
        examples: entry.examples.map((example) => example.trim()).filter(Boolean),
      }))
      .filter((entry) => entry.examples.length > 0);

    if (normalized.length === 0) {
      this.localEntriesCache = [];
      return this.localEntriesCache;
    }

    const vectorSets = await Promise.all(normalized.map((entry) => embedBatch(entry.examples)));
    this.localEntriesCache = normalized.map((entry, index) => ({
      id: entry.id,
      content: entry.content,
      examples: entry.examples,
      exampleVectors: vectorSets[index] || [],
      scoreThreshold: entry.scoreThreshold,
      updatedAt: entry.updatedAt,
    }));

    return this.localEntriesCache;
  }

  /**
   * Get all entries from the skills table
   * Filters out entries without examples (backward incompatible)
   */
  private async getEntries(): Promise<SkillEntry[]> {
    if (this.entriesCache) {
      return this.entriesCache;
    }

    const [tableEntries, localEntries] = await Promise.all([
      this.getTableEntries(),
      this.getLocalEntries(),
    ]);

    this.entriesCache = [...tableEntries, ...localEntries];
    return this.entriesCache;
  }

  private rememberSearch(key: string, result: SkillsSearchResult): void {
    if (this.searchCache.has(key)) {
      this.searchCache.delete(key);
    }
    this.searchCache.set(key, result);

    if (this.searchCache.size > SEARCH_CACHE_LIMIT) {
      const oldestKey = this.searchCache.keys().next().value;
      if (oldestKey) {
        this.searchCache.delete(oldestKey);
      }
    }
  }

  private invalidateSearchCache(): void {
    this.searchCache.clear();
  }

  static buildHistorySearchQuery(messages: SearchableMessage[]): string {
    if (!messages.length) {
      return '';
    }

    const prepared = messages
      .filter(message => message.role !== 'system')
      .map((message, index, all) => {
        const rawContent = String(message.content || '').replace(/\s+/g, ' ').trim();
        if (!rawContent) return null;

        const recencyRatio = all.length <= 1 ? 1 : index / (all.length - 1);
        const maxChars = Math.round(220 + (recencyRatio * 980));
        const roleLabel = message.role === 'tool' && message.toolName
          ? `TOOL:${message.toolName}`
          : message.role.toUpperCase();
        const fileLabel = message.filename ? ` (${message.filename})` : '';
        return {
          prefix: `[${roleLabel}${fileLabel}] `,
          rawContent,
          maxChars,
        };
      })
      .filter((entry): entry is { prefix: string; rawContent: string; maxChars: number } => Boolean(entry));

    if (prepared.length === 0) {
      return '';
    }

    const separatorChars = Math.max(0, prepared.length - 1);
    const prefixChars = prepared.reduce((sum, entry) => sum + entry.prefix.length, 0);
    const availableContentChars = Math.max(0, SEARCH_TEXT_MAX_CHARS - separatorChars - prefixChars);
    const desiredChars = prepared.map(entry => Math.min(entry.rawContent.length, entry.maxChars));

    let allocatedChars = [...desiredChars];
    let totalAllocated = allocatedChars.reduce((sum, value) => sum + value, 0);

    if (totalAllocated > availableContentChars) {
      const floorChars = prepared.map(entry => Math.min(entry.rawContent.length, 12));
      const evenShare = Math.max(12, Math.floor(availableContentChars / prepared.length));
      allocatedChars = prepared.map((entry, index) =>
        Math.min(desiredChars[index]!, Math.max(floorChars[index]!, Math.min(entry.rawContent.length, evenShare)))
      );
      totalAllocated = allocatedChars.reduce((sum, value) => sum + value, 0);

      while (totalAllocated > availableContentChars) {
        let changed = false;
        for (let i = 0; i < allocatedChars.length && totalAllocated > availableContentChars; i++) {
          const floor = floorChars[i]!;
          if (allocatedChars[i]! > floor) {
            allocatedChars[i] = allocatedChars[i]! - 1;
            totalAllocated--;
            changed = true;
          }
        }
        if (!changed) {
          break;
        }
      }
    }

    return prepared
      .map((entry, index) => {
        const allowed = allocatedChars[index]!;
        const clipped = entry.rawContent.length > allowed
          ? `${entry.rawContent.slice(0, Math.max(0, allowed - 3))}...`
          : entry.rawContent;
        return `${entry.prefix}${clipped}`;
      })
      .join('\n');
  }

  /**
   * Search for skills (automated retrieval using example-based matching)
   * Accepts either a direct query string or full conversation history.
   */
  async search(queryOrMessages: string | SearchableMessage[]): Promise<SkillsSearchResult> {
    if (!this.initialized) {
      await this.initialize();
    }

    const query = Array.isArray(queryOrMessages)
      ? SkillsService.buildHistorySearchQuery(queryOrMessages)
      : String(queryOrMessages || '').trim();

    const entries = await this.getEntries();
    if (!query || entries.length === 0) {
      return {
        entries: [],
        topScore: null,
        query,
      };
    }

    const cached = this.searchCache.get(query);
    if (cached) {
      return cached;
    }

    const result = await retrieve(query, entries, SCORE_THRESHOLD, true);
    const topScore = result.entries[0]?.score ?? null;

    const matchingEntries = result.entries
      .filter(scored => scored.matched && scored.score >= SCORE_THRESHOLD)
      .map(scored => ({
        content: scored.entry.content,
        score: scored.score,
        entry: scored.entry
      }));

    const searchResult: SkillsSearchResult = {
      entries: matchingEntries,
      topScore,
      query,
    };
    this.rememberSearch(query, searchResult);

    return searchResult;
  }

  /**
   * Search specifically from full message history.
   */
  async searchHistory(messages: SearchableMessage[]): Promise<SkillsSearchResult> {
    return this.search(messages);
  }

  /**
   * Search using a raw query string.
   */
  async searchQuery(query: string): Promise<SkillsSearchResult> {
    return this.search(query);
  }

  /**
   * Result from the most recent retrieval-ready entries only.
   */
  async searchMatches(queryOrMessages: string | SearchableMessage[]): Promise<SkillsSearchResult> {
    return this.search(queryOrMessages);
  }

  /**
   * Manual search (for system.search tool)
   * Uses direct content comparison - embeds content and compares to query
   * Returns top result regardless of score
   */
  async manualSearch(query: string): Promise<ManualSearchResult | null> {
    if (!this.initialized) {
      await this.initialize();
    }

    const entries = await this.getEntries();
    if (entries.length === 0) {
      return null;
    }

    // For manual search, compare query against the first example of each entry
    // (as a simple approximation of content comparison)
    const { cosineSimilarity } = await import('./embeddings.js');
    const queryVector = await embed(query);

    const scored: Array<{ entry: SkillEntry; score: number }> = [];

    for (const entry of entries) {
      if (entry.exampleVectors.length === 0) continue;

      // Use first example vector as proxy for content (simple approach)
      const firstVector = entry.exampleVectors[0];
      if (!firstVector) continue;

      const similarity = cosineSimilarity(queryVector, firstVector);
      scored.push({ entry, score: similarity });
    }

    if (scored.length === 0) {
      return null;
    }

    // Sort by score descending and return top result
    scored.sort((a, b) => b.score - a.score);
    const topResult = scored[0];

    if (!topResult) {
      return null;
    }

    return {
      content: topResult.entry.content,
      score: topResult.score,
      entry: topResult.entry
    };
  }

  /**
   * Add a new entry to the knowledge base
   * @param content - The skill/knowledge content
   * @param examples - Array of example queries/requests when this entry should be retrieved (required)
   * @param scoreThreshold - Optional similarity threshold (default: 0.82)
   */
  async addEntry(
    content: string,
    examples: string[],
    scoreThreshold?: number
  ): Promise<{ success: boolean; id: string }> {
    if (!this.initialized) {
      await this.initialize();
    }

    if (!this.db) {
      throw new Error('SkillsService not initialized');
    }
    if (!this.tableName) {
      throw new Error('Cannot add entries without a skillsTable.');
    }

    // Validate examples
    if (!examples || examples.length === 0) {
      throw new Error('At least one example is required');
    }

    // Embed all examples
    const exampleVectors = await embedBatch(examples);

    if (exampleVectors.length !== examples.length) {
      throw new Error('Failed to embed all examples');
    }

    const id = uuidv4();

    const updatedAt = Date.now();
    const tableEntry = {
      id,
      content,
      examples,
      exampleVectorsJson: JSON.stringify(exampleVectors),
      scoreThreshold: scoreThreshold ?? DEFAULT_SCORE_THRESHOLD,
      updatedAt,
    };

    try {
      const table = await this.db.openTable(this.tableName);
      await table.add([tableEntry]);
    } catch {
      // Table doesn't exist, create it
      await this.db.createTable(this.tableName, [tableEntry]);
    }

    this.entriesCache = [...(this.entriesCache || []), {
      id,
      content,
      examples,
      exampleVectors,
      scoreThreshold: scoreThreshold ?? DEFAULT_SCORE_THRESHOLD,
      updatedAt,
    }];
    this.invalidateSearchCache();

    return { success: true, id };
  }

  /**
   * Clear message history (deprecated - no longer used)
   */
  clearHistory(): void {
    // No-op: message history removed in new system
  }

  /**
   * Get current message history length (deprecated - always returns 0)
   */
  getHistoryLength(): number {
    return 0;  // Message history removed in new system
  }

  /**
   * Clear pre-embedded words (deprecated - no longer used)
   */
  clearPreEmbeddedWords(): void {
    // No-op: pre-embedding removed in new system
  }

  /**
   * Get the table name this service is using
   */
  getTableName(): string {
    return this.tableName || '';
  }
}
