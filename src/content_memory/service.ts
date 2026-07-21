import 'dotenv/config';
import * as lancedb from '@lancedb/lancedb';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { copyFile, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ffmpegPath from '@ffmpeg-installer/ffmpeg';
import { lookup as lookupMime } from 'mime-types';
import { analyzeAutoCandidateSelection } from '../memory_system/search.js';
import { cosineSimilarity, embedBatch, embedText } from '../memory_system/embeddings.js';

export type ContentCollection = 'notes' | 'conversation_transcripts' | 'advisor_context';
export type ContentKind = 'text' | 'image' | 'audio' | 'video' | 'file';

export interface ContentSearchOptions {
  count?: number;
  recencyBias?: number;
  transcriptLabel?: string;
}

export interface ContentReembedResult {
  collection: ContentCollection;
  model: string;
  reembedded: number;
  skipped: number;
}

export interface ContentSearchResult {
  id: string;
  noteId?: string;
  createdAt: string;
  updatedAt: string;
  summary: string;
  author?: string;
  transcript?: string;
  labels?: string[];
  score: number;
}

export interface StoredContentRow {
  id: string;
  collection: ContentCollection;
  kind: ContentKind;
  originalName: string;
  originalPathRel: string;
  archivePath: string;
  mimeType: string;
  summary: string;
  text: string;
  transcriptJson: string;
  labelsJson: string;
  embeddingJson: string;
  embeddingModel: string;
  author: string;
  createdAt: string;
  updatedAt: string;
  archivedAt: string;
  expiresAt: string;
}

export interface StoredContentSentenceRow {
  id: string;
  contentId: string;
  collection: ContentCollection;
  sentenceIndex: number;
  text: string;
  embeddingJson: string;
  embeddingModel: string;
  sourceUpdatedAt: string;
  createdAt: string;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const DATA_DIR = path.join(PROJECT_ROOT, 'data', 'content-memory');
const FILES_DIR = path.join(DATA_DIR, 'files');
const TABLE_NAME = 'content_memory_v1';
const SENTENCE_TABLE_NAME = 'content_memory_sentences_v1';
const DEFAULT_NOTES_PATH = 'E:\\My Drive\\Notes\\Main';
const DAY_MS = 24 * 60 * 60 * 1000;
const MONTH_MS = 31 * DAY_MS;

function nowIso(): string {
  return new Date().toISOString();
}

function resolveNotesPath(): string {
  return path.resolve(process.env.TELOS_NOTES_PATH || process.env.MEMORY_NOTES_PATH || DEFAULT_NOTES_PATH);
}

function inferKind(filePath: string, mimeType: string): ContentKind {
  const ext = path.extname(filePath).toLowerCase();
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('audio/')) return 'audio';
  if (mimeType.startsWith('video/')) return 'video';
  if (mimeType.startsWith('text/') || ['.md', '.txt', '.json', '.yaml', '.yml', '.csv'].includes(ext)) return 'text';
  return 'file';
}

function isTechnicalPath(relativePath: string): boolean {
  const parts = relativePath.split(/[\\/]+/).map((part) => part.toLowerCase());
  return parts.some((part) =>
    part === '.obsidian'
    || part === '.git'
    || part === 'node_modules'
    || part === '.trash'
    || part === '.stfolder'
    || part === '.stversions'
    || part.endsWith('.tmp')
  );
}

function authorFromName(name: string): string {
  return /\bTELOS\b/i.test(name) ? 'Telos' : 'Subject 13';
}

function cleanSentence(text: string): string {
  const cleaned = String(text || '').replace(/\s+/g, ' ').trim();
  if (!cleaned) return '';
  const first = cleaned.match(/^(.+?[.!?])\s/)?.[1] || cleaned;
  return first.length > 260 ? `${first.slice(0, 257).trim()}...` : first;
}

function wordCount(text: string): number {
  return String(text || '').trim().split(/\s+/u).filter(Boolean).length;
}

function splitSentencesDeterministically(text: string): string[] {
  const normalized = String(text || '').replace(/\r\n?/g, '\n').trim();
  if (!normalized) return [];
  return normalized
    .split(/(?<=[.!?。！？])\s+|\n+/u)
    .map((sentence) => sentence.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

function stableIdFor(collection: ContentCollection, relativePath: string): string {
  return `${collection}:${Buffer.from(relativePath.toLowerCase()).toString('base64url')}`;
}

function parseJson<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== 'string') return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function embeddingProviderForModel(model: string): 'google' | 'openrouter' {
  return model.includes('/') ? 'openrouter' : 'google';
}

async function pathExists(filePath: string): Promise<boolean> {
  return stat(filePath).then(() => true).catch(() => false);
}

async function runFfmpeg(args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(ffmpegPath.path, args, { windowsHide: true });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited with ${code}: ${stderr.slice(-1000)}`));
    });
  });
}

async function prepareEmbeddingMedia(filePath: string, kind: ContentKind, workDir: string): Promise<string> {
  if (kind === 'audio') {
    const out = path.join(workDir, 'embedding-audio.wav');
    await runFfmpeg(['-y', '-i', filePath, '-t', '180', '-vn', '-acodec', 'pcm_s16le', out]);
    return out;
  }
  if (kind === 'video') {
    const out = path.join(workDir, 'embedding-video.mp4');
    await runFfmpeg([
      '-y',
      '-i', filePath,
      '-vf', "select='not(mod(n,30))',setpts=N/FRAME_RATE/TB",
      '-t', '120',
      '-an',
      out,
    ]);
    return out;
  }
  return filePath;
}

async function summarizeWithInception(text: string): Promise<string> {
  const key = process.env.INCEPTION_API_KEY;
  if (!key) return cleanSentence(text);
  const response = await fetch(`${process.env.INCEPTION_BASE_URL || 'https://api.inceptionlabs.ai/v1'}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: process.env.MEMORY_NOTES_SUMMARY_MODEL || 'mercury-2',
      reasoning_effort: 'instant',
      temperature: 0,
      messages: [{ role: 'user', content: `summarize this note into 1 short sentence: ${text.slice(0, 12000)}` }],
    }),
  });
  const json = await response.json().catch(() => null) as any;
  if (!response.ok) throw new Error(`Inception summary failed: ${response.status} ${JSON.stringify(json ?? {})}`);
  return cleanSentence(json?.choices?.[0]?.message?.content || '');
}

