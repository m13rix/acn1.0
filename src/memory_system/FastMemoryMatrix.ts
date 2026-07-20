import { createInterface } from 'node:readline';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastSearchQuery } from './FastMemoryIndex.js';
import type { PhraseAggregationMode } from './types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const PYTHON = path.join(PROJECT_ROOT, 'data', 'memory-v2', 'python-env', 'Scripts', 'python.exe');
const BRIDGE = path.join(__dirname, 'fast_score_bridge.py');

interface MatrixManifest {
  version: number;
  namespace: string;
  dimensions: number;
  factIds: string[];
  factCategories: string[];
  factCount: number;
  sourceCounts: { facts: number; hints: number; links: number };
}

interface PendingRequest {
  resolve: (scores: number[]) => void;
  reject: (error: Error) => void;
}

export interface MatrixSourceCounts {
  facts: number;
  hints: number;
  links: number;
}

export class FastMemoryMatrix {
  private readonly root: string;
  private manifest: MatrixManifest | null = null;
  private process: ChildProcessWithoutNullStreams | null = null;
  private readyPromise: Promise<void> | null = null;
  private requestId = 0;
  private readonly pending = new Map<number, PendingRequest>();

  constructor(namespace: string) {
    this.root = path.join(PROJECT_ROOT, 'data', 'memory', `${namespace}_fast_matrix_v1`);
  }

  private async loadManifest(): Promise<MatrixManifest | null> {
    if (this.manifest) return this.manifest;
    try {
      this.manifest = JSON.parse(await readFile(path.join(this.root, 'manifest.json'), 'utf8')) as MatrixManifest;
      return this.manifest;
    } catch {
      return null;
    }
  }

  private async ensureProcess(): Promise<void> {
    if (this.process && this.readyPromise) return this.readyPromise;
    const manifest = await this.loadManifest();
    if (!manifest) throw new Error('Fast memory matrix manifest is unavailable.');
    const child = spawn(PYTHON, [BRIDGE, this.root], {
      cwd: PROJECT_ROOT,
      windowsHide: true,
      stdio: 'pipe',
      env: {
        ...process.env,
        PYTHONIOENCODING: 'utf-8',
        PYTHONUTF8: '1',
        OPENBLAS_NUM_THREADS: process.env.MEMORY_FAST_MATRIX_THREADS || '12',
      },
    });
    this.process = child;
    child.unref();
    let readyResolve!: () => void;
    let readyReject!: (error: Error) => void;
    this.readyPromise = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
    const lines = createInterface({ input: child.stdout });
    let ready = false;
    lines.on('line', (line) => {
      try {
        const message = JSON.parse(line) as { ready?: boolean; id?: number; scores?: number[]; error?: string };
        if (!ready && message.ready) {
          ready = true;
          readyResolve();
          return;
        }
        if (typeof message.id !== 'number') return;
        const request = this.pending.get(message.id);
        if (!request) return;
        this.pending.delete(message.id);
        if (message.error) request.reject(new Error(message.error));
        else request.resolve(message.scores || []);
      } catch {
        // Ignore non-protocol output; stderr retains Python diagnostics.
      }
    });
    const fail = (error: Error) => {
      if (!ready) readyReject(error);
      for (const request of this.pending.values()) request.reject(error);
      this.pending.clear();
      this.process = null;
      this.readyPromise = null;
    };
    child.once('error', fail);
    child.once('exit', (code) => fail(new Error(`Fast memory matrix process exited with code ${code ?? 'unknown'}.`)));
    return this.readyPromise;
  }

  async scoreRaw(
    query: FastSearchQuery,
    aggregation: PhraseAggregationMode,
    overallEmbeddingWeight: number,
    sourceCounts: MatrixSourceCounts,
  ): Promise<{ factIds: string[]; categories: string[]; scores: number[] } | null> {
    const manifest = await this.loadManifest();
    if (!manifest
      || manifest.sourceCounts.facts !== sourceCounts.facts
      || manifest.sourceCounts.hints !== sourceCounts.hints
      || manifest.sourceCounts.links !== sourceCounts.links) return null;
    await this.ensureProcess();
    const id = ++this.requestId;
    const response = new Promise<number[]>((resolve, reject) => this.pending.set(id, { resolve, reject }));
    this.process!.stdin.write(`${JSON.stringify({
      id,
      globalEmbedding: query.globalEmbedding,
      phrases: query.phrases,
      aggregation,
      overallEmbeddingWeight,
    })}\n`);
    const scores = await response;
    if (scores.length !== manifest.factCount) throw new Error(`Fast matrix returned ${scores.length}/${manifest.factCount} scores.`);
    return { factIds: manifest.factIds, categories: manifest.factCategories, scores };
  }
}
