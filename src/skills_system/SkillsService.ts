/**
 * Skills Service
 * 
 * Central service for managing agent skills retrieval using example-based semantic matching.
 */

import { embed, embedBatch } from './embeddings.js';
import { retrieve, SkillEntry, ScoredEntry, DEFAULT_SCORE_THRESHOLD } from './retriever.js';
import * as lancedb from '@lancedb/lancedb';
import { v4 as uuidv4 } from 'uuid';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', '..', 'data', 'skills');

/**
 * Default score threshold for automated skill retrieval (80%)
 */
export const SCORE_THRESHOLD = 0.8;

/**
 * Result from automatic skills search (returns multiple entries)
 */
export interface SkillsSearchResult {
  entries: Array<{
    content: string;
    score: number;
    entry: SkillEntry;
  }>;
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
  private tableName: string;
  private db: lancedb.Connection | null = null;
  private initialized = false;

  constructor(tableName: string) {
    this.tableName = tableName;
  }

  /**
   * Initialize the service and connect to LanceDB
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;
    
    this.db = await lancedb.connect(DATA_DIR);
    this.initialized = true;
  }

  /**
   * Get all entries from the skills table
   * Filters out entries without examples (backward incompatible)
   */
  private async getEntries(): Promise<SkillEntry[]> {
    if (!this.db) {
      throw new Error('SkillsService not initialized');
    }

    try {
      const table = await this.db.openTable(this.tableName);
      const results = await table.query().toArray();
      
      const mapped: (SkillEntry | null)[] = results.map(row => {
        // Parse exampleVectors from JSON string
        let exampleVectors: number[][] = [];
        try {
          const vectorsJson = row.exampleVectorsJson as string | undefined;
          if (vectorsJson) {
            exampleVectors = JSON.parse(vectorsJson);
          }
        } catch (e) {
          // Invalid JSON or missing field - skip this entry (backward incompatible)
          return null;
        }
        
        // Parse examples array - handle LanceDB/Arrow arrays
        let examples: string[] = [];
        try {
          if (row.examples) {
            if (Array.isArray(row.examples)) {
              examples = row.examples as string[];
            } else if (typeof row.examples === 'string') {
              examples = JSON.parse(row.examples);
            } else if (typeof row.examples === 'object' && row.examples !== null) {
              // Handle LanceDB/Arrow arrays - they're array-like objects that need conversion
              // LanceDB returns Arrow arrays which are not native JS arrays but are iterable
              try {
                examples = Array.from(row.examples as any) as string[];
              } catch (conversionError) {
                // If Array.from() fails, try other methods
                if ('toArray' in row.examples && typeof (row.examples as any).toArray === 'function') {
                  examples = (row.examples as any).toArray() as string[];
                } else {
                  // Last resort: try spreading (may fail if not iterable)
                  try {
                    examples = [...(row.examples as any)] as string[];
                  } catch (spreadError) {
                    // Cannot convert - will be filtered out below
                  }
                }
              }
            }
          }
        } catch (e) {
          // Invalid examples - skip this entry (backward incompatible)
          return null;
        }
        
        // Filter out entries without examples (backward incompatible)
        if (!examples || examples.length === 0 || !exampleVectors || exampleVectors.length === 0) {
          return null;
        }
        
        // Ensure exampleVectors and examples arrays match in length
        if (exampleVectors.length !== examples.length) {
          return null;
        }
        
        return {
          id: row.id as string,
          content: row.content as string,
          examples,
          exampleVectors,
          scoreThreshold: row.scoreThreshold as number | undefined,
          updatedAt: row.updatedAt as number
        };
      });
      
      return mapped.filter((entry): entry is SkillEntry => entry !== null);
    } catch (error) {
      // Table might not exist yet
      return [];
    }
  }

  /**
   * Search for skills (automated retrieval using example-based matching)
   * Returns ALL entries where ANY example >= threshold
   */
  async search(query: string): Promise<SkillsSearchResult | null> {
    if (!this.initialized) {
      await this.initialize();
    }

    const entries = await this.getEntries();
    if (entries.length === 0) {
      return null;
    }

    // Use example-based retrieval (only include matched entries for production)
    const result = await retrieve(query, entries, SCORE_THRESHOLD, false);
    
    // Filter entries by minimum threshold
    const matchingEntries = result.entries
      .filter(scored => scored.matched && scored.score >= SCORE_THRESHOLD)
      .map(scored => ({
        content: scored.entry.content,
        score: scored.score,
        entry: scored.entry
      }));

    if (matchingEntries.length === 0) {
      return null;
    }

    return {
      entries: matchingEntries
    };
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
   * @param scoreThreshold - Optional similarity threshold (default: 0.8)
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
    
    const entry = {
      id,
      content,
      examples: examples,  // Store as array
      exampleVectorsJson: JSON.stringify(exampleVectors),  // Store vectors as JSON string
      scoreThreshold: scoreThreshold ?? DEFAULT_SCORE_THRESHOLD,
      updatedAt: Date.now(),
    };

    try {
      const table = await this.db.openTable(this.tableName);
      await table.add([entry]);
    } catch {
      // Table doesn't exist, create it
      await this.db.createTable(this.tableName, [entry]);
    }

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
    return this.tableName;
  }
}