async function summarizeMediaWithOpenRouter(filePath: string, kind: ContentKind, mimeType: string): Promise<string> {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) return `${kind} file archived by Telos.`;
  const data = await readFile(filePath);
  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': process.env.OPENROUTER_SITE_URL || 'http://localhost',
      'X-Title': process.env.OPENROUTER_APP_NAME || 'TELOS content memory',
    },
    body: JSON.stringify({
      model: process.env.MEMORY_MEDIA_SUMMARY_MODEL || 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free',
      reasoning: { effort: 'low' },
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: `summarize this ${kind} into 1 short sentence` },
          { type: 'file', file: { filename: path.basename(filePath), file_data: `data:${mimeType};base64,${data.toString('base64')}` } },
        ],
      }],
    }),
  });
  const json = await response.json().catch(() => null) as any;
  if (!response.ok) throw new Error(`OpenRouter media summary failed: ${response.status} ${JSON.stringify(json ?? {})}`);
  return cleanSentence(json?.choices?.[0]?.message?.content || '');
}

async function embedContent(filePath: string, kind: ContentKind, text: string): Promise<{ embedding: number[]; model: string }> {
  const model = kind === 'text' || kind === 'file'
    ? (process.env.MEMORY_CONVERSATION_TEXT_EMBEDDING_MODEL || 'gemini-embedding-001')
    : (process.env.MEMORY_MULTIMODAL_EMBEDDING_MODEL || 'gemini-embedding-001');
  if (kind === 'text' || kind === 'file') {
    return { embedding: await embedText(text, model, undefined, 'query.content_memory', 'google'), model };
  }
  const fallbackText = `${kind} file ${path.basename(filePath)}. ${text}`.trim();
  return { embedding: await embedText(fallbackText, model, undefined, 'query.content_memory_multimodal', 'google'), model };
}

