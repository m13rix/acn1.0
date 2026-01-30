import { GoogleGenAI } from '@google/genai';

const DEFAULT_EMBEDDING_MODEL = process.env.EMBEDDING_MODEL || 'gemini-embedding-001';
const DEFAULT_API_KEY = process.env.GEMINI_API_KEY;

let sharedClient = null;
let sharedClientKey = null;

function getClient(apiKey = DEFAULT_API_KEY) {
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY is not set. Unable to compute embeddings.');
  }

  if (!sharedClient || sharedClientKey !== apiKey) {
    sharedClient = new GoogleGenAI({ apiKey });
    sharedClientKey = apiKey;
  }

  return sharedClient;
}

/**
 * Compute embeddings for a batch of texts using Google Gemini embedding API.
 * The implementation mirrors the sequential batching logic used in memory tools.
 * @param {string[]} texts
 * @param {object} options
 * @param {string} [options.model] - Embedding model to use
 * @param {string} [options.apiKey] - API key override
 * @returns {Promise<number[][]>}
 */
export async function embedTextBatch(texts, options = {}) {
  if (!Array.isArray(texts)) {
    throw new TypeError('embedTextBatch expects an array of strings.');
  }
  if (texts.length === 0) {
    return [];
  }

  const { model = DEFAULT_EMBEDDING_MODEL, apiKey } = options;
  const client = getClient(apiKey);
  const vectors = [];

  for (const text of texts) {
    const contents = [String(text ?? '')];
    const res = await client.models.embedContent({
      model,
      contents,
      taskType: 'RETRIEVAL_DOCUMENT'
    });
    vectors.push(res.embeddings[0].values);
  }

  return vectors;
}

/**
 * Compute embedding for a single query string.
 * @param {string} text
 * @param {object} options
 * @param {string} [options.model] - Embedding model to use
 * @param {string} [options.apiKey] - API key override
 * @returns {Promise<number[]>}
 */
export async function embedQuery(text, options = {}) {
  const { model = DEFAULT_EMBEDDING_MODEL, apiKey } = options;
  const client = getClient(apiKey);
  const res = await client.models.embedContent({
    model,
    contents: [String(text ?? '')],
    taskType: 'RETRIEVAL_QUERY'
  });
  return res.embeddings[0].values;
}


