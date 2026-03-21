/**
 * Embedding utilities for the skills system
 *
 * Provides caching and batch embedding capabilities.
 */

import 'dotenv/config';
import { GoogleGenAI } from '@google/genai';

const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_KEY!
});

const EMBEDDING_MODEL = 'gemini-embedding-001';
const EMBEDDING_TASK_TYPE = 'SEMANTIC_SIMILARITY';
const EMBEDDING_BATCH_SIZE = 64;

// Embedding cache to avoid redundant API calls
const cache = new Map<string, number[]>();
const inFlight = new Map<string, Promise<number[]>>();

/**
 * Normalize text for cache key
 */
function normalize(text: string): string {
  return text.toLowerCase().trim();
}

async function requestBatch(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];

  const res = await ai.models.embedContent({
    model: EMBEDDING_MODEL,
    contents: texts,
    config: { taskType: EMBEDDING_TASK_TYPE }
  });

  const embeddings = (res.embeddings || []).map(item => item.values as number[]);
  if (embeddings.length !== texts.length) {
    throw new Error(`Embedding API returned ${embeddings.length} vectors for ${texts.length} texts.`);
  }

  return embeddings;
}

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

/**
 * Embed a single text, with caching
 */
export async function embed(text: string): Promise<number[]> {
  const key = normalize(text);

  const cached = cache.get(key);
  if (cached) return cached;

  const pending = inFlight.get(key);
  if (pending) return pending;

  const [vector] = await embedBatch([text]);
  if (!vector) {
    throw new Error('Embedding API returned an empty vector.');
  }
  return vector;
}

/**
 * Embed multiple texts with cache-aware batching.
 */
export async function embedBatch(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];

  const normalized = texts.map(normalize);
  const missing = new Map<string, string>();

  for (let i = 0; i < texts.length; i++) {
    const key = normalized[i];
    if (!key) continue;
    if (cache.has(key) || inFlight.has(key) || missing.has(key)) continue;
    missing.set(key, texts[i]!);
  }

  for (const entries of chunk(Array.from(missing.entries()), EMBEDDING_BATCH_SIZE)) {
    const batchPromise = requestBatch(entries.map(([, text]) => text));

    entries.forEach(([key], index) => {
      let pendingPromise: Promise<number[]>;
      pendingPromise = batchPromise
        .then(vectors => {
          const vector = vectors[index];
          if (!vector) {
            throw new Error(`Embedding API did not return a vector for batch item ${index}.`);
          }
          cache.set(key, vector);
          return vector;
        })
        .finally(() => {
          if (inFlight.get(key) === pendingPromise) {
            inFlight.delete(key);
          }
        });

      inFlight.set(key, pendingPromise);
    });
  }

  return Promise.all(normalized.map((key, index) => {
    const cached = cache.get(key);
    if (cached) return cached;

    const pending = inFlight.get(key);
    if (pending) return pending;

    throw new Error(`Missing embedding promise for text at index ${index}.`);
  }));
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
    const aValue = a[i] ?? 0;
    const bValue = b[i] ?? 0;
    dotProduct += aValue * bValue;
    normA += aValue * aValue;
    normB += bValue * bValue;
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
  inFlight.clear();
}

/**
 * Get cache stats
 */
export function getCacheStats(): { size: number; inFlight: number } {
  return {
    size: cache.size,
    inFlight: inFlight.size,
  };
}