export class ContentMemoryService {
  private db: lancedb.Connection | null = null;
  private rowCache: StoredContentRow[] | null = null;
  private rowLoadPromise: Promise<StoredContentRow[]> | null = null;
  private readonly sentenceCache = new Map<string, Promise<StoredContentSentenceRow[]>>();

  static notesPath(): string {
    return resolveNotesPath();
  }

  private async getDb(): Promise<lancedb.Connection> {
    if (!this.db) {
      await mkdir(DATA_DIR, { recursive: true });
      await mkdir(FILES_DIR, { recursive: true });
      this.db = await lancedb.connect(DATA_DIR);
    }
    return this.db;
  }

  private async getTable(): Promise<lancedb.Table> {
    const db = await this.getDb();
    const names = await db.tableNames();
    if (names.includes(TABLE_NAME)) {
      return db.openTable(TABLE_NAME);
    }
    const table = await db.createTable(TABLE_NAME, [{
      id: '__init__',
      collection: 'notes',
      kind: 'text',
      originalName: '',
      originalPathRel: '',
      archivePath: '',
      mimeType: '',
      summary: '',
      text: '',
      transcriptJson: '[]',
      labelsJson: '[]',
      embeddingJson: '[]',
      embeddingModel: '',
      author: '',
      createdAt: nowIso(),
      updatedAt: nowIso(),
      archivedAt: nowIso(),
      expiresAt: '',
    }]);
    await table.delete("id = '__init__'");
    return table;
  }

  private async getSentenceTable(): Promise<lancedb.Table> {
    const db = await this.getDb();
    const names = await db.tableNames();
    if (names.includes(SENTENCE_TABLE_NAME)) return db.openTable(SENTENCE_TABLE_NAME);
    const table = await db.createTable(SENTENCE_TABLE_NAME, [{
      id: '__init__', contentId: '', collection: 'notes', sentenceIndex: 0, text: '', embeddingJson: '[]',
      embeddingModel: '', sourceUpdatedAt: '', createdAt: nowIso(),
    }]);
    await table.delete("id = '__init__'");
    return table;
  }

  async rows(collection?: ContentCollection): Promise<StoredContentRow[]> {
    if (!this.rowCache) {
      this.rowLoadPromise ??= this.getTable()
        .then((table) => table.query().toArray() as Promise<any[]>)
        .then((rows) => rows.map((row) => row as StoredContentRow))
        .then((rows) => {
          this.rowCache = rows;
          this.rowLoadPromise = null;
          return rows;
        }, (error) => {
          this.rowLoadPromise = null;
          throw error;
        });
      await this.rowLoadPromise;
    }
    return (this.rowCache || []).filter((row) => !collection || row.collection === collection);
  }

  async getRow(id: string): Promise<StoredContentRow | undefined> {
    const normalizedId = String(id || '').trim();
    if (!normalizedId) return undefined;
    return (await this.rows()).find((row) => row.id === normalizedId);
  }

  async getOrCreateSentenceEmbeddings(
    row: StoredContentRow,
    model = process.env.MEMORY_CONVERSATION_TEXT_EMBEDDING_MODEL || 'qwen/qwen3-embedding-8b',
  ): Promise<StoredContentSentenceRow[]> {
    const sourceText = row.text.trim();
    if (!sourceText || row.kind !== 'text' || wordCount(sourceText) <= 30) return [];
    const cacheKey = `${row.id}\u0000${row.updatedAt}\u0000${model}`;
    const cached = this.sentenceCache.get(cacheKey);
    if (cached) return cached;
    const pending = this.loadOrCreateSentenceEmbeddings(row, model).catch((error) => {
      this.sentenceCache.delete(cacheKey);
      throw error;
    });
    this.sentenceCache.set(cacheKey, pending);
    return pending;
  }

