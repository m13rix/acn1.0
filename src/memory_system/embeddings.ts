import 'dotenv/config';
import { GoogleGenAI } from '@google/genai';
import { Ollama } from 'ollama';
import type { MemoryDebugLogger } from './debug.js';
import { summarizeText } from './debug.js';

const cache = new Map<string, number[]>();
const GEMINI_EMBED_BATCH_LIMIT = 100;
const OLLAMA_EMBED_BATCH_LIMIT = 64;

let ai: GoogleGenAI | null = null;
let ollamaClient: Ollama | null = null;
const EMBED_RETRY_DELAY_MS = 3000;
const OLLAMA_KEEP_ALIVE = '30m';

function sanitizeNumber(value: unknown): number {
  const numeric = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(numeric) ? numeric : 0;
}

export function sanitizeEmbeddingVector(vector: ArrayLike<unknown> | null | undefined): number[] {
  if (!vector || typeof vector.length !== 'number' || vector.length <= 0) {
    return [];
  }

  let replaced = 0;
  const sanitized = Array.from(vector, (value) => {
    const numeric = sanitizeNumber(value);
    if (!Number.isFinite(typeof value === 'number' ? value : Number(value))) {
      replaced += 1;
    }
    return numeric;
  });

  if (replaced > 0) {
    console.warn(`[memory.embeddings] Replaced ${replaced} non-finite embedding value(s) with 0.`);
  }

  return sanitized;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function collectErrorCodes(err: unknown): string[] {
  const out: string[] = [];
  const anyErr = err as any;
  if (anyErr?.code) out.push(String(anyErr.code));
  if (anyErr?.status_code) out.push(String(anyErr.status_code));
  if (anyErr?.status) out.push(String(anyErr.status));
  if (anyErr?.cause?.code) out.push(String(anyErr.cause.code));
  if (Array.isArray(anyErr?.cause?.errors)) {
    for (const nested of anyErr.cause.errors) {
      if (nested?.code) out.push(String(nested.code));
    }
  }
  return out;
}

function isTransientNetworkError(err: unknown): boolean {
  const msg = String((err as any)?.message ?? (err as any)?.error ?? err ?? '').toLowerCase();
  const codes = collectErrorCodes(err).map(code => code.toUpperCase());
  if (msg.includes('fetch failed')) return true;
  if (msg.includes('network')) return true;
  if (msg.includes('timeout')) return true;
  if (msg.includes('socket hang up')) return true;
  if (msg.includes('temporar')) return true;
  if (msg.includes('server busy')) return true;
  if (msg.includes('maximum pending requests')) return true;
  return codes.some(code =>
    code === 'ECONNREFUSED' ||
    code === 'ECONNRESET' ||
    code === 'ETIMEDOUT' ||
    code === 'EAI_AGAIN' ||
    code === 'ENETUNREACH' ||
    code === 'EHOSTUNREACH' ||
    code === '503'
  );
}

function parseRetryDelayMs(err: unknown): number | null {
  const anyErr = err as any;
  const retryDelay = anyErr?.error?.details?.find?.((detail: any) => detail?.['@type'] === 'type.googleapis.com/google.rpc.RetryInfo')?.retryDelay
    ?? anyErr?.details?.find?.((detail: any) => detail?.['@type'] === 'type.googleapis.com/google.rpc.RetryInfo')?.retryDelay;
  if (typeof retryDelay === 'string') {
    const match = retryDelay.match(/(\d+(?:\.\d+)?)s/i);
    if (match) {
      return Math.ceil(Number(match[1]) * 1000);
    }
  }

  const message = String(anyErr?.message ?? anyErr?.error ?? '');
  const retryMatch = message.match(/retry in\s+(\d+(?:\.\d+)?)s/i);
  if (retryMatch) {
    return Math.ceil(Number(retryMatch[1]) * 1000);
  }
  return null;
}

function isGeminiQuotaError(err: unknown): boolean {
  const anyErr = err as any;
  const message = String(anyErr?.message ?? anyErr?.error ?? '').toLowerCase();
  const status = String(anyErr?.status ?? anyErr?.error?.status ?? '').toUpperCase();
  return status === 'RESOURCE_EXHAUSTED'
    || message.includes('quota exceeded')
    || message.includes('rate-limits')
    || message.includes('resource_exhausted');
}

async function withTransientRetry<T>(opName: string, fn: () => Promise<T>, debug?: MemoryDebugLogger): Promise<T> {
  for (; ;) {
    try {
      return await fn();
    } catch (error) {
      if (isGeminiQuotaError(error)) {
        const delayMs = Math.max(1000, parseRetryDelayMs(error) ?? (25_000 + Math.floor(Math.random() * 3000)));
        debug?.('memory.embed.retry', 'Gemini quota hit, waiting before retry.', {
          opName,
          delayMs,
          error: error instanceof Error ? error.message : String(error),
        });
        console.warn(`[memory.embeddings] ${opName} Gemini quota hit, retrying in ${delayMs}ms:`, (error as any)?.message || error);
        await sleep(delayMs);
        continue;
      }

      if (!isTransientNetworkError(error)) {
        throw error;
      }
      const delayMs = EMBED_RETRY_DELAY_MS + Math.floor(Math.random() * 2000);
      debug?.('memory.embed.retry', 'Transient embedding error, waiting before retry.', {
        opName,
        delayMs,
        error: error instanceof Error ? error.message : String(error),
      });
      console.warn(`[memory.embeddings] ${opName} transient error, retrying in ${delayMs}ms:`, (error as any)?.message || error);
      await sleep(delayMs);
    }
  }
}

function getOllamaClient(): Ollama {
  if (!ollamaClient) {
    const host = process.env.OLLAMA_HOST || 'http://localhost:11434';
    ollamaClient = new Ollama({ host });
  }
  return ollamaClient;
}

function getClient(): GoogleGenAI {
  if (!ai) {
    const apiKey = process.env.GEMINI_KEY || process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error('GEMINI_KEY or GEMINI_API_KEY is required for memory embeddings.');
    }
    ai = new GoogleGenAI({ apiKey });
  }
  return ai;
}

