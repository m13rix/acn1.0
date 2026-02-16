import 'dotenv/config';
import { GoogleGenAI } from '@google/genai';
import { Ollama } from 'ollama';

const cache = new Map<string, number[]>();

let ai: GoogleGenAI | null = null;
let ollamaClient: Ollama | null = null;

function getOllamaClient(): Ollama {
  if (!ollamaClient) {
    const host = process.env.OLLAMA_HOST || 'http://localhost:11434';
    ollamaClient = new Ollama({ host });
  }
  return ollamaClient;
}

function getClient(): GoogleGenAI {
  if (!ai) {
    const apiKey = process.env.GEMINI_KEY;
    if (!apiKey) {
      throw new Error('GEMINI_KEY is required for memory embeddings.');
    }
    ai = new GoogleGenAI({ apiKey });
  }
  return ai;
}

function normalizeKey(text: string): string {
  return text.trim().toLowerCase();
}

export async function embedText(text: string, model: string): Promise<number[]> {
  const cacheKey = `${model}::${normalizeKey(text)}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  // Use Google for specific legacy models or if explicitly requested (could add prefix logic later)
  if (model === 'gemini-embedding-001' || model === 'text-embedding-004') {
    const client = getClient();
    const response = await client.models.embedContent({
      model,
      contents: [text],
      config: { taskType: 'SEMANTIC_SIMILARITY' },
    });

    const vector = response.embeddings?.[0]?.values as number[] | undefined;
    if (!vector || vector.length === 0) {
      throw new Error('Google Embedding API returned an empty vector.');
    }
    cache.set(cacheKey, vector);
    return vector;
  }

  // Default to Ollama for everything else (e.g., bge-m3, mxbai-embed-large)
  const client = getOllamaClient();
  const response = await client.embeddings({
    model,
    prompt: text,
  });

  const vector = response.embedding;
  if (!vector || vector.length === 0) {
    throw new Error(`Ollama Embedding API (${model}) returned an empty vector.`);
  }

  cache.set(cacheKey, vector);
  return vector;
}

export async function embedBatch(texts: string[], model: string): Promise<number[][]> {
  return Promise.all(texts.map(text => embedText(text, model)));
}

export function cosineSimilarity(a: number[] | ArrayLike<number>, b: number[] | ArrayLike<number>): number {
  if (!a || !b || a.length === 0 || b.length === 0) return 0;
  if (a.length !== b.length) return 0;

  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    dot += av * bv;
    normA += av * av;
    normB += bv * bv;
  }

  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  if (denom === 0) return 0;
  return dot / denom;
}

export function vectorSubtract(to: number[] | ArrayLike<number>, from: number[] | ArrayLike<number>): number[] {
  if (to.length !== from.length) {
    throw new Error(`Vector dimension mismatch: ${to.length} vs ${from.length}`);
  }
  const out: number[] = [];
  for (let i = 0; i < to.length; i++) {
    out.push((to[i] ?? 0) - (from[i] ?? 0));
  }
  return out;
}

