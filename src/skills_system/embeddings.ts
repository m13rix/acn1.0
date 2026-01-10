/**
 * Embedding utilities for the skills system
 * 
 * Provides caching and batch embedding capabilities.
 */

import 'dotenv/config';
import { GoogleGenAI } from '@google/genai';

const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY!
});

// Embedding cache to avoid redundant API calls
const cache = new Map<string, number[]>();

/**
 * Normalize text for cache key
 */
function normalize(text: string): string {
  return text.toLowerCase().trim();
}

/**
 * Embed a single text, with caching
 */
export async function embed(text: string): Promise<number[]> {
  const key = normalize(text);
  
  if (cache.has(key)) {
    return cache.get(key)!;
  }
  
  const res = await ai.models.embedContent({
    model: 'gemini-embedding-001',
    contents: [text],
    config: { taskType: 'SEMANTIC_SIMILARITY' }
  });
  
  const vector = res.embeddings![0].values as number[];
  cache.set(key, vector);
  return vector;
}

/**
 * Embed multiple texts in parallel (with caching)
 */
export async function embedBatch(texts: string[]): Promise<number[][]> {
  return Promise.all(texts.map(embed));
}

/**
 * Compute cosine similarity between two vectors
 * Accepts both regular arrays and TypedArrays (Float32Array, etc.)
 */
export function cosineSimilarity(a: number[] | ArrayLike<number>, b: number[] | ArrayLike<number>): number {
  // Accept both regular arrays and TypedArrays (array-like objects with length)
  const aIsArrayLike = a != null && typeof a === 'object' && 'length' in a && typeof a.length === 'number';
  const bIsArrayLike = b != null && typeof b === 'object' && 'length' in b && typeof b.length === 'number';
  
  if (!aIsArrayLike || !bIsArrayLike || a.length === 0 || b.length === 0) {
    return 0;
  }
  
  if (a.length !== b.length) {
    throw new Error(`Vector dimension mismatch: ${a.length} vs ${b.length}`);
  }
  
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  
  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  
  const magnitude = Math.sqrt(normA) * Math.sqrt(normB);
  if (magnitude === 0) return 0;
  
  return dotProduct / magnitude;
}

/**
 * Clear the embedding cache
 */
export function clearCache(): void {
  cache.clear();
}

/**
 * Get cache stats
 */
export function getCacheStats(): { size: number } {
  return { size: cache.size };
}
