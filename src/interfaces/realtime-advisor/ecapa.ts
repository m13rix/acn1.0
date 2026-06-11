import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { createInterface } from 'readline';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { mkdir, readFile, writeFile } from 'fs/promises';
import { existsSync } from 'fs';

export const ECAPA_MODEL_ID = 'speechbrain/spkrec-ecapa-voxceleb';

export interface EcapaEmbeddingSettings {
  pythonPath: string;
  modelCache: string;
  sampleRate: number;
  batchSize: number;
  chunkSeconds: number;
  overlapSeconds: number;
  fp16: boolean;
  device: string;
}

export interface EcapaEmbeddingResult {
  path: string;
  embedding: number[];
  durationSec: number;
  chunks: number;
  model: string;
}

interface PendingRequest {
  resolve: (value: Record<string, unknown>) => void;
  reject: (error: Error) => void;
}

const DEFAULT_TIMEOUT_MS = 180_000;

function moduleDir(): string {
  return dirname(fileURLToPath(import.meta.url));
}

function sidecarPath(): string {
  const local = resolve(moduleDir(), 'ecapa-sidecar.py');
  if (existsSync(local)) {
    return local;
  }
  return resolve(process.cwd(), 'src', 'interfaces', 'realtime-advisor', 'ecapa-sidecar.py');
}

function cosine(a: number[], b: number[]): number {
  const length = Math.min(a.length, b.length);
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let index = 0; index < length; index += 1) {
    const left = Number(a[index]) || 0;
    const right = Number(b[index]) || 0;
    dot += left * right;
    normA += left * left;
    normB += right * right;
  }
  if (normA <= 0 || normB <= 0) {
    return 0;
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function normalizeEmbedding(raw: unknown): number[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const values = raw.map((value) => Number(value)).filter(Number.isFinite);
  const norm = Math.sqrt(values.reduce((sum, value) => sum + value * value, 0));
  if (norm <= 0) {
    return values;
  }
  return values.map((value) => value / norm);
}

export function compareEcapaEmbeddings(a: number[], b: number[]): number {
  return cosine(a, b);
}

export async function readEcapaEmbeddingFile(filePath: string | undefined): Promise<number[] | null> {
  if (!filePath || !existsSync(filePath)) {
    return null;
  }
  const parsed = JSON.parse(await readFile(filePath, 'utf8')) as { embedding?: unknown };
  const embedding = normalizeEmbedding(parsed.embedding);
  return embedding.length > 0 ? embedding : null;
}

export async function writeEcapaEmbeddingFile(
  filePath: string,
  result: EcapaEmbeddingResult,
  sourcePath = result.path,
): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify({
    source: sourcePath,
    model: result.model || ECAPA_MODEL_ID,
    durationSec: result.durationSec,
    chunks: result.chunks,
    dim: result.embedding.length,
    createdAt: new Date().toISOString(),
    embedding: normalizeEmbedding(result.embedding),
  }), 'utf8');
}

export class EcapaEmbeddingService {
  private child: ChildProcessWithoutNullStreams | null = null;
  private initPromise: Promise<void> | null = null;
  private nextRequestId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private available = true;

  constructor(private readonly settings: EcapaEmbeddingSettings) {}

  isAvailable(): boolean {
    return this.available;
  }

  warmup(): Promise<void> {
    return this.ensureReady();
  }

  async stop(): Promise<void> {
    if (!this.child) {
      return;
    }
    await this.send('shutdown', {}).catch(() => undefined);
    this.child.kill();
    this.child = null;
    this.initPromise = null;
    this.pending.clear();
  }

  async embedFiles(paths: string[]): Promise<EcapaEmbeddingResult[]> {
    if (paths.length === 0) {
      return [];
    }
    await this.ensureReady();
    const response = await this.send('embed', { paths });
    const results = Array.isArray(response['results']) ? response['results'] : [];
    return results.map((result) => {
      const item = result as Record<string, unknown>;
      return {
        path: String(item['path'] || ''),
        embedding: normalizeEmbedding(item['embedding']),
        durationSec: Number(item['durationSec']) || 0,
        chunks: Number(item['chunks']) || 0,
        model: String(item['model'] || ECAPA_MODEL_ID),
      };
    }).filter((result) => result.path && result.embedding.length > 0);
  }

  private async ensureReady(): Promise<void> {
    if (this.initPromise) {
      return this.initPromise;
    }
    this.initPromise = this.startAndInitialize().catch((error) => {
      this.available = false;
      this.initPromise = null;
      throw error;
    });
    return this.initPromise;
  }

  private async startAndInitialize(): Promise<void> {
    if (!this.child) {
      const child = spawn(this.settings.pythonPath, [sidecarPath()], {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
      this.child = child;

      const lines = createInterface({ input: child.stdout });
      lines.on('line', (line) => this.handleLine(line));
      child.stderr.on('data', (chunk: Buffer) => {
        const text = chunk.toString().trim();
        if (text) {
          console.warn(`[realtime-advisor] ECAPA sidecar: ${text}`);
        }
      });
      child.on('exit', () => {
        this.child = null;
        this.initPromise = null;
        for (const pending of this.pending.values()) {
          pending.reject(new Error('ECAPA sidecar exited before completing the request.'));
        }
        this.pending.clear();
      });
    }

    await this.send('init', { settings: {
      model_cache: this.settings.modelCache,
      sample_rate: this.settings.sampleRate,
      batch_size: this.settings.batchSize,
      chunk_seconds: this.settings.chunkSeconds,
      overlap_seconds: this.settings.overlapSeconds,
      fp16: this.settings.fp16,
      device: this.settings.device,
    } });
    this.available = true;
  }

  private send(command: string, payload: Record<string, unknown>, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<Record<string, unknown>> {
    if (!this.child || !this.child.stdin.writable) {
      return Promise.reject(new Error('ECAPA sidecar is not running.'));
    }
    const id = this.nextRequestId;
    this.nextRequestId += 1;

    return new Promise((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rejectPromise(new Error(`ECAPA ${command} request timed out.`));
      }, timeoutMs);

      this.pending.set(id, {
        resolve: (response) => {
          clearTimeout(timer);
          resolvePromise(response);
        },
        reject: (error) => {
          clearTimeout(timer);
          rejectPromise(error);
        },
      });

      this.child!.stdin.write(`${JSON.stringify({ ...payload, id, command })}\n`, (error) => {
        if (error) {
          clearTimeout(timer);
          this.pending.delete(id);
          rejectPromise(error);
        }
      });
    });
  }

  private handleLine(line: string): void {
    let response: Record<string, unknown>;
    try {
      response = JSON.parse(line) as Record<string, unknown>;
    } catch {
      console.warn(`[realtime-advisor] ECAPA sidecar emitted non-JSON output: ${line}`);
      return;
    }

    const id = Number(response['id']);
    const pending = this.pending.get(id);
    if (!pending) {
      return;
    }
    this.pending.delete(id);

    if (response['ok'] === false) {
      pending.reject(new Error(`${String(response['error'] || 'ECAPA sidecar request failed.')} (python: ${this.settings.pythonPath})`));
      return;
    }
    pending.resolve(response);
  }
}
