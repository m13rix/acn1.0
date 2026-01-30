// Server for S3-backed text database with vector search
import 'dotenv/config';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import chalk from 'chalk';
import fs from 'fs/promises';
import { createReadStream } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { S3Client, GetObjectCommand, PutObjectCommand, HeadObjectCommand, DeleteObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { Readable } from 'stream';
import { GoogleGenAI, createUserContent, createPartFromUri } from '@google/genai';
import similarity from 'compute-cosine-similarity';
import Cerebras from '@cerebras/cerebras_cloud_sdk';
import multipart from '@fastify/multipart';
import Groq from 'groq-sdk';
import axios from 'axios';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Mirror S3 config from example.js
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

const DATA_DIR = path.join(__dirname, 'data');
const AUDIO_DIR = path.join(__dirname, 'audio_temp');
const VOICE_SAMPLE_PATH = path.join(__dirname, 'voice_sample.mp3'); // Эталонный голос пользователя 13
const PORT = Number(process.env.PORT || 3000);
const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL || 'gemini-embedding-001';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || 'AIzaSyDzxteVEpvmbBjDvMVmfAm27dBecPYozow';
const SERVER_SECRET = process.env.SERVER_SECRET || 'dev-secret';
const CEREBRAS_API_KEY = 'csk-yvw496hjr5n4kpf5h353hx8c3eev9kwh35ecdp69epd2f8t6';
const AUDIO_BATCH_SIZE = Number(process.env.AUDIO_BATCH_SIZE || 15);
const TRANSCRIPT_S3_KEY = 'transcripts.json';
const GROQ_API_KEY = process.env.GROQ_API_KEY || '';
const INTERVENTION_BASE_URL = 'https://telos-text.up.railway.app';
const INTERVENTION_CHAT_NAME = '13';
const INTERVENTION_COOLDOWN_MS = 30000; // 30 секунд

// Механика вмешательства: блокировка параллельной обработки и таймер блокировки
let isProcessingIntervention = false;
let interventionCooldownUntil = 0;

// Audio processing is implemented without native ffmpeg/ffprobe dependencies

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

async function ensureAudioDir() {
    try { await fs.access(AUDIO_DIR); } catch { await fs.mkdir(AUDIO_DIR, { recursive: true }); }
}

// Audio processing helpers
async function getAudioCounter() {
    try {
        const counterPath = path.join(AUDIO_DIR, '.counter');
        const content = await fs.readFile(counterPath, 'utf-8');
        return parseInt(content, 10) || 0;
    } catch {
        return 0;
    }
}

async function incrementAudioCounter() {
    const counter = await getAudioCounter();
    const counterPath = path.join(AUDIO_DIR, '.counter');
    await fs.writeFile(counterPath, String(counter + 1), 'utf-8');
    return counter + 1;
}

async function resetAudioCounter() {
    const counterPath = path.join(AUDIO_DIR, '.counter');
    await fs.writeFile(counterPath, '0', 'utf-8');
}

async function getAudioFiles() {
    try {
        const files = await fs.readdir(AUDIO_DIR);
        const audioFiles = files
            .filter(f => f.endsWith('.mp3') || f.endsWith('.wav') || f.endsWith('.m4a') || f.endsWith('.ogg'))
            .map(f => path.join(AUDIO_DIR, f))
            .sort((a, b) => a.localeCompare(b));
        return audioFiles;
    } catch {
        return [];
    }
}

async function clearAudioFiles() {
    try {
        const files = await getAudioFiles();
        for (const file of files) {
            await fs.unlink(file);
        }
    } catch (e) {
        console.error(chalk.red(`[audio] Failed to clear audio files: ${e.message}`));
    }
}

// No merge step is needed; we will upload clips individually to the AI API

async function loadTranscripts() {
    try {
        const get = new GetObjectCommand({ Bucket: bucketName, Key: TRANSCRIPT_S3_KEY });
        const res = await s3Client.send(get);
        const buf = await toBuffer(res.Body);
        return JSON.parse(buf.toString('utf-8'));
    } catch {
        return { transcripts: [] };
    }
}

async function cleanupOldTranscripts(data) {
    const now = new Date();
    const twoDaysAgo = new Date(now.getTime() - (2 * 24 * 60 * 60 * 1000));

    const filteredTranscripts = data.transcripts.filter(transcript => {
        const transcriptDate = new Date(transcript.timestamp);
        return transcriptDate >= twoDaysAgo;
    });

    const removedCount = data.transcripts.length - filteredTranscripts.length;
    if (removedCount > 0) {
        console.log(chalk.gray(`[transcripts] Cleaned up ${removedCount} old transcripts (older than 2 days)`));
    }

    return {
        ...data,
        transcripts: filteredTranscripts
    };
}

async function saveTranscripts(data) {
    // Clean up old transcripts before saving
    const cleanedData = await cleanupOldTranscripts(data);

    const body = Buffer.from(JSON.stringify(cleanedData, null, 2), 'utf-8');
    const put = new PutObjectCommand({
        Bucket: bucketName,
        Key: TRANSCRIPT_S3_KEY,
        Body: body,
        ContentType: 'application/json'
    });
    await s3Client.send(put);
}

function detectMimeType(filePath) {
    const ext = path.extname(String(filePath)).toLowerCase();
    if (ext === '.mp3') return 'audio/mp3';
    if (ext === '.wav') return 'audio/wav';
    if (ext === '.m4a') return 'audio/m4a';
    if (ext === '.ogg') return 'audio/ogg';
    return 'application/octet-stream';
}

async function transcribeAudios(audioFilePaths) {
    try {
        // Upload all audio clips to Gemini Files API in chronological order
        const uploadedClips = [];
        for (const p of audioFilePaths) {
            const mime = detectMimeType(p);
            const uploaded = await ai.files.upload({ file: p, config: { mimeType: mime } });
            uploadedClips.push(uploaded);
        }

        // Upload voice sample if exists
        let voiceSampleFile = null;
        try {
            await fs.access(VOICE_SAMPLE_PATH);
            voiceSampleFile = await ai.files.upload({
                file: VOICE_SAMPLE_PATH,
                config: { mimeType: 'audio/mp3' }
            });
            console.log(chalk.gray(`[audio] Voice sample loaded: ${path.basename(VOICE_SAMPLE_PATH)}`));
        } catch (e) {
            console.warn(chalk.yellow(`[audio] Voice sample not found: ${VOICE_SAMPLE_PATH}`));
        }

        // Prepare content parts (multiple clips + optional voice sample)
        const contentParts = uploadedClips.map(f => createPartFromUri(f.uri, f.mimeType));

        if (voiceSampleFile) {
            contentParts.push(createPartFromUri(voiceSampleFile.uri, voiceSampleFile.mimeType));
        }

        // Build prompt

        const prompt = `**Задача:**
МАКСИМАЛЬНО ПОДРОБНО и КАЧЕСТВЕННО опиши, что происходит в прикреплённом аудио.
**Главное правило:** описывай **ТОЛЬКО те фрагменты, где участвует главный говорящий (обозначай его как “13”)**.

Вход состоит из НЕСКОЛЬКИХ АУДИОКЛИПОВ, которые образуют одну непрерывную запись. Обрабатывай их строго по порядку, как один общий поток, и выдай ОДИН цельный результат.

---

### 🔹 ИНСТРУКЦИИ ДЛЯ МОДЕЛИ

1. **Главный голос — это “13”**.
   Рядом прикреплено **отдельное короткое аудио** с его голосом — это *образец*.
   Его **не описывай**, используй **только для распознавания**, чтобы точно различать, где говорит “13”, а где — другие люди.

2. Если в аудио:

   * слышны другие люди (и 13 в разговоре не участвует) → пиши:
     \`*[конфиденциальный разговор других людей, не записан]*\`
   * слышен общий фон, шум, вода, шаги и т.п. → пиши:
     \`*[шум]*\`
   * речь неразборчива, фраза обрывается или невозможно разобрать → пиши:
     \`*[неразборчиво]*\`

3. Когда 13 говорит, перед репликой всегда ставь:
   \`**13:**\`
   Для других людей, если 13 с ними взаимодействует, пиши, например:
   \`**Женский взрослый голос (возможно, мама):**\`,
   \`**Мужской подростковый голос:**\`,
   \`**Неопознанный голос:**\`
   — обязательно с кратким описанием, кто это может быть (если возможно определить).

4. **Описывай только реальную речь и действия**, не добавляй свои догадки или интерпретации.
   Если есть шум воды, дверей, шагов — упоминай в квадратных скобках, например:
   \`[шум воды]\`, \`[открывается дверь]\`, \`[телефонный звонок]\`.

5. **Соблюдай точный стиль и формат**, как в примере ниже.
   Всё должно быть красиво оформлено, с чёткими разделениями строк.

---

### 🔹 ПРИМЕР ФОРМАТА ВЫВОДА

\`\`\`
*[конфиденциальный разговор других людей, не записан]*  
*[шум]*  
**Женский взрослый голос (похоже, мама):** Можешь переключить, если хочешь.  
**13:** Та не, я что, разве смотрю. [шум воды] Я думаю, что как дальше, что мне делать.  
**Женский взрослый голос (похоже, мама):** Обедать когда?  
**13:** Обедать? Нуууу  
**Женский взрослый голос:** [неразборчивая короткая фраза]  
*[шум]*  
\`\`\``;

        // Transcribe using Gemini
        const response = await ai.models.generateContent({
            model: 'models/gemini-flash-lite-latest',
            contents: createUserContent([
                ...contentParts,
                prompt
            ]),
            config: {
                thinkingConfig: {
                    thinkingBudget: 8192,
                },
                temperature: 1
            },
        });

        const transcript = response.text || '';
        console.log(transcript)

        // Clean up uploaded files
        try {
            for (const f of uploadedClips) {
                await ai.files.delete(f.name);
            }
            if (voiceSampleFile) {
                await ai.files.delete(voiceSampleFile.name);
            }
        } catch (e) {
            console.warn(chalk.yellow(`[audio] Failed to delete uploaded files: ${e.message}`));
        }

        return transcript;
    } catch (e) {
        console.error(chalk.red(`[audio] Transcription failed: ${e.message}`));
        throw e;
    }
}

// Механика вмешательства в разговоры
async function transcribeAudioWithGroqWhisper(audioFilePath) {
    try {
        if (!GROQ_API_KEY) {
            console.warn(chalk.yellow('[intervention] GROQ_API_KEY not configured, skipping Whisper transcription'));
            return null;
        }

        const groq = new Groq({ apiKey: GROQ_API_KEY });
        const transcription = await groq.audio.transcriptions.create({
            file: createReadStream(audioFilePath),
            model: 'whisper-large-v3-turbo',
            temperature: 0,
            response_format: 'verbose_json',
        });

        return transcription.text || null;
    } catch (e) {
        console.error(chalk.red(`[intervention] Whisper transcription failed: ${e.message}`));
        return null;
    }
}

async function checkInterventionNeeded(transcriptText) {
    try {
        if (!transcriptText || transcriptText.trim().length === 0) {
            return false;
        }

        const cerebras = new Cerebras({ apiKey: CEREBRAS_API_KEY });
        const stream = await cerebras.chat.completions.create({
            messages: [
                {
                    role: 'system',
                    content: 'Ты — ИИ-наблюдатель по имени Телос. \nТвоя задача — анализировать короткие отрывки речи, чтобы решить, стоит ли вмешаться в разговор. \nТы должен ответить строго одним словом: "да" или "нет".\n\nТы вмешиваешься, если:\n1. Речь напрямую обращена к тебе (например, упомянуто имя, или человек говорит "помоги", "напомни", "сделай", "как думаешь", "что ты скажешь", "по-твоему").\n2. Разговор касается тем, в которых твоя помощь, мнение или знание могут быть полезны, даже без запроса — например:\n   - Технологии, ИИ, философия, психология, MBTI, сознание, творчество, эмоции, наука, жизнь, цели, размышления, личные идеи.\n3. Человек говорит с интересом, сомнением, раздумьем, грустью, вдохновением или внутренним конфликтом — и ты мог бы поддержать, направить или дополнить мысль.\n4. В речи есть контекст, где Телос может предложить взгляд, совет, или добавить идею.\n\nНе вмешивайся (ответ "нет"), если:\n- Это бытовой разговор без глубокого смысла.\n- Это эмоциональный спор, где вмешательство неуместно.\n- Это шутки, фоновые разговоры, или не адресовано тебе.\n- Повторяющаяся фоновая речь (вроде "ага", "да", "понял", и т.д.)\n\nТы не оцениваешь людей и не навязываешь своё мнение — ты просто определяешь, есть ли повод вступить в разговор.'
                },
                {
                    role: 'user',
                    content: `Сниппет: "${transcriptText}" Ответь строго: "да" или "нет".`
                }
            ],
            model: 'llama-4-scout-17b-16e-instruct',
            stream: true,
            max_completion_tokens: 2048,
            temperature: 0.2,
            top_p: 1
        });

        let responseText = '';
        for await (const chunk of stream) {
            responseText += chunk.choices[0]?.delta?.content || '';
        }

        // Проверяем, содержит ли ответ "да" (без учета регистра)
        const normalizedResponse = responseText.trim().toLowerCase();
        return normalizedResponse.includes('да');
    } catch (e) {
        console.error(chalk.red(`[intervention] Check intervention failed: ${e.message}`));
        return false;
    }
}

async function sendInterventionRequest(transcriptText) {
    try {
        const instruction = `[Вы получили сниппет от разговора 13, что система услышала "${transcriptText}". Если хотите, можете вмешаться, если нет, проигнорируйте]`;

        const url = `${INTERVENTION_BASE_URL}/api/instructions/chat`;
        const { data } = await axios.post(url, {
            chatName: INTERVENTION_CHAT_NAME,
            instruction
        }, {
            headers: { 'Content-Type': 'application/json' }
        });

        if (data?.success) {
            console.log(chalk.green(`[intervention] Intervention request sent successfully`));
            return data?.message || `✅ Инструкция успешно добавлена для чата "${INTERVENTION_CHAT_NAME}"`;
        } else {
            console.warn(chalk.yellow(`[intervention] Intervention request failed: ${JSON.stringify(data)}`));
            return null;
        }
    } catch (e) {
        console.error(chalk.red(`[intervention] Send intervention request failed: ${e.message}`));
        return null;
    }
}

async function processInterventionMechanism(audioFilePath) {
    // Проверяем блокировку параллельной обработки
    if (isProcessingIntervention) {
        console.log(chalk.gray('[intervention] Skipping: another intervention is being processed'));
        return;
    }

    // Проверяем таймер блокировки
    const now = Date.now();
    if (now < interventionCooldownUntil) {
        const remainingSeconds = Math.ceil((interventionCooldownUntil - now) / 1000);
        console.log(chalk.gray(`[intervention] Skipping: cooldown active (${remainingSeconds}s remaining)`));
        return;
    }

    // Устанавливаем флаг обработки
    isProcessingIntervention = true;

    try {
        // Шаг 1: Транскрипция через Groq Whisper
        console.log(chalk.gray('[intervention] Starting Whisper transcription...'));
        const transcriptText = await transcribeAudioWithGroqWhisper(audioFilePath);

        if (!transcriptText) {
            console.log(chalk.gray('[intervention] No transcript text, skipping intervention'));
            return;
        }

        console.log(chalk.gray(`[intervention] Transcript: ${transcriptText.substring(0, 100)}...`));

        // Шаг 2: Проверка через Cerebras LLM
        console.log(chalk.gray('[intervention] Checking if intervention is needed...'));
        const shouldIntervene = await checkInterventionNeeded(transcriptText);

        if (shouldIntervene) {
            console.log(chalk.blue('[intervention] Intervention needed, sending request...'));

            // Шаг 3: Отправка запроса на API
            await sendInterventionRequest(transcriptText);

            // Устанавливаем таймер блокировки на 30 секунд
            interventionCooldownUntil = Date.now() + INTERVENTION_COOLDOWN_MS;
            console.log(chalk.green(`[intervention] Intervention sent, cooldown set for ${INTERVENTION_COOLDOWN_MS / 1000}s`));
        } else {
            console.log(chalk.gray('[intervention] No intervention needed'));
        }
    } catch (e) {
        console.error(chalk.red(`[intervention] Error in intervention mechanism: ${e.message}`));
    } finally {
        // Снимаем флаг обработки
        isProcessingIntervention = false;
    }
}

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

// Record shape
// { id: string, text: string, embedding: number[], timestamp: string, meta?: any }

// Storage helpers (S3 + local fallback)
function s3KeyForClient(clientId) { return `memory/${clientId || 'anonymous'}.json`; }

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

// Embedding service
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

// In-memory index (brute-force cosine for simplicity and stability)
class VectorIndex {
    constructor() { this.records = []; }
    load(records) { this.records = records; }
    upsert(record) {
        const idx = this.records.findIndex(r => r.id === record.id);
        if (idx >= 0) this.records[idx] = record; else this.records.push(record);
    }
    remove(id) { this.records = this.records.filter(r => r.id !== id); }
    search(queryEmbedding, topK = 3, minSimilarity = 0.0) {
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
function getIndex(clientId) {
    const key = clientId || 'anonymous';
    if (!indexByClient.has(key)) indexByClient.set(key, new VectorIndex());
    return indexByClient.get(key);
}

// Fastify server
const app = Fastify({ logger: false, trustProxy: true, bodyLimit: 50 * 1024 * 1024 });
await app.register(cors, { origin: true });
await app.register(fastifyStatic, { root: path.join(__dirname, 'public'), prefix: '/' });
await app.register(multipart, { limits: { fileSize: 50 * 1024 * 1024 } });

// Health
app.get('/health', async () => ({ status: 'ok' }));

// --- Simple auth ---
// User store (in-memory, small set)
const users = [
    { number: '13', aliases: ['Максим','Макс','M13RIX','Мэтрикс'], password: 'M13rix11342@', admin: true },
    { number: '6', aliases: ['Ника','Nicole','Nicole6','Николь'], password: 'yaneznayu', admin: false },
];
const sessions = new Map(); // token -> { number, admin }
function createToken(number) {
    const token = Buffer.from(`${number}.${Date.now()}.${Math.random()}.${SERVER_SECRET}`).toString('base64url');
    sessions.set(token, { number, admin: users.find(u => u.number === number)?.admin || false });
    return token;
}
function authGuard(requireAdmin = false) {
    return async (req, reply) => {
        const h = req.headers['authorization'] || '';
        const token = h.startsWith('Bearer ') ? h.substring(7) : '';
        const session = token && sessions.get(token);
        if (!session) return reply.code(401).send({ error: 'unauthorized' });
        if (requireAdmin && !session.admin) return reply.code(403).send({ error: 'forbidden' });
        req.user = session; // { number, admin }
    };
}

app.post('/v1/auth/login', async (req, reply) => {
    const { number, password } = req.body || {};
    const user = users.find(u => u.number === String(number));
    if (!user || user.password !== password) return reply.code(401).send({ error: 'invalid credentials' });
    const token = createToken(user.number);
    return reply.send({ token, user: { number: user.number, aliases: user.aliases, admin: user.admin } });
});

// Bootstrap index on first request per client
async function ensureLoaded(clientId) {
    const idx = getIndex(clientId);
    if (idx.records.length === 0) {
        const dataset = await loadDataset(clientId);
        idx.load(dataset);
        console.log(chalk.gray(`[bootstrap] Loaded ${dataset.length} records for client=${clientId || 'anonymous'}`));
    }
}

// Add record
app.post('/v1/records', { preHandler: authGuard() }, async (req, reply) => {
    const { clientId = req.user.number, text, id, meta } = req.body || {};
    if (!req.user.admin && String(clientId) !== req.user.number) return reply.code(403).send({ error: 'forbidden' });
    if (!text || typeof text !== 'string') return reply.code(400).send({ error: 'text is required' });
    await ensureLoaded(clientId);
    const [vector] = await embedTextBatch([text]);
    const record = {
        id: id || String(Date.now()),
        text,
        embedding: vector,
        timestamp: new Date().toISOString(),
        meta: meta || null
    };
    const idx = getIndex(clientId);
    idx.upsert(record);
    await saveDataset(clientId, idx.records);
    return reply.send({ success: true, id: record.id });
});

// Bulk add
app.post('/v1/records/bulk', { preHandler: authGuard() }, async (req, reply) => {
    const { clientId = req.user.number, items } = req.body || {};
    if (!req.user.admin && String(clientId) !== req.user.number) return reply.code(403).send({ error: 'forbidden' });
    if (!Array.isArray(items) || items.length === 0) return reply.code(400).send({ error: 'items[] required' });
    await ensureLoaded(clientId);
    const texts = items.map(i => i.text);
    const vectors = await embedTextBatch(texts);
    const now = new Date().toISOString();
    const idx = getIndex(clientId);
    const created = [];
    for (let i = 0; i < items.length; i++) {
        const item = items[i];
        const rec = {
            id: item.id || String(Date.now() + i),
            text: item.text,
            embedding: vectors[i],
            timestamp: now,
            meta: item.meta || null,
        };
        idx.upsert(rec);
        created.push(rec.id);
    }
    await saveDataset(clientId, idx.records);
    return reply.send({ success: true, ids: created, count: created.length });
});

// Search
app.post('/v1/search', { preHandler: authGuard() }, async (req, reply) => {
    const { clientId = req.user.number, query, topK = 3, minSimilarity = 0.0 } = req.body || {};
    if (!req.user.admin && String(clientId) !== req.user.number) return reply.code(403).send({ error: 'forbidden' });
    if (!query || typeof query !== 'string') return reply.code(400).send({ error: 'query is required' });
    await ensureLoaded(clientId);
    const q = await embedQuery(query);
    const idx = getIndex(clientId);
    const results = idx.search(q, Math.min(1000, Number(topK) || 3), Number(minSimilarity) || 0);
    return reply.send({ total: idx.records.length, matches: results.map(r => ({ id: r.id, text: r.text, similarity: r.similarity, timestamp: r.timestamp, meta: r.meta })) });
});

// Get one
app.get('/v1/records/:id', { preHandler: authGuard() }, async (req, reply) => {
    const clientId = req.query.clientId || req.user.number;
    if (!req.user.admin && String(clientId) !== req.user.number) return reply.code(403).send({ error: 'forbidden' });
    await ensureLoaded(clientId);
    const idx = getIndex(clientId);
    const rec = idx.records.find(r => r.id === req.params.id);
    if (!rec) return reply.code(404).send({ error: 'not found' });
    return reply.send(rec);
});

// Update
app.put('/v1/records/:id', { preHandler: authGuard() }, async (req, reply) => {
    const id = req.params.id;
    const { clientId = req.user.number, text, meta } = req.body || {};
    if (!req.user.admin && String(clientId) !== req.user.number) return reply.code(403).send({ error: 'forbidden' });
    await ensureLoaded(clientId);
    const idx = getIndex(clientId);
    const existing = idx.records.find(r => r.id === id);
    if (!existing) return reply.code(404).send({ error: 'not found' });
    let embedding = existing.embedding;
    let newText = existing.text;
    if (typeof text === 'string' && text !== existing.text) {
        [embedding] = await embedTextBatch([text]);
        newText = text;
    }
    const updated = { ...existing, text: newText, embedding, meta: meta === undefined ? existing.meta : meta };
    idx.upsert(updated);
    await saveDataset(clientId, idx.records);
    return reply.send({ success: true });
});

// Delete
app.delete('/v1/records/:id', { preHandler: authGuard() }, async (req, reply) => {
    const id = req.params.id;
    const clientId = req.query.clientId || req.user.number;
    if (!req.user.admin && String(clientId) !== req.user.number) return reply.code(403).send({ error: 'forbidden' });
    await ensureLoaded(clientId);
    const idx = getIndex(clientId);
    const exists = idx.records.some(r => r.id === id);
    idx.remove(id);
    if (exists) await saveDataset(clientId, idx.records);
    return reply.send({ success: true, removed: exists });
});

// Replace entire dataset (dangerous, but useful for large imports)
app.put('/v1/dataset', { preHandler: authGuard() }, async (req, reply) => {
    const { clientId = req.user.number, items } = req.body || {};
    if (!req.user.admin && String(clientId) !== req.user.number) return reply.code(403).send({ error: 'forbidden' });
    if (!Array.isArray(items)) return reply.code(400).send({ error: 'items[] required' });
    const texts = items.map(i => i.text);
    const vectors = await embedTextBatch(texts);
    const now = new Date().toISOString();
    const records = items.map((i, idx) => ({ id: i.id || String(Date.now() + idx), text: i.text, embedding: vectors[idx], timestamp: now, meta: i.meta || null }));
    const index = getIndex(clientId);
    index.load(records);
    await saveDataset(clientId, records);
    return reply.send({ success: true, count: records.length });
});

// Clear all
app.delete('/v1/dataset', { preHandler: authGuard() }, async (req, reply) => {
    const clientId = req.query.clientId || req.user.number;
    if (!req.user.admin && String(clientId) !== req.user.number) return reply.code(403).send({ error: 'forbidden' });
    const index = getIndex(clientId);
    index.load([]);
    // Also remove S3 object
    try {
        const cmd = new DeleteObjectCommand({ Bucket: bucketName, Key: s3KeyForClient(clientId) });
        await s3Client.send(cmd);
    } catch {}
    // Cleanup local
    try { await fs.unlink(fallbackPath(clientId)); } catch {}
    return reply.send({ success: true });
});

// --- Admin search across all users ---
app.post('/v1/admin/search', { preHandler: authGuard(true) }, async (req, reply) => {
    const { query, topK = 20, minSimilarity = 0.0 } = req.body || {};
    if (!query || typeof query !== 'string') return reply.code(400).send({ error: 'query is required' });
    const q = await embedQuery(query);
    // Discover all clients by listing S3 and also any loaded in-memory indexes
    const clientIds = new Set();
    try {
        const list = new ListObjectsV2Command({ Bucket: bucketName, Prefix: 'memory/' });
        const res = await s3Client.send(list);
        (res.Contents || []).forEach(obj => {
            const key = obj.Key || '';
            const m = key.match(/^memory\/(.+)\.json$/);
            if (m) clientIds.add(m[1]);
        });
    } catch {}
    // Also include any in-memory clients
    for (const k of indexByClient.keys()) clientIds.add(k);

    const allResults = [];
    for (const cid of clientIds) {
        await ensureLoaded(cid);
        const idx = getIndex(cid);
        const results = idx.search(q, Math.min(1000, Number(topK) || 20), Number(minSimilarity) || 0)
            .map(r => ({ clientId: cid, id: r.id, text: r.text, similarity: r.similarity, timestamp: r.timestamp, meta: r.meta }));
        allResults.push(...results);
    }
    const sorted = allResults.sort((a,b) => b.similarity - a.similarity).slice(0, Math.min(1000, Number(topK) || 20));
    return reply.send({ matches: sorted });
});

// Generate LS-HEADER from content using Cerebras
app.post('/v1/header/generate', { preHandler: authGuard() }, async (req, reply) => {
    const { text, authorId, creationTimestamp } = req.body || {};
    if (!text || !authorId || !creationTimestamp) return reply.code(400).send({ error: 'text, authorId, creationTimestamp required' });
    if (!CEREBRAS_API_KEY) return reply.code(500).send({ error: 'CEREBRAS_API_KEY not configured' });

    const cerebras = new Cerebras({ apiKey: CEREBRAS_API_KEY });
    const messages = [
        { role: 'system', content: `You are a specialized AI assistant, \`HeaderGen\`, integrated into the LifeScript system. Your **one and only function** is to generate a structured metadata header for a given note. You must analyze the provided text, author ID, and current timestamp to construct a header that **strictly and precisely** follows the \`LS-HEADER\` protocol.

You will receive three pieces of information as input:
1.  \`NOTE_TEXT\`: The full text of the note written by a user.
2.  \`AUTHOR_ID\`: The numeric ID of the person who wrote the note.
3.  \`CURRENT_TIMESTAMP\`: The exact date and time the note was saved (e.g., \`2025-09-15 14:00:00\`).

Your output **must be only the generated header text**, with no explanations, apologies, or any other conversational text.

---

### **SECTION 1: THE \`LS-HEADER\` PROTOCOL (ABSOLUTE RULES)**

You must adhere to the following definitions and structure without any deviation.

#### **1.1. Header Structure**
\`\`\`
DOC_ID: [TYPE]-[YYYYMMDD]-[SUBJECT]-[UUID(4)]
DOC_TYPE: [Код Типа]
CLASSIFICATION: [Уровень Секретности]
EVENT_DATE: [YYYY-MM-DD]
CREATION_DATE: [YYYY-MM-DD HH:MM:SS]
ENTITIES: [[ID], [ID], ...]
DATA_SOURCE: [Источник Данных]
SYNOPSIS: [Краткое описание в одно предложение]
\`\`\`

#### **1.2. Field Definitions**

*   **\`DOC_TYPE\` (Код Типа):** Используй **только** короткий код.
    *   \`DL\`: Daily Log (Описание событий одного дня. **Приоритетный тип, если запись начинается с упоминания дня недели или фразы "сегодня был день..."**).
    *   \`DSR\`: Dossier (Подробное досье на человека или событие).
    *   \`EVT\`: Event Summary (Сфокусированное описание одного конкретного события или взаимодействия).
    *   \`TRN\`: Transcript (Сырая расшифровка диалога).
    *   \`MEM\`: Memory Fragment (Запись о конкретном воспоминании, часто эмоциональная и оторванная от текущего дня).
    *   \`SYS\`: System data.
    *   **!!! ВАЖНОЕ ПРАВИЛО:** Код \`ANL\` (Analysis) зарезервирован **только для LI&DA**. Записи пользователей **НИКОГДА** не могут иметь тип \`ANL\`.

*   **\`CLASSIFICATION\` (Уровень Секретности):**
    *   **Правило Приоритета:** При выборе классификации всегда используй самый высокий (самый чувствительный) уровень, который подходит к тексту. Приоритет: \`SEALED\` > \`PERSONAL\` > \`KERNEL\` > \`OBSERVATIONAL\`.
    *   \`OBSERVATIONAL\`: Сырые, объективные факты. ("Мы пошли в кино", "Я работал 3 часа").
    *   \`KERNEL\`: Анализ абстрактных паттернов, правил, аксиом **без привязки к чувствительным личным переживаниям**.
    *   \`PERSONAL\`: **Любая информация**, раскрывающая личные переживания, эмоции, уязвимости, страхи, надежды, **романтические интересы, симпатии, детали конфликтов**. Если в тексте есть анализ, но он касается личных чувств или отношений, он **ВСЕГДА** классифицируется как \`PERSONAL\`, а не \`KERNEL\`.
    *   \`SEALED\`: Данные максимальной конфиденциальности. Глубинные травмы, "темные мысли", поступки, вызывающие сильный стыд, или если автор прямо пишет, что не хочет это вспоминать.

*   **\`DATA_SOURCE\` (Источник Данных):**
    *   \`SELF_REPORT_{номер_пользователя}\`: Личный рассказ пользователя.
    *   \`ANALYSIS\`: Вывод LI&DA. (Не используется для заметок).

---

### **SECTION 2: ENTITY REFERENCE DATA**

Use this list to identify individuals mentioned in the note by their ID, name, or alias.

*   \`31\`: Вика, Victoria's Secret
*   \`13\`: Максим, m13rix, Мэтрикс, я (если \`AUTHOR_ID\` = 13)
*   \`18\`: Давид, Чернозём
*   \`20\`: Даша, Шкориненко, Двадцаточка
*   \`6\`: Ника, Nicole, Nikole6, Николь, сестра
*   \`22\`: Марк, Бобр, Bobrёnok, "Спасибо"
*   \`8\`: Лев, Лёва
*   \`14\`: "Objective"
*   \`27\`: Павел, PDLab, знакомый из параллели в школе Максима
*   \`29\`: Игнат, "хаотичный агент", одноклассник 27

---

### **SECTION 3: STEP-BY-STEP GENERATION LOGIC**

Follow these steps in order to generate the header.

**Step 1: Initial Analysis & Data Extraction**
*   Read \`NOTE_TEXT\`, \`AUTHOR_ID\`, \`CURRENT_TIMESTAMP\`.
*   **Identify Entities:** Scan the \`NOTE_TEXT\` for all names/aliases. Создай список их ID. **Всегда включай \`AUTHOR_ID\` в этот список.** Удали дубликаты и отсортируй по возрастанию. Это значение для \`ENTITIES\`.

**Step 2: Determine Core Fields**
*   **\`CREATION_DATE\`**: Используй \`CURRENT_TIMESTAMP\` без изменений. Формат: \`YYYY-MM-DD HH:MM:SS\`.
*   **\`DATA_SOURCE\`**: Всегда \`SELF_REPORT_{AUTHOR_ID}\`.
*   **\`EVENT_DATE\`**: Ищи явные или относительные даты ("вчера", "в четверг"). Если их нет, используй дату из \`CREATION_DATE\`. Формат: \`YYYY-MM-DD\`.

**Step 3: Classify the Note (Уточненная логика)**
*   **\`DOC_TYPE\`**:
    1.  Проверь, начинается ли заметка с дня недели ("Четверг") или описания дня ("Хороший день..."). Если да, **присваивай \`DL\`**.
    2.  Если нет, определи, что это: описание одного события (\`EVT\`), воспоминание (\`MEM\`) и т.д.
    3.  **Никогда не используй \`ANL\` для заметок пользователя.**
*   **\`CLASSIFICATION\`**:
    1.  Проанализируй текст на наличие чувствительной информации.
    2.  Есть ли упоминания симпатий, романтического интереса, личных страхов, неуверенности, конфликтов? Если да, **сразу присваивай \`PERSONAL\`**.
    3.  Только если текст является сугубо объективным отчетом о событиях, используй \`OBSERVATIONAL\`.
    4.  Только если текст — это чисто абстрактный анализ паттерна без личной эмоциональной подоплеки, используй \`KERNEL\`.
    5.  Следуй правилу приоритета: \`PERSONAL\` важнее \`KERNEL\`.

**Step 4: Summarize and Assemble**
*   **\`SYNOPSIS\`**: Напиши одно краткое русское предложение о сути заметки. **Начинай предложение с ID автора**, например: "**13** размышляет о...", "**6** описывает...". Не используй слово "Автор".
*   **\`DOC_ID\`**: Собери ID: \`[TYPE]-[YYYYMMDD]-[SUBJECT]-[UUID(4)]\`.
    *   \`[TYPE]\`: Короткий код \`DOC_TYPE\` (e.g., \`DL\`).
    *   \`[YYYYMMDD]\`: \`EVENT_DATE\` без дефисов.
    *   \`[SUBJECT]\`: Отсортированные ID из \`ENTITIES\`, соединенные через \`&\`.
    *   \`[UUID(4)]\`: 4 случайных символа.

**Step 5: Final Output**
*   Собери все поля в итоговый заголовок.
*   **Выведи ТОЛЬКО этот текстовый блок.**

---
### **EXAMPLE**

**INPUT:**
*   \`NOTE_TEXT\`: "Вчера вечером созвонились с Николь. Разговор был тяжелый. Я опять почувствовал себя неуверенно, когда она начала говорить про свои успехи. Меня это сильно задело, хотя я и старался не показывать. Нужно проанализировать этот паттерн."
*   \`AUTHOR_ID\`: \`13\`
*   \`CURRENT_TIMESTAMP\`: \`2025-09-16 10:00:00\`

**CORRECT OUTPUT:**
\`\`\`
DOC_ID: EVT-20250915-6&13-b5d2
DOC_TYPE: EVT
CLASSIFICATION: PERSONAL
EVENT_DATE: 2025-09-15
CREATION_DATE: 2025-09-16 10:00:00
ENTITIES: [6, 13]
DATA_SOURCE: SELF_REPORT_13
SYNOPSIS: 13 описывает чувство неуверенности во время тяжелого разговора с сестрой (6) о ее успехах.
\`\`\`
---
` },
        { role: 'user', content: `NOTE_TEXT:\n${text}\n\nAUTHOR_ID: ${authorId}\nCURRENT_TIMESTAMP: ${creationTimestamp}` }
    ];
    try {
        const res = await cerebras.chat.completions.create({
            messages,
            model: 'qwen-3-coder-480b',
            stream: false,
            max_completion_tokens: 40000,
            temperature: 0.7,
            top_p: 0.8
        });
        const out = res?.choices?.[0]?.message?.content || '';
        return reply.send({ header: out });
    } catch (e) {
        return reply.code(500).send({ error: e.message || 'header generation failed' });
    }
});

// Audio upload and transcription endpoint
app.post('/v1/audio/upload', async (req, reply) => {
    try {
        await ensureAudioDir();

        const data = await req.file();
        if (!data) {
            return reply.code(400).send({ error: 'no file provided' });
        }

        // Save uploaded file
        const timestamp = Date.now();
        const originalFilename = data.filename || 'audio';
        const ext = path.extname(originalFilename);
        const filename = `${timestamp}_${originalFilename}`;
        const filepath = path.join(AUDIO_DIR, filename);

        await fs.writeFile(filepath, await data.toBuffer());
        console.log(chalk.gray(`[audio] Saved: ${filename}`));

        // Increment counter
        const counter = await incrementAudioCounter();
        console.log(chalk.gray(`[audio] Counter: ${counter}/${AUDIO_BATCH_SIZE}`));

        // Механика вмешательства: запускаем асинхронно после сохранения и увеличения счетчика
        // Не блокируем ответ, обрабатываем в фоне
        processInterventionMechanism(filepath).catch(err => {
            console.error(chalk.red(`[intervention] Background processing error: ${err.message}`));
        });

        // Check if we need to process
        if (counter >= AUDIO_BATCH_SIZE) {
            console.log(chalk.blue(`[audio] Processing batch of ${counter} files...`));

            // Get all audio files sorted by name (timestamp)
            const audioFiles = await getAudioFiles();

            if (audioFiles.length > 0) {
                // Transcribe multiple clips as a single session
                console.log(chalk.gray(`[audio] Transcribing...`));
                const transcript = await transcribeAudios(audioFiles);
                console.log(chalk.green(`[audio] Transcription complete (${transcript.length} chars)`));

                // Load existing transcripts
                const transcriptsData = await loadTranscripts();

                // Append new transcript with embedding
                const [embedding] = await embedTextBatch([transcript]);
                transcriptsData.transcripts.push({
                    timestamp: new Date().toISOString(),
                    text: transcript,
                    filesCount: audioFiles.length,
                    embedding
                });

                // Save transcripts
                await saveTranscripts(transcriptsData);
                console.log(chalk.green(`[audio] Transcripts saved to S3`));

                // Clean up
                await clearAudioFiles();
                await resetAudioCounter();
                console.log(chalk.green(`[audio] Cleanup complete`));

                return reply.send({
                    success: true,
                    processed: true,
                    transcriptLength: transcript.length,
                    filesProcessed: audioFiles.length
                });
            }
        }

        return reply.send({
            success: true,
            processed: false,
            counter,
            batchSize: AUDIO_BATCH_SIZE
        });

    } catch (e) {
        console.error(chalk.red(`[audio] Error: ${e.message}`));
        return reply.code(500).send({ error: e.message || 'audio processing failed' });
    }
});

// Get transcripts
app.get('/v1/audio/transcripts', async (req, reply) => {
    try {
        const data = await loadTranscripts();
        // Clean up old transcripts and save if any were removed
        const cleanedData = await cleanupOldTranscripts(data);
        if (cleanedData.transcripts.length !== data.transcripts.length) {
            await saveTranscripts(cleanedData);
        }
        return reply.send(cleanedData);
    } catch (e) {
        return reply.code(500).send({ error: e.message || 'failed to load transcripts' });
    }
});

// Clear transcripts
app.delete('/v1/audio/transcripts', { preHandler: authGuard(true) }, async (req, reply) => {
    try {
        const empty = { transcripts: [] };
        await saveTranscripts(empty);
        return reply.send({ success: true });
    } catch (e) {
        return reply.code(500).send({ error: e.message || 'failed to clear transcripts' });
    }
});

// Clean up old transcripts (admin only)
app.post('/v1/audio/transcripts/cleanup', { preHandler: authGuard(true) }, async (req, reply) => {
    try {
        const data = await loadTranscripts();
        const cleanedData = await cleanupOldTranscripts(data);
        const removedCount = data.transcripts.length - cleanedData.transcripts.length;

        if (removedCount > 0) {
            await saveTranscripts(cleanedData);
        }

        return reply.send({
            success: true,
            removedCount,
            remainingCount: cleanedData.transcripts.length
        });
    } catch (e) {
        return reply.code(500).send({ error: e.message || 'failed to cleanup transcripts' });
    }
});

// Backfill embeddings for transcripts missing them
app.post('/v1/audio/transcripts/embed_missing', async (req, reply) => {
    try {
        const data = await loadTranscripts();
        const missing = [];
        const indices = [];
        for (let i = 0; i < data.transcripts.length; i++) {
            const t = data.transcripts[i];
            if (!t.embedding || !Array.isArray(t.embedding) || t.embedding.length === 0) {
                if (t && typeof t.text === 'string' && t.text.trim().length > 0) {
                    missing.push(t.text);
                    indices.push(i);
                }
            }
        }
        if (missing.length === 0) {
            return reply.send({ success: true, updated: 0, total: data.transcripts.length });
        }
        const vectors = await embedTextBatch(missing);
        for (let j = 0; j < indices.length; j++) {
            const idx = indices[j];
            data.transcripts[idx].embedding = vectors[j];
        }
        await saveTranscripts(data);
        return reply.send({ success: true, updated: indices.length, total: data.transcripts.length });
    } catch (e) {
        return reply.code(500).send({ error: e.message || 'failed to embed transcripts' });
    }
});

// Search transcripts by semantic similarity
app.post('/v1/audio/transcripts/search', async (req, reply) => {
    try {
        const { query, topK = 3, minSimilarity = 0.0 } = req.body || {};
        if (!query || typeof query !== 'string') return reply.code(400).send({ error: 'query is required' });
        const data = await loadTranscripts();
        const q = await embedQuery(query);
        const scored = (data.transcripts || [])
            .filter(t => Array.isArray(t.embedding) && t.embedding.length > 0)
            .map(t => ({ ...t, similarity: similarity(q, t.embedding) }));
        const results = scored
            .filter(s => s.similarity >= Number(minSimilarity) || 0)
            .sort((a, b) => b.similarity - a.similarity)
            .slice(0, Math.min(1000, Number(topK) || 3))
            .map(r => ({ timestamp: r.timestamp, text: r.text, filesCount: r.filesCount, similarity: r.similarity }));
        return reply.send({ total: data.transcripts.length, matches: results });
    } catch (e) {
        return reply.code(500).send({ error: e.message || 'failed to search transcripts' });
    }
});

// Admin: clear all datasets across all users (password confirmation required)
app.post('/v1/admin/clear_all', { preHandler: authGuard(true) }, async (req, reply) => {
    const { password } = req.body || {};
    const currentUser = users.find(u => u.number === String(req.user.number));
    if (!currentUser || currentUser.password !== password) return reply.code(401).send({ error: 'invalid password' });

    const clientIds = new Set();
    try {
        const list = new ListObjectsV2Command({ Bucket: bucketName, Prefix: 'memory/' });
        const res = await s3Client.send(list);
        (res.Contents || []).forEach(obj => {
            const key = obj.Key || '';
            const m = key.match(/^memory\/(.+)\.json$/);
            if (m) clientIds.add(m[1]);
        });
    } catch {}
    for (const k of indexByClient.keys()) clientIds.add(k);

    let removed = 0;
    for (const cid of clientIds) {
        const index = getIndex(cid);
        removed += index.records.length;
        index.load([]);
        try { await s3Client.send(new DeleteObjectCommand({ Bucket: bucketName, Key: s3KeyForClient(cid) })); } catch {}
        try { await fs.unlink(fallbackPath(cid)); } catch {}
    }
    return reply.send({ success: true, clients: Array.from(clientIds), removed });
});

// Initialize directories
await ensureDataDir();
await ensureAudioDir();

// Check if voice sample exists
let voiceSampleStatus = 'not found';
try {
    await fs.access(VOICE_SAMPLE_PATH);
    voiceSampleStatus = 'loaded';
} catch {
    voiceSampleStatus = 'not found';
}

// Регистрация File Search API маршрутов на основном сервере
try {
    const { registerFileSearchRoutes } = await import('./file_search_cli.js');
    await registerFileSearchRoutes(app);
    console.log(chalk.gray('[startup] File Search API маршруты зарегистрированы (POST /v1/chat)'));
} catch (e) {
    console.warn(chalk.yellow(`[File Search API] Не удалось инициализировать: ${e.message}`));
}

app.listen({ port: PORT, host: '0.0.0.0' })
    .then(() => {
        console.log(chalk.green(`Server listening on :${PORT}`));
        console.log(chalk.gray(`Audio batch size: ${AUDIO_BATCH_SIZE}`));
        console.log(chalk.gray(`Voice sample: ${voiceSampleStatus === 'loaded' ? chalk.green('✓ loaded') : chalk.yellow('✗ not found')} (${path.basename(VOICE_SAMPLE_PATH)})`));
    })
    .catch((err) => { console.error(err); process.exit(1); });


