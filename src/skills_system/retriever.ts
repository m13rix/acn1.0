/**
 * Skill Retriever
 * 
 * Simple example-based semantic retrieval that compares user queries
 * against example queries for each skill entry.
 */

import { cosineSimilarity, embed } from './embeddings.js';

/**
 * A skill entry from the database
 */
export interface SkillEntry {
  id: string;
  content: string;
  examples: string[];  // Required array of example queries
  exampleVectors: number[][];  // Pre-embedded vectors for each example
  scoreThreshold?: number;  // Optional similarity threshold (default: 0.8)
  updatedAt: number;
}

/**
 * Detailed score for a single example comparison
 */
export interface ExampleScore {
  example: string;
  exampleIndex: number;
  similarity: number;  // Cosine similarity (0-1)
}

/**
 * Scored entry result with detailed scoring information
 */
export interface ScoredEntry {
  entry: SkillEntry;
  score: number;  // Max similarity score (0-1) across all examples
  threshold: number;  // Threshold used for this entry
  matched: boolean;  // Whether this entry met the threshold
  bestExampleIndex: number;  // Index of the example with highest similarity
  bestExample: string;  // The example text that matched best
  exampleScores: ExampleScore[];  // All example scores for debugging
}

/**
 * Retrieval result
 */
export interface RetrievalResult {
  query: string;
  queryVector: number[];
  entries: ScoredEntry[];
  timing: {
    embeddingMs: number;
    scoringMs: number;
    totalMs: number;
  };
}

/**
 * Default score threshold
 */
export const DEFAULT_SCORE_THRESHOLD = 0.8;

/**
 * Retrieve skill entries using example-based semantic matching
 * Returns ALL entries with detailed scoring (including those below threshold)
 * 
 * @param query - User's query
 * @param entries - Skill entries to search
 * @param minThreshold - Minimum similarity threshold (default: 0.8)
 * @param includeAll - If true, include all entries even below threshold (default: true for debugging)
 * @returns Retrieval result with all entries and detailed scoring
 */
export async function retrieve(
  query: string,
  entries: SkillEntry[],
  minThreshold: number = DEFAULT_SCORE_THRESHOLD,
  includeAll: boolean = true
): Promise<RetrievalResult> {
  const startTime = performance.now();
  
  // Embed user query once
  const embeddingStart = performance.now();
  const queryVector = await embed(query);
  const embeddingMs = performance.now() - embeddingStart;
  
  // Score all entries against query
  const scoringStart = performance.now();
  const scoredEntries: ScoredEntry[] = [];
  
  for (const entry of entries) {
    // Compare query against all examples for this entry
    const exampleScores: ExampleScore[] = [];
    let maxSimilarity = 0;
    let bestExampleIndex = -1;
    let bestExample = '';
    
    for (let i = 0; i < entry.exampleVectors.length; i++) {
      const exampleVector = entry.exampleVectors[i];
      const similarity = cosineSimilarity(queryVector, exampleVector);
      
      exampleScores.push({
        example: entry.examples[i],
        exampleIndex: i,
        similarity
      });
      
      if (similarity > maxSimilarity) {
        maxSimilarity = similarity;
        bestExampleIndex = i;
        bestExample = entry.examples[i];
      }
    }
    
    // Sort example scores by similarity descending
    exampleScores.sort((a, b) => b.similarity - a.similarity);
    
    // Use entry's custom threshold if provided, otherwise use default
    const threshold = entry.scoreThreshold ?? minThreshold;
    const matched = maxSimilarity >= threshold;
    
    // Include entry if matched OR if includeAll is true (for debugging)
    if (matched || includeAll) {
      scoredEntries.push({
        entry,
        score: maxSimilarity,
        threshold,
        matched,
        bestExampleIndex,
        bestExample,
        exampleScores
      });
    }
  }
  
  // Sort by score descending (matched entries first, then by score)
  scoredEntries.sort((a, b) => {
    if (a.matched !== b.matched) {
      return a.matched ? -1 : 1;  // Matched entries first
    }
    return b.score - a.score;
  });
  
  const scoringMs = performance.now() - scoringStart;
  const totalMs = performance.now() - startTime;
  
  return {
    query,
    queryVector,
    entries: scoredEntries,
    timing: {
      embeddingMs,
      scoringMs,
      totalMs
    }
  };
}

/**
 * Quick similarity check between query and single entry
 * Uses the max similarity across all examples
 */
export async function quickMatch(
  query: string,
  entry: SkillEntry
): Promise<number> {
  const queryVector = await embed(query);
  let maxSimilarity = 0;
  
  for (const exampleVector of entry.exampleVectors) {
    const similarity = cosineSimilarity(queryVector, exampleVector);
    if (similarity > maxSimilarity) {
      maxSimilarity = similarity;
    }
  }
  
  return maxSimilarity;
}