  private async loadOrCreateSentenceEmbeddings(
    row: StoredContentRow,
    model: string,
  ): Promise<StoredContentSentenceRow[]> {
    const sourceText = row.text.trim();
    const table = await this.getSentenceTable();
    const escapedContentId = row.id.replace(/'/g, "''");
    const existing = (await table.query().where(`\`contentId\` = '${escapedContentId}'`).toArray() as any[])
      .map((item) => item as StoredContentSentenceRow)
      .filter((item) => item.contentId === row.id && item.sourceUpdatedAt === row.updatedAt && item.embeddingModel === model)
      .sort((a, b) => a.sentenceIndex - b.sentenceIndex);
    if (existing.length > 0) return existing;

    const sentences = splitSentencesDeterministically(sourceText);
    if (sentences.length <= 1) return [];
    const embeddings = await embedBatch(sentences, model, {
      provider: embeddingProviderForModel(model),
      label: `document.${row.collection}.sentences`,
    });
    const fingerprint = createHash('sha256').update(`${row.updatedAt}\n${sourceText}`).digest('hex').slice(0, 16);
    const createdAt = nowIso();
    const records = sentences.map((text, sentenceIndex): StoredContentSentenceRow => ({
      id: `${row.id}:sentence:${fingerprint}:${sentenceIndex}`,
      contentId: row.id,
      collection: row.collection,
      sentenceIndex,
      text,
      embeddingJson: JSON.stringify(embeddings[sentenceIndex] || []),
      embeddingModel: model,
      sourceUpdatedAt: row.updatedAt,
      createdAt,
    })).filter((item) => parseJson<number[]>(item.embeddingJson, []).length > 0);
    if (records.length > 0) {
      await table.mergeInsert('id').whenMatchedUpdateAll().whenNotMatchedInsertAll().execute(
        records as unknown as Record<string, unknown>[],
      );
    }
    return records;
  }

  async upsertText(input: {
    collection: ContentCollection;
    id?: string;
    text: string;
    summary?: string;
    labels?: string[];
    author?: string;
    createdAt?: string;
    updatedAt?: string;
    expiresAt?: string;
    transcript?: unknown;
    embeddingModel?: string;
    embedding?: number[];
  }): Promise<StoredContentRow> {
    const text = String(input.text || '').trim();
    if (!text) throw new Error('content memory text must be non-empty.');
    const id = input.id || `${input.collection}:${randomUUID()}`;
    const model = input.embeddingModel || (input.collection === 'conversation_transcripts'
      ? (process.env.MEMORY_CONVERSATION_TEXT_EMBEDDING_MODEL || 'qwen/qwen3-embedding-8b')
      : input.collection === 'advisor_context'
        ? (process.env.MEMORY_ADVISOR_CONTEXT_EMBEDDING_MODEL || 'gemini-embedding-001')
        : (process.env.MEMORY_MULTIMODAL_EMBEDDING_MODEL || 'gemini-embedding-001'));
    const embedding = input.embedding && input.embedding.length > 0
      ? input.embedding
      : await embedText(text, model, undefined, `document.${input.collection}`, embeddingProviderForModel(model));
    const row: StoredContentRow = {
      id,
      collection: input.collection,
      kind: 'text',
      originalName: `${id}.txt`,
      originalPathRel: '',
      archivePath: '',
      mimeType: 'text/plain',
      summary: input.summary || cleanSentence(text),
      text,
      transcriptJson: JSON.stringify(input.transcript ?? []),
      labelsJson: JSON.stringify(input.labels || []),
      embeddingJson: JSON.stringify(embedding),
      embeddingModel: model,
      author: input.author || '',
      createdAt: input.createdAt || nowIso(),
      updatedAt: input.updatedAt || nowIso(),
      archivedAt: nowIso(),
      expiresAt: input.expiresAt || '',
    };
    await this.replaceRow(row);
    if (wordCount(row.text) > 30) await this.getOrCreateSentenceEmbeddings(row);
    return row;
  }

  async embedFileForSearch(filePath: string, kind?: ContentKind): Promise<{ embedding: number[]; model: string }> {
    const mimeType = String(lookupMime(filePath) || 'application/octet-stream');
    const resolvedKind = kind || inferKind(filePath, mimeType);
    const workDir = path.join(DATA_DIR, 'temp', randomUUID());
    await mkdir(workDir, { recursive: true });
    try {
      const preparedPath = await prepareEmbeddingMedia(filePath, resolvedKind, workDir).catch(() => filePath);
      return embedContent(preparedPath, resolvedKind, `${resolvedKind} file ${path.basename(filePath)}`);
    } finally {
      await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  async archiveNoteFile(filePath: string, vaultPath = resolveNotesPath()): Promise<StoredContentRow> {
    const absolute = path.resolve(filePath);
    const relative = path.relative(vaultPath, absolute);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error(`Note file is outside notes path: ${absolute}`);
    }
    const fileStat = await stat(absolute);
    const mimeType = String(lookupMime(absolute) || 'application/octet-stream');
    const kind = inferKind(absolute, mimeType);
    const id = stableIdFor('notes', relative);
    const archiveDir = path.join(FILES_DIR, id.replace(/[^a-zA-Z0-9_.-]/g, '_'));
    await mkdir(archiveDir, { recursive: true });
    const archivePath = path.join(archiveDir, path.basename(absolute));
    await copyFile(absolute, archivePath);
    await writeFile(path.join(archiveDir, 'metadata.json'), JSON.stringify({
      originalName: path.basename(absolute),
      originalPathRel: relative,
      createdAt: fileStat.birthtime.toISOString(),
      updatedAt: fileStat.mtime.toISOString(),
      archivedAt: nowIso(),
      mimeType,
    }, null, 2) + '\n', 'utf8');

    const workDir = path.join(archiveDir, 'work');
    await mkdir(workDir, { recursive: true });
    const embeddingPath = await prepareEmbeddingMedia(archivePath, kind, workDir).catch(() => archivePath);
    const text = kind === 'text'
      ? await readFile(archivePath, 'utf8').catch(() => '')
      : `${kind} file ${path.basename(absolute)}`;
    const summary = kind === 'text'
      ? await summarizeWithInception(text).catch(() => cleanSentence(text))
      : await summarizeMediaWithOpenRouter(embeddingPath, kind, String(lookupMime(embeddingPath) || mimeType)).catch(() => `${kind} file ${path.basename(absolute)}.`);
    const embedded = await embedContent(embeddingPath, kind, `${summary}\n${text}`);
    const row: StoredContentRow = {
      id,
      collection: 'notes',
      kind,
      originalName: path.basename(absolute),
      originalPathRel: relative,
      archivePath,
      mimeType,
      summary,
      text: kind === 'text' ? text : '',
      transcriptJson: '[]',
      labelsJson: '[]',
      embeddingJson: JSON.stringify(embedded.embedding),
      embeddingModel: embedded.model,
      author: authorFromName(path.basename(absolute)),
      createdAt: fileStat.birthtime.toISOString(),
      updatedAt: fileStat.mtime.toISOString(),
      archivedAt: nowIso(),
      expiresAt: '',
    };
    await this.replaceRow(row);
    if (row.kind === 'text' && wordCount(row.text) > 30) await this.getOrCreateSentenceEmbeddings(row);
    await rm(absolute, { force: true });
    return row;
  }

  async settleNotesVault(options?: { olderThanMs?: number }): Promise<{ archived: number; skipped: number; errors: Array<{ path: string; error: string }> }> {
    const vault = resolveNotesPath();
    const olderThanMs = options?.olderThanMs ?? DAY_MS;
    const files = await this.walkVault(vault);
    let archived = 0;
    let skipped = 0;
    const errors: Array<{ path: string; error: string }> = [];
    for (const file of files) {
      const info = await stat(file);
      if (Date.now() - info.mtimeMs < olderThanMs) {
        skipped += 1;
        continue;
      }
      try {
        await this.archiveNoteFile(file, vault);
        archived += 1;
      } catch (error) {
        errors.push({ path: file, error: error instanceof Error ? error.message : String(error) });
      }
    }
    return { archived, skipped, errors };
  }

  async importNote(noteId: string): Promise<string> {
    const row = (await this.rows('notes')).find((item) => item.id === noteId);
    if (!row) throw new Error(`Archived note not found: ${noteId}`);
    if (!row.archivePath || !(await pathExists(row.archivePath))) {
      throw new Error(`Archived note file is missing for ${noteId}`);
    }
    const target = path.join(resolveNotesPath(), row.originalPathRel || row.originalName);
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(row.archivePath, target);
    return target;
  }

  async search(collection: ContentCollection, query: string, options: ContentSearchOptions = {}): Promise<ContentSearchResult[]> {
    const rows = (await this.rows(collection))
      .filter((row) => !row.expiresAt || new Date(row.expiresAt).getTime() > Date.now())
      .filter((row) => {
        const label = String(options.transcriptLabel || '').trim().toLowerCase();
        if (!label) return true;
        return parseJson<string[]>(row.labelsJson, []).some((item) => item.toLowerCase() === label);
      });
    if (rows.length === 0) return [];

    const recencyBias = Number.isFinite(options.recencyBias) ? Math.max(0, Number(options.recencyBias)) : 0;
    const cleanQuery = String(query || '').trim();
    const queryEmbeddings = new Map<string, number[]>();
    if (cleanQuery) {
      const models = Array.from(new Set(rows.map((row) => row.embeddingModel).filter(Boolean)));
      await Promise.all(models.map(async (model) => {
        queryEmbeddings.set(model, await embedText(
          cleanQuery,
          model,
          undefined,
          `query.${collection}`,
          embeddingProviderForModel(model),
        ));
      }));
    }
    const newest = Math.max(...rows.map((row) => new Date(row.updatedAt || row.createdAt).getTime()).filter(Number.isFinite), Date.now());
    const scored = rows.map((row) => {
      const embedding = parseJson<number[]>(row.embeddingJson, []);
      const queryEmbedding = queryEmbeddings.get(row.embeddingModel) || [];
      const semantic = queryEmbedding.length > 0 ? Math.max(0, cosineSimilarity(queryEmbedding, embedding)) : 0;
      const ageDays = Math.max(0, (newest - new Date(row.updatedAt || row.createdAt).getTime()) / DAY_MS);
      const recency = Math.exp(-ageDays / 30);
      const gate = !cleanQuery ? 1 : semantic >= 0.6 ? 1 : Math.max(0, semantic / 0.6);
      // Recency is intentionally a tie-breaker. A default bias of 0.5 must not
      // let a recent unrelated turn outrank an older strong semantic match.
      const score = semantic + recencyBias * 0.1 * recency * gate;
      return { row, score, semantic };
    }).sort((a, b) => b.score - a.score);

    const count = typeof options.count === 'number' && Number.isFinite(options.count)
      ? Math.max(1, Math.floor(options.count))
      : undefined;
    const selected = count
      ? scored.slice(0, count)
      : this.autoSelect(scored.map((item) => ({ factId: item.row.id, score: item.score })))
        .map((score) => scored.find((item) => item.row.id === score.factId))
        .filter((item): item is typeof scored[number] => !!item);

    return selected.map(({ row, score }) => ({
      id: row.id,
      noteId: row.collection === 'notes' ? row.id : undefined,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      summary: row.summary,
      author: row.author || undefined,
      transcript: row.text || undefined,
      labels: parseJson<string[]>(row.labelsJson, []),
      score,
    }));
  }

  async reembedCollection(
    collection: ContentCollection,
    model: string,
    onProgress?: (completed: number, total: number, row: StoredContentRow) => void,
  ): Promise<ContentReembedResult> {
    const allRows = await this.rows();
    const rows = allRows.filter((row) => row.collection === collection && (row.text.trim() || row.summary.trim()));
    const replacements = new Map<string, StoredContentRow>();
    let reembedded = 0;
    let skipped = 0;
    const provider = embeddingProviderForModel(model);
    if (provider === 'openrouter') {
      const embeddings = await embedBatch(rows.map((row) => row.text.trim() || row.summary.trim()), model, {
        label: `document.${collection}`,
        provider,
      });
      for (let index = 0; index < rows.length; index += 1) {
        const row = rows[index]!;
        const embedding = embeddings[index] || [];
        if (embedding.length > 0) {
          replacements.set(row.id, {
            ...row,
            embeddingJson: JSON.stringify(embedding),
            embeddingModel: model,
          });
          reembedded += 1;
        } else {
          skipped += 1;
        }
        onProgress?.(reembedded + skipped, rows.length, row);
      }
    } else {
      let nextIndex = 0;
      const concurrency = Math.max(1, Math.min(8, Number(process.env.MEMORY_REEMBED_CONCURRENCY || 1) || 1));
      const worker = async (): Promise<void> => {
        while (nextIndex < rows.length) {
          const index = nextIndex;
          nextIndex += 1;
          const row = rows[index]!;
          try {
            const embedding = await embedText(row.text.trim() || row.summary.trim(), model, undefined, `document.${collection}`, provider);
            replacements.set(row.id, {
              ...row,
              embeddingJson: JSON.stringify(embedding),
              embeddingModel: model,
            });
            reembedded += 1;
          } catch (error) {
            skipped += 1;
            console.warn(`[content-memory] Failed to re-embed ${row.id}: ${error instanceof Error ? error.message : String(error)}`);
          }
          onProgress?.(reembedded + skipped, rows.length, row);
        }
      };
      await Promise.all(Array.from({ length: Math.min(concurrency, rows.length) }, () => worker()));
    }
    if (replacements.size > 0) {
      const db = await this.getDb();
      const rewritten = allRows.map((row) => replacements.get(row.id) || row);
      await db.createTable(
        TABLE_NAME,
        rewritten as unknown as Record<string, unknown>[],
        { mode: 'overwrite' },
      );
    }
    this.rowCache = null;
    this.rowLoadPromise = null;
    return { collection, model, reembedded, skipped };
  }

  async deleteExpired(collection: ContentCollection): Promise<number> {
    const rows = await this.rows(collection);
    const expired = rows.filter((row) => row.expiresAt && new Date(row.expiresAt).getTime() <= Date.now());
    for (const row of expired) {
      await this.deleteRow(row.id);
    }
    return expired.length;
  }

  private autoSelect(scores: Array<{ factId: string; score: number }>): Array<{ factId: string; score: number }> {
    if (scores.length === 0) return [];
    if (scores.every((score) => score.score <= 0)) {
      return scores.slice(0, 5);
    }
    const analysis = analyzeAutoCandidateSelection(scores, {
      mode: 'auto',
      topK: 5,
      threshold: 0.35,
      minCandidates: 3,
      maxCandidates: 8,
    });
    return scores.filter((score) => score.score >= analysis.chosenThreshold).slice(0, 8);
  }

  private async replaceRow(row: StoredContentRow): Promise<void> {
    const table = await this.getTable();
    await table
      .mergeInsert('id')
      .whenMatchedUpdateAll()
      .whenNotMatchedInsertAll()
      .execute([row as unknown as Record<string, unknown>]);
    if (this.rowCache) {
      const index = this.rowCache.findIndex((item) => item.id === row.id);
      if (index >= 0) this.rowCache[index] = row;
      else this.rowCache.push(row);
    }
    for (const key of this.sentenceCache.keys()) {
      if (key.startsWith(`${row.id}\u0000`)) this.sentenceCache.delete(key);
    }
  }

  private async deleteRow(id: string): Promise<void> {
    const table = await this.getTable();
    await table.delete(`id = '${id.replace(/'/g, "''")}'`).catch(() => undefined);
    if (this.rowCache) this.rowCache = this.rowCache.filter((row) => row.id !== id);
    for (const key of this.sentenceCache.keys()) {
      if (key.startsWith(`${id}\u0000`)) this.sentenceCache.delete(key);
    }
  }

  private async walkVault(root: string): Promise<string[]> {
    const result: string[] = [];
    async function walk(dir: string): Promise<void> {
      const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        const absolute = path.join(dir, entry.name);
        const relative = path.relative(root, absolute);
        if (isTechnicalPath(relative)) continue;
        if (entry.isDirectory()) {
          await walk(absolute);
        } else if (entry.isFile()) {
          result.push(absolute);
        }
      }
    }
    await walk(root);
    return result;
  }
}

let singleton: ContentMemoryService | null = null;

export function getContentMemoryService(): ContentMemoryService {
  singleton ??= new ContentMemoryService();
  return singleton;
}
