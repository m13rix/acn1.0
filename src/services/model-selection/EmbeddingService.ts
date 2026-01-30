
import { GoogleGenAI } from '@google/genai';

const DEFAULT_EMBEDDING_MODEL = process.env.EMBEDDING_MODEL || 'gemini-embedding-001';
const DEFAULT_API_KEY = process.env.GEMINI_KEY; // Using standard GEMINI_KEY env

let sharedClient: GoogleGenAI | null = null;
let sharedClientKey: string | null = null;

function getClient(apiKey: string = DEFAULT_API_KEY || ''): GoogleGenAI {
    if (!apiKey) {
        throw new Error('GEMINI_KEY is not set. Unable to compute embeddings.');
    }

    if (!sharedClient || sharedClientKey !== apiKey) {
        sharedClient = new GoogleGenAI({ apiKey });
        sharedClientKey = apiKey;
    }

    return sharedClient;
}

export interface EmbeddingOptions {
    model?: string;
    apiKey?: string;
}

/**
 * Compute embeddings for a batch of texts using Google Gemini embedding API.
 */
export async function embedTextBatch(texts: string[], options: EmbeddingOptions = {}): Promise<number[][]> {
    if (!Array.isArray(texts)) {
        throw new TypeError('embedTextBatch expects an array of strings.');
    }
    if (texts.length === 0) {
        return [];
    }

    const { model = DEFAULT_EMBEDDING_MODEL, apiKey } = options;
    const client = getClient(apiKey);
    const vectors: number[][] = [];

    for (const text of texts) {
        const contents = [String(text ?? '')];
        // @ts-ignore - GenAI types might need adjustment based on exact version
        const res = await client.models.embedContent({
            model,
            contents,
            config: {
                taskType: 'RETRIEVAL_DOCUMENT'
            }
        });

        if (res && res.embeddings && res.embeddings[0] && res.embeddings[0].values) {
            vectors.push(res.embeddings[0].values);
        } else {
            // Handle error or empty response
            vectors.push([]);
        }
    }

    return vectors;
}

/**
 * Compute embedding for a single query string.
 */
export async function embedQuery(text: string, options: EmbeddingOptions = {}): Promise<number[] | null> {
    const { model = DEFAULT_EMBEDDING_MODEL, apiKey } = options;
    try {
        const client = getClient(apiKey);
        // @ts-ignore
        const res = await client.models.embedContent({
            model,
            contents: [String(text ?? '')],
            config: {
                taskType: 'RETRIEVAL_QUERY'
            }
        });
        return res.embeddings?.[0]?.values || null;

    } catch (error) {
        console.error("Embedding error:", error);
        return null;
    }
}