function normalizeKey(text: string): string {
  return text.trim().toLowerCase();
}

function normalizeEmbeddingInput(text: string): string {
  return String(text ?? '')
    .replace(/\u0000/g, ' ')
    .replace(/[\u0001-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isNaNEncodingError(error: unknown): boolean {
  const message = String((error as any)?.message ?? (error as any)?.error ?? '');
  return message.includes('unsupported value: NaN');
}

type GeminiEmbeddingMode = 'retrieval-query' | 'retrieval-document' | 'symmetric';

function isGeminiEmbeddingModel(model: string): boolean {
  return model.startsWith('gemini-embedding-');
}

function resolveGeminiEmbeddingMode(label: string): GeminiEmbeddingMode {
  if (label.startsWith('query.')) {
    return 'retrieval-query';
  }

  if (
    label.includes('semantic_merge') ||
    label.includes('materialize_links') ||
    label.includes('migration.link_relations')
  ) {
    return 'symmetric';
  }

  return 'retrieval-document';
}

function prepareGeminiEmbeddingInput(
  text: string,
  model: string,
  mode: GeminiEmbeddingMode,
): { content: string; config?: Record<string, unknown> } {
  if (model === 'gemini-embedding-001') {
    const taskType = mode === 'retrieval-query'
      ? 'RETRIEVAL_QUERY'
      : mode === 'retrieval-document'
        ? 'RETRIEVAL_DOCUMENT'
        : 'SEMANTIC_SIMILARITY';
    return {
      content: text,
      config: {
        taskType,
      },
    };
  }

  if (mode === 'retrieval-query') {
    return {
      content: `task: search result | query: ${text}`,
    };
  }

  if (mode === 'retrieval-document') {
    return {
      content: `title: none | text: ${text}`,
    };
  }

  return {
    content: `task: sentence similarity | query: ${text}`,
  };
}

function maybeNormalizeVector(vector: number[]): number[] {
  let norm = 0;
  for (const value of vector) {
    norm += value * value;
  }
  norm = Math.sqrt(norm);
  if (norm > 0) {
    return vector.map((value) => value / norm);
  }
  return vector;
}

export function normalizeEmbeddingVectorUnit(vector: number[] | ArrayLike<number>): number[] {
  return maybeNormalizeVector(sanitizeEmbeddingVector(vector));
}

export async function embedText(
  text: string,
  model: string,
  debug?: MemoryDebugLogger,
  label = 'embedding',
): Promise<number[]> {
  const cleanText = normalizeEmbeddingInput(text);
  const geminiMode = isGeminiEmbeddingModel(model) ? resolveGeminiEmbeddingMode(label) : null;
  const prepared = geminiMode ? prepareGeminiEmbeddingInput(cleanText, model, geminiMode) : { content: cleanText };
  const cacheKey = `${model}::${geminiMode ?? 'default'}::${normalizeKey(prepared.content)}`;
  const cached = cache.get(cacheKey);
  if (cached) {
    debug?.('memory.embed.cache_hit', `Embedding cache hit for ${label}.`, {
      model,
      textPreview: summarizeText(cleanText, 300),
      preparedTextPreview: summarizeText(prepared.content, 300),
      geminiMode,
      dimensions: cached.length,
    });
    return cached;
  }

  debug?.('memory.embed.start', `Starting embedding for ${label}.`, {
    model,
    textLength: cleanText.length,
    textPreview: summarizeText(cleanText, 500),
    preparedTextPreview: summarizeText(prepared.content, 500),
    geminiMode,
  });

  if (isGeminiEmbeddingModel(model) || model === 'text-embedding-004') {
    try {
      const response = await withTransientRetry(`google:${model}`, async () => {
        const client = getClient();
        return client.models.embedContent({
          model,
          contents: [prepared.content],
          ...(prepared.config ? { config: prepared.config } : {}),
        });
      }, debug);

      const vector = maybeNormalizeVector(
        sanitizeEmbeddingVector(response.embeddings?.[0]?.values as number[] | undefined),
      );
      if (vector.length === 0) {
        throw new Error('Google Embedding API returned an empty vector.');
      }
      cache.set(cacheKey, vector);
      debug?.('memory.embed.success', `Embedding completed for ${label}.`, {
        model,
        provider: 'google',
        geminiMode,
        dimensions: vector.length,
      });
      return vector;
    } catch (error) {
      debug?.('memory.embed.error', `Embedding failed for ${label}.`, {
        model,
        provider: 'google',
        textPreview: summarizeText(cleanText, 1000),
        preparedTextPreview: summarizeText(prepared.content, 1000),
        geminiMode,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  // Default to Ollama for everything else (e.g., bge-m3, mxbai-embed-large)
  try {
      const response = await withTransientRetry(`ollama:${model}`, async () => {
        const client = getOllamaClient();
        return client.embed({
          model,
          input: [cleanText],
          keep_alive: OLLAMA_KEEP_ALIVE,
        });
      }, debug);

    const vector = maybeNormalizeVector(
      sanitizeEmbeddingVector((response as any).embeddings?.[0] ?? (response as any).embedding),
    );
    if (vector.length === 0) {
      throw new Error(`Ollama Embedding API (${model}) returned an empty vector.`);
    }

    cache.set(cacheKey, vector);
    debug?.('memory.embed.success', `Embedding completed for ${label}.`, {
      model,
      provider: 'ollama',
      dimensions: vector.length,
    });
    return vector;
  } catch (error) {
    debug?.('memory.embed.error', `Embedding failed for ${label}.`, {
      model,
      provider: 'ollama',
      textPreview: summarizeText(cleanText, 1000),
      error: error instanceof Error ? error.message : String(error),
      isNaNEncodingError: isNaNEncodingError(error),
    });
    if (isNaNEncodingError(error)) {
      throw new Error(`Ollama embedding returned NaN-encoding failure for model "${model}" on text: ${summarizeText(cleanText, 500)}`);
    }
    throw error;
  }
}

export async function embedBatch(
  texts: string[],
  model: string,
  options?: {
    debug?: MemoryDebugLogger;
    label?: string;
    concurrency?: number;
  },
): Promise<number[][]> {
  const debug = options?.debug;
  const label = options?.label ?? 'embedding_batch';
  const results = new Array<number[]>(texts.length);

  debug?.('memory.embed.batch_start', `Starting embedding batch for ${label}.`, {
    model,
    count: texts.length,
    concurrency: 1,
  });

  if (isGeminiEmbeddingModel(model) && texts.length > 0) {
    const preparedInputs = texts.map((text, index) => {
      const cleanText = normalizeEmbeddingInput(text ?? '');
      const itemLabel = `${label}[${index}]`;
      const geminiMode = resolveGeminiEmbeddingMode(itemLabel);
      const prepared = prepareGeminiEmbeddingInput(cleanText, model, geminiMode);
      return {
        cleanText,
        geminiMode,
        prepared,
        cacheKey: `${model}::${geminiMode}::${normalizeKey(prepared.content)}`,
      };
    });

    const uniqueUncachedByKey = new Map<string, { item: typeof preparedInputs[number]; firstIndex: number; duplicateCount: number }>();
    let cacheHitCount = 0;
    let duplicateReuseCount = 0;
    preparedInputs.forEach((item, index) => {
      if (cache.has(item.cacheKey)) {
        cacheHitCount += 1;
        return;
      }
      const existing = uniqueUncachedByKey.get(item.cacheKey);
      if (existing) {
        existing.duplicateCount += 1;
        duplicateReuseCount += 1;
        return;
      }
      uniqueUncachedByKey.set(item.cacheKey, {
        item,
        firstIndex: index,
        duplicateCount: 0,
      });
    });

    const uncachedIndices = Array.from(uniqueUncachedByKey.values())
      .map(({ item, firstIndex }) => ({ item, index: firstIndex }));

    debug?.('memory.embed.batch_dedup', `Prepared Gemini batch inputs for ${label}.`, {
      model,
      totalInputs: texts.length,
      cacheHitCount,
      duplicateReuseCount,
      uniqueUncachedCount: uncachedIndices.length,
    });

    if (uncachedIndices.length > 0) {
      const modeBuckets = new Map<GeminiEmbeddingMode, Array<{ item: typeof preparedInputs[number]; index: number }>>();
      for (const entry of uncachedIndices) {
        const bucket = modeBuckets.get(entry.item.geminiMode) ?? [];
        bucket.push(entry);
        modeBuckets.set(entry.item.geminiMode, bucket);
      }

      for (const [geminiMode, bucket] of modeBuckets.entries()) {
        for (let start = 0; start < bucket.length; start += GEMINI_EMBED_BATCH_LIMIT) {
          const chunk = bucket.slice(start, start + GEMINI_EMBED_BATCH_LIMIT);
          debug?.('memory.embed.batch_google_request', `Starting Gemini batch embedding for ${label}.`, {
            model,
            geminiMode,
            chunkStart: start,
            chunkSize: chunk.length,
            totalForMode: bucket.length,
            totalUncached: uncachedIndices.length,
            items: chunk.slice(0, 20).map(({ item, index }) => ({
              index,
              geminiMode: item.geminiMode,
              textPreview: summarizeText(item.cleanText, 300),
              preparedTextPreview: summarizeText(item.prepared.content, 300),
            })),
          });

          try {
            const response = await withTransientRetry(`google-batch:${model}:${geminiMode}:${start}`, async () => {
              const client = getClient();
              return client.models.embedContent({
                model,
                contents: chunk.map(({ item }) => item.prepared.content),
                ...(chunk[0]?.item.prepared.config ? { config: chunk[0].item.prepared.config } : {}),
              });
            }, debug);

            const vectors = Array.isArray(response.embeddings) ? response.embeddings : [];
            if (vectors.length !== chunk.length) {
              throw new Error(`Google Embedding API returned ${vectors.length} vectors for ${chunk.length} inputs.`);
            }

            chunk.forEach(({ item }, index) => {
              const vector = maybeNormalizeVector(
                sanitizeEmbeddingVector(vectors[index]?.values as number[] | undefined),
              );
              if (vector.length === 0) {
                throw new Error(`Google Embedding API returned an empty vector for batch item ${index}.`);
              }
              cache.set(item.cacheKey, vector);
            });

            debug?.('memory.embed.batch_google_response', `Completed Gemini batch embedding for ${label}.`, {
              model,
              geminiMode,
              chunkStart: start,
              chunkSize: chunk.length,
              dimensions: chunk.length > 0 ? cache.get(chunk[0]!.item.cacheKey)?.length ?? 0 : 0,
            });
          } catch (error) {
            debug?.('memory.embed.batch_error', `Gemini batch embedding failed for ${label}.`, {
              model,
              geminiMode,
              chunkStart: start,
              chunkSize: chunk.length,
              error: error instanceof Error ? error.message : String(error),
              items: chunk.slice(0, 20).map(({ item, index }) => ({
                index,
                geminiMode: item.geminiMode,
                textPreview: summarizeText(item.cleanText, 300),
                preparedTextPreview: summarizeText(item.prepared.content, 300),
              })),
            });
            throw error;
          }
        }
      }
    }

    for (let index = 0; index < preparedInputs.length; index++) {
      const vector = cache.get(preparedInputs[index]!.cacheKey) ?? [];
      if (vector.length === 0) {
        throw new Error(`Missing Gemini embedding vector for ${label}[${index}]`);
      }
      results[index] = vector;
    }

    debug?.('memory.embed.batch_done', `Completed embedding batch for ${label}.`, {
      model,
      count: texts.length,
      provider: 'google',
    });
    return results;
  }

  if (texts.length === 0) {
    debug?.('memory.embed.batch_done', `Completed embedding batch for ${label}.`, {
      model,
      count: 0,
    });
    return results;
  }

  const preparedInputs = texts.map((text) => {
    const cleanText = normalizeEmbeddingInput(text ?? '');
    return {
      cleanText,
      cacheKey: `${model}::default::${normalizeKey(cleanText)}`,
    };
  });

  let cacheHitCount = 0;
  let duplicateReuseCount = 0;
  const uniqueUncached = new Map<string, { cleanText: string; cacheKey: string }>();
  for (const item of preparedInputs) {
    if (cache.has(item.cacheKey)) {
      cacheHitCount += 1;
      continue;
    }
    if (uniqueUncached.has(item.cacheKey)) {
      duplicateReuseCount += 1;
      continue;
    }
    uniqueUncached.set(item.cacheKey, item);
  }

  debug?.('memory.embed.batch_dedup', `Prepared Ollama batch inputs for ${label}.`, {
    model,
    totalInputs: texts.length,
    cacheHitCount,
    duplicateReuseCount,
    uniqueUncachedCount: uniqueUncached.size,
  });

  const uncachedItems = Array.from(uniqueUncached.values());
  for (let start = 0; start < uncachedItems.length; start += OLLAMA_EMBED_BATCH_LIMIT) {
    const chunk = uncachedItems.slice(start, start + OLLAMA_EMBED_BATCH_LIMIT);
    debug?.('memory.embed.batch_ollama_request', `Starting Ollama batch embedding for ${label}.`, {
      model,
      chunkStart: start,
      chunkSize: chunk.length,
      totalUncached: uncachedItems.length,
      items: chunk.slice(0, 20).map((item) => ({
        textPreview: summarizeText(item.cleanText, 300),
      })),
    });

    try {
      const response = await withTransientRetry(`ollama-batch:${model}:${start}`, async () => {
        const client = getOllamaClient();
        return client.embed({
          model,
          input: chunk.map((item) => item.cleanText),
          keep_alive: OLLAMA_KEEP_ALIVE,
        });
      }, debug);

      const vectors = Array.isArray((response as any).embeddings) ? (response as any).embeddings : [];
      if (vectors.length !== chunk.length) {
        throw new Error(`Ollama embed returned ${vectors.length} vectors for ${chunk.length} inputs.`);
      }

      chunk.forEach((item, index) => {
        const vector = maybeNormalizeVector(sanitizeEmbeddingVector(vectors[index]));
        if (vector.length === 0) {
          throw new Error(`Ollama embed returned an empty vector for batch item ${index}.`);
        }
        cache.set(item.cacheKey, vector);
      });

      debug?.('memory.embed.batch_ollama_response', `Completed Ollama batch embedding for ${label}.`, {
        model,
        chunkStart: start,
        chunkSize: chunk.length,
        dimensions: chunk.length > 0 ? cache.get(chunk[0]!.cacheKey)?.length ?? 0 : 0,
      });
    } catch (error) {
      debug?.('memory.embed.batch_error', `Ollama batch embedding failed for ${label}.`, {
        model,
        chunkStart: start,
        chunkSize: chunk.length,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  for (let index = 0; index < preparedInputs.length; index++) {
    const vector = cache.get(preparedInputs[index]!.cacheKey) ?? [];
    if (vector.length === 0) {
      throw new Error(`Missing Ollama embedding vector for ${label}[${index}]`);
    }
    results[index] = vector;
  }

  debug?.('memory.embed.batch_done', `Completed embedding batch for ${label}.`, {
    model,
    count: texts.length,
    provider: 'ollama',
  });
  return results;
}

export function cosineSimilarity(a: number[] | ArrayLike<number>, b: number[] | ArrayLike<number>): number {
  if (!a || !b || a.length === 0 || b.length === 0) return 0;
  if (a.length !== b.length) return 0;

  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    const av = a[i] as number;
    const bv = b[i] as number;
    dot += av * bv;
    normA += av * av;
    normB += bv * bv;
  }

  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  if (denom === 0) return 0;
  const value = dot / denom;
  return Number.isFinite(value) ? value : 0;
}

export function vectorSubtract(to: number[] | ArrayLike<number>, from: number[] | ArrayLike<number>): number[] {
  if (to.length !== from.length) {
    throw new Error(`Vector dimension mismatch: ${to.length} vs ${from.length}`);
  }
  const out: number[] = [];
  for (let i = 0; i < to.length; i++) {
    out.push((to[i] as number) - (from[i] as number));
  }
  return out;
}

export const __internals = {
  sanitizeEmbeddingVector,
};
