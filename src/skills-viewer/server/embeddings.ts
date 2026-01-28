/**
 * Gemini Embedding Service
 *
 * Provides text embedding using Google's Gemini embedding model.
 * Used for semantic search in the skills database.
 */

import 'dotenv/config';
import { GoogleGenAI } from '@google/genai';

console.log(process.env.GEMINI_KEY)

const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_KEY!
});

/**
 * Embed text using Gemini's embedding model
 * Returns a 3072-dimensional vector (gemini-embedding-001)
 */
export async function embed(text: string): Promise<number[]> {
  const res = await ai.models.embedContent({
    model: 'gemini-embedding-001',
    contents: [text],
    config: { taskType: 'SEMANTIC_SIMILARITY' }
  });

  const vector = res.embeddings![0].values as number[];
  console.log(`[Embedding] Generated ${vector.length}-dimensional vector`);
  return vector;
}

/**
 * Embed multiple texts in a batch
 */
export async function embedBatch(texts: string[]): Promise<number[][]> {
  const results = await Promise.all(texts.map(embed));
  return results;
}

/**
 * Compute cosine similarity between two vectors
 * Accepts both regular arrays and TypedArrays (Float32Array, etc.)
 */
export function cosineSimilarity(a: number[] | ArrayLike<number>, b: number[] | ArrayLike<number>): number {
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
