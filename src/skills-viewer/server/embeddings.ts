/**
 * Gemini Embedding Service
 * 
 * Provides text embedding using Google's Gemini embedding model.
 * Used for semantic search in the skills database.
 */

import 'dotenv/config';
import { GoogleGenAI } from '@google/genai';

const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY!
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
