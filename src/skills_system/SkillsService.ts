/**
 * Skills Service
 * 
 * Central service for managing agent skills retrieval.
 * Handles real-time embedding, message history, and skill search.
 */

import { embed } from './embeddings.js';
import { retrieve, MessageHistory, SkillEntry, RetrievalResult, ScoredEntry } from './retriever.js';
import { extractKeywords, ExtractionResult } from './extractor.js';
import { ScoringParams } from './scorer.js';
import * as lancedb from '@lancedb/lancedb';
import { v4 as uuidv4 } from 'uuid';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', '..', 'data', 'skills');

/**
 * Default scoring parameters from the test UI
 */
export const SKILLS_PARAMS: ScoringParams = {
  decayPower: 2.5,
  topPercentage: 0.08,      // 8%
  baseWeight: 1,
  minWeight: 0,
  querySimilarityWeight: 0.5,
};

/**
 * Default history decay factor
 */
export const DEFAULT_HISTORY_DECAY = 0.05;

/**
 * Maximum number of messages to keep in history
 */
export const MAX_HISTORY_LENGTH = 3;

/**
 * Minimum score threshold for automated skill retrieval (80%)
 */
export const SCORE_THRESHOLD = 0.7;

/**
 * Result from a skills search
 */
export interface SkillsSearchResult {
  content: string;
  score: number;
  normalizedScore: number;
  entry: SkillEntry;
}

/**
 * Skills Service - manages skill retrieval for a single agent
 */
export class SkillsService {
  private tableName: string;
  private db: lancedb.Connection | null = null;
  private messageHistory: MessageHistory[] = [];
  private preEmbeddedWords: Set<string> = new Set();
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
   * Pre-embed a word as the user types (for faster search)
   * This populates the embedding cache without blocking
   */
  async embedWordRealtime(word: string): Promise<void> {
    const normalized = word.toLowerCase().trim();
    if (!normalized || normalized.length < 2 || this.preEmbeddedWords.has(normalized)) {
      return;
    }
    
    this.preEmbeddedWords.add(normalized);
    
    // Fire and forget - don't await
    embed(normalized).catch(() => {
      // Silently ignore errors for pre-embedding
    });
  }

  /**
   * Pre-embed multiple words (e.g., from a paste)
   */
  async embedWordsRealtime(words: string[]): Promise<void> {
    const uniqueWords = [...new Set(words.map(w => w.toLowerCase().trim()))];
    await Promise.all(uniqueWords.map(w => this.embedWordRealtime(w)));
  }

  /**
   * Clear the pre-embedded words set (e.g., after sending a message)
   */
  clearPreEmbeddedWords(): void {
    this.preEmbeddedWords.clear();
  }

  /**
   * Get all entries from the skills table
   */
  private async getEntries(): Promise<SkillEntry[]> {
    if (!this.db) {
      throw new Error('SkillsService not initialized');
    }

    try {
      const table = await this.db.openTable(this.tableName);
      const results = await table.query().toArray();
      
      return results.map(row => {
        const vector = row.vector;
        const vectorArray = Array.isArray(vector) 
          ? vector 
          : Array.from(vector as ArrayLike<number>);
        
        return {
          id: row.id as string,
          content: row.content as string,
          vector: vectorArray,
        };
      });
    } catch (error) {
      // Table might not exist yet
      return [];
    }
  }

  /**
   * Search for skills (automated retrieval)
   * Returns the top result only if score >= 80%
   */
  async search(query: string): Promise<SkillsSearchResult | null> {
    if (!this.initialized) {
      await this.initialize();
    }

    const entries = await this.getEntries();
    if (entries.length === 0) {
      return null;
    }

    const result = await retrieve(
      query,
      entries,
      SKILLS_PARAMS,
      1, // Only get top result
      this.messageHistory,
      DEFAULT_HISTORY_DECAY
    );

    // Save to message history (after search)
    await this.addToHistory(query, result);

    const topEntry = result.entries[0];
    if (!topEntry) {
      return null;
    }

    console.log(topEntry.normalizedScore)
    
    // Only return if score meets threshold
    if (topEntry.normalizedScore >= SCORE_THRESHOLD) {
      return {
        content: topEntry.entry.content,
        score: topEntry.totalScore,
        normalizedScore: topEntry.normalizedScore,
        entry: topEntry.entry,
      };
    }

    return null;
  }

  /**
   * Manual search (for system.search tool)
   * Always returns the top result, regardless of score
   */
  async manualSearch(query: string): Promise<SkillsSearchResult | null> {
    if (!this.initialized) {
      await this.initialize();
    }

    const entries = await this.getEntries();
    if (entries.length === 0) {
      return null;
    }

    const result = await retrieve(
      query,
      entries,
      SKILLS_PARAMS,
      1,
      this.messageHistory,
      DEFAULT_HISTORY_DECAY
    );

    // Save to message history
    await this.addToHistory(query, result);

    const topEntry = result.entries[0];
    if (!topEntry) {
      return null;
    }
    
    return {
      content: topEntry.entry.content,
      score: topEntry.totalScore,
      normalizedScore: topEntry.normalizedScore,
      entry: topEntry.entry,
    };
  }

  /**
   * Add a new entry to the knowledge base
   */
  async addEntry(content: string): Promise<{ success: boolean; id: string }> {
    if (!this.initialized) {
      await this.initialize();
    }

    if (!this.db) {
      throw new Error('SkillsService not initialized');
    }

    const vector = await embed(content);
    const id = uuidv4();
    
    const entry = {
      id,
      content,
      vector,
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
   * Add query to message history (max 3 messages)
   */
  private async addToHistory(query: string, result: RetrievalResult): Promise<void> {
    const queryVector = await embed(query);
    
    const message: MessageHistory = {
      id: uuidv4(),
      query,
      queryVector,
      extraction: result.extraction,
      timestamp: Date.now(),
    };

    this.messageHistory.unshift(message);
    
    // Keep only last MAX_HISTORY_LENGTH messages
    if (this.messageHistory.length > MAX_HISTORY_LENGTH) {
      this.messageHistory = this.messageHistory.slice(0, MAX_HISTORY_LENGTH);
    }
  }

  /**
   * Clear message history
   */
  clearHistory(): void {
    this.messageHistory = [];
  }

  /**
   * Get current message history length
   */
  getHistoryLength(): number {
    return this.messageHistory.length;
  }

  /**
   * Get the table name this service is using
   */
  getTableName(): string {
    return this.tableName;
  }
}
