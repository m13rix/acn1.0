// tools/memory/index.js

import { GoogleGenAI } from '@google/genai';
import similarity from 'compute-cosine-similarity';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import chalk from 'chalk';
import { S3Client, GetObjectCommand, PutObjectCommand, HeadObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { Readable } from 'stream';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Используем ту же структуру папок и переменных как в LS_Memory_Example
const DATA_DIR = path.join(__dirname, '../../data');
const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL || 'gemini-embedding-001';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || 'AIzaSyDzxteVEpvmbBjDvMVmfAm27dBecPYozow';

// Точно те же функции sanitization как в примере
function sanitizeForFilename(input) {
    return String(input || 'anonymous').replace(/[^a-zA-Z0-9._-]/g, '_');
}

function fallbackPath(clientId) {
    const safe = sanitizeForFilename(clientId);
    return path.join(DATA_DIR, `memory.${safe}.json`);
}

async function ensureDataDir() {
    try { await fs.access(DATA_DIR); } catch { await fs.mkdir(DATA_DIR, { recursive: true }); }
}

// S3 конфигурация точь-в-точь как в примере
const bucketName = process.env.S3_BUCKET_NAME;
const s3Client = new S3Client({
    endpoint: process.env.S3_ENDPOINT,
    region: 'us-east-1',
    credentials: {
        accessKeyId: process.env.S3_ACCESS_KEY_ID,
        secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
    },
    forcePathStyle: true,
});

function toBuffer(streamOrBuffer) {
    if (Buffer.isBuffer(streamOrBuffer)) return Promise.resolve(streamOrBuffer);
    if (streamOrBuffer instanceof Readable) {
        return new Promise((resolve, reject) => {
            const chunks = [];
            streamOrBuffer.on('data', (d) => chunks.push(d));
            streamOrBuffer.on('end', () => resolve(Buffer.concat(chunks)));
            streamOrBuffer.on('error', reject);
        });
    }
    return Promise.resolve(Buffer.from(String(streamOrBuffer || '')));
}

// Record shape точь-в-точь как в примере
// { id: string, text: string, embedding: number[], timestamp: string, meta?: any }

// Storage helpers (S3 + local fallback) - точь-в-точь как в примере
function s3KeyForClient(clientId) { return `memory/${clientId || 'anonymous'}.json`; }

// Функции загрузки и сохранения точь-в-точь как в LS_Memory_Example
async function loadDataset(clientId) {
    const key = s3KeyForClient(clientId);
    // Try S3
    try {
        const head = new HeadObjectCommand({ Bucket: bucketName, Key: key });
        await s3Client.send(head);
        const get = new GetObjectCommand({ Bucket: bucketName, Key: key });
        const res = await s3Client.send(get);
        const buf = await toBuffer(res.Body);
        return JSON.parse(buf.toString('utf-8'));
    } catch {
        // Fallback local
        try {
            const txt = await fs.readFile(fallbackPath(clientId), 'utf-8');
            return JSON.parse(txt);
        } catch {
            return [];
        }
    }
}

async function saveDataset(clientId, dataset) {
    const key = s3KeyForClient(clientId);
    const body = Buffer.from(JSON.stringify(dataset, null, 2), 'utf-8');
    try {
        const put = new PutObjectCommand({ Bucket: bucketName, Key: key, Body: body, ContentType: 'application/json', CacheControl: 'no-cache' });
        await s3Client.send(put);
    } catch (e) {
        await ensureDataDir();
        await fs.writeFile(fallbackPath(clientId), body);
    }
}

// Embedding service точь-в-точь как в примере
const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

async function embedTextBatch(texts) {
    if (!texts.length) return [];
    // The API shown in example is per-content; we do simple sequential batching for stability
    const vectors = [];
    for (const t of texts) {
        const res = await ai.models.embedContent({ model: EMBEDDING_MODEL, contents: [t], taskType: 'RETRIEVAL_DOCUMENT' });
        vectors.push(res.embeddings[0].values);
    }
    return vectors;
}

async function embedQuery(text) {
    const res = await ai.models.embedContent({ model: EMBEDDING_MODEL, contents: [text], taskType: 'RETRIEVAL_QUERY' });
    return res.embeddings[0].values;
}

// In-memory index (brute-force cosine for simplicity and stability) - точь-в-точь как в примере
class VectorIndex {
    constructor() { this.records = []; }
    load(records) { this.records = records; }
    upsert(record) {
        const idx = this.records.findIndex(r => r.id === record.id);
        if (idx >= 0) this.records[idx] = record; else this.records.push(record);
    }
    remove(id) { this.records = this.records.filter(r => r.id !== id); }
    search(queryEmbedding, topK = 10, minSimilarity = 0.0) {
        const scored = this.records.map(r => ({
            ...r,
            similarity: similarity(queryEmbedding, r.embedding)
        }));
        return scored
            .filter(s => s.similarity >= minSimilarity)
            .sort((a, b) => b.similarity - a.similarity)
            .slice(0, topK);
    }
}

const indexByClient = new Map();

// Хранилище просмотренных записей по сессиям
// sessionId -> Set<recordId>
const viewedRecordsBySession = new Map();

function getIndex(clientId) {
    const key = clientId || 'anonymous';
    if (!indexByClient.has(key)) indexByClient.set(key, new VectorIndex());
    return indexByClient.get(key);
}

// Получить или создать набор просмотренных записей для сессии
function getViewedRecords(sessionId) {
    if (!sessionId) return new Set(); // Если sessionId не передан, не фильтруем
    if (!viewedRecordsBySession.has(sessionId)) {
        viewedRecordsBySession.set(sessionId, new Set());
    }
    return viewedRecordsBySession.get(sessionId);
}

// Добавить записи в просмотренные для сессии
function markAsViewed(sessionId, recordIds) {
    if (!sessionId) return;
    const viewed = getViewedRecords(sessionId);
    recordIds.forEach(id => viewed.add(id));
}

// Очистить историю просмотров для сессии
function clearSessionHistory(sessionId) {
    if (sessionId && viewedRecordsBySession.has(sessionId)) {
        viewedRecordsBySession.delete(sessionId);
        return true;
    }
    return false;
}

// Bootstrap index on first request per client - точь-в-точь как в примере
async function ensureLoaded(clientId) {
    const idx = getIndex(clientId);
    if (idx.records.length === 0) {
        const dataset = await loadDataset(clientId);
        idx.load(dataset);
        console.log(chalk.gray(`[bootstrap] Loaded ${dataset.length} records for client=${clientId || 'anonymous'}`));
    }
}

// --- ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ---

/**
 * Remove HTML tags from text
 * @param {string} text - Text with possible HTML tags
 * @returns {string} Clean text without HTML tags
 */
function stripHtmlTags(text) {
    if (!text) return '';
    // Remove HTML tags
    let clean = text.replace(/<[^>]*>/g, '');
    // Decode common HTML entities
    clean = clean.replace(/&nbsp;/g, ' ');
    clean = clean.replace(/&amp;/g, '&');
    clean = clean.replace(/&lt;/g, '<');
    clean = clean.replace(/&gt;/g, '>');
    clean = clean.replace(/&quot;/g, '"');
    clean = clean.replace(/&#39;/g, "'");
    // Remove extra whitespace
    clean = clean.replace(/\s+/g, ' ').trim();
    return clean;
}

// --- ПУБЛИЧНЫЙ API ---

/**
 * Memory tool object with add and search methods
 */
export const memory = {
    /**
     * Add text to memory
     * @param {string} text - Text to add to memory
     * @param {string} clientId - Client identifier (optional)
     * @returns {Promise<string>} Success message with ID and total records
     */
    async add(text, clientId = 'default') {
        console.log(chalk.yellow('📝 Добавляем в память...'));
        console.log(chalk.gray(`Текст: ` + text));

        try {
            await ensureDataDir();
            await ensureLoaded(clientId);

            // Очищаем текст от HTML-тегов перед сохранением
            const cleanText = stripHtmlTags(text);

            // Используем новую архитектуру embedding
            const [vector] = await embedTextBatch([cleanText]);

            const record = {
                id: Date.now().toString(),
                text: cleanText,
                embedding: vector,
                timestamp: new Date().toISOString(),
                meta: null // Как в примере
            };

            // Используем VectorIndex как в примере
            const idx = getIndex(clientId);
            idx.upsert(record);

            // Сохраняем в ту же систему хранения
            await saveDataset(clientId, idx.records);

            console.log(chalk.green('✅ Успешно добавлено в память!'));
            console.log(chalk.gray(`Всего в памяти: ${idx.records.length} записей`));

            return `Текст успешно добавлен в память. ID: ${record.id}. Всего записей в памяти: ${idx.records.length}`;

        } catch (error) {
            console.error(chalk.red('❌ Ошибка при добавлении в память:'), error.message);
            throw new Error(`Ошибка при добавлении в память: ${error.message}`);
        }
    },

    /**
     * Search in memory
     * @param {string} query - Search query
     * @param {string} clientId - Client identifier (optional)
     * @param {string} sessionId - Session identifier to track viewed records (optional)
     * @returns {Promise<string>} Formatted search results
     */
    async search(query, clientId = 'default', sessionId = null) {
        console.log(chalk.blue('🔍 Поиск в памяти...'));
        console.log(chalk.gray(`Запрос: "${query}"${sessionId ? ` (Сессия: ${sessionId})` : ''}`));

        try {
            const apiUrl = process.env.MEMORY_API_URL || 'http://localhost:3000/v1/chat';

            const response = await fetch(apiUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ question: query })
            });

            if (!response.ok) {
                throw new Error(`API вернул статус ${response.status}: ${response.statusText}`);
            }

            const data = await response.json();

            if (!data.answer) {
                throw new Error('API не вернул поле answer в ответе');
            }

            console.log(chalk.green('✅ Поиск выполнен успешно'));
            return data.answer;

        } catch (error) {
            console.error(chalk.red('❌ Ошибка при поиске в памяти:'), error.message);
            throw new Error(`Ошибка при поиске в памяти: ${error.message}`);
        }
    },

    /**
     * Clear session history (viewed records)
     * @param {string} sessionId - Session identifier
     * @returns {Promise<string>} Success message
     */
    async clearSession(sessionId) {
        if (!sessionId) {
            return 'Ошибка: необходимо указать sessionId';
        }

        const cleared = clearSessionHistory(sessionId);
        if (cleared) {
            console.log(chalk.green(`✅ История просмотров для сессии ${sessionId} очищена`));
            return `История просмотров для сессии ${sessionId} успешно очищена`;
        } else {
            return `Сессия ${sessionId} не найдена или уже пуста`;
        }
    },

    /**
     * Get statistics about viewed records for a session
     * @param {string} sessionId - Session identifier
     * @returns {Promise<string>} Session statistics
     */
    async getSessionStats(sessionId) {
        if (!sessionId) {
            return 'Ошибка: необходимо указать sessionId';
        }

        const viewedRecords = getViewedRecords(sessionId);
        return `Сессия ${sessionId}: просмотрено ${viewedRecords.size} записей`;
    }
};

