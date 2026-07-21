import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const PYTHON = path.join(PROJECT_ROOT, 'data', 'memory-v2', 'python-env', 'Scripts', 'python.exe');
const MODEL_DIR = path.join(PROJECT_ROOT, 'data', 'memory-v2', 'qwen3-embedding-8b');
const BRIDGE = path.join(__dirname, 'local_qwen_bridge.py');
const REQUIRED_SHARD = path.join(MODEL_DIR, 'model-00004-of-00004.safetensors');
const PORT = Math.max(1024, Math.floor(Number(process.env.MEMORY_LOCAL_QWEN_PORT || 39489) || 39489));
const BASE_URL = `http://127.0.0.1:${PORT}`;
const MIN_FREE_VRAM_MIB = Math.max(1, Math.floor(Number(process.env.MEMORY_LOCAL_QWEN_MIN_FREE_VRAM_MIB || 18_000) || 18_000));
const LOCAL_FAILURE_COOLDOWN_MS = Math.max(1_000, Math.floor(Number(process.env.MEMORY_LOCAL_QWEN_FAILURE_COOLDOWN_MS || 60_000) || 60_000));
const execFileAsync = promisify(execFile);

let bootPromise: Promise<void> | null = null;
let unavailableUntil = 0;
let unavailableReason = '';

function markUnavailable(reason: string): Error {
  unavailableUntil = Date.now() + LOCAL_FAILURE_COOLDOWN_MS;
  unavailableReason = reason;
  return new Error(`Local Qwen embedding is unavailable (${reason}); retrying locally after ${Math.ceil(LOCAL_FAILURE_COOLDOWN_MS / 1000)}s.`);
}

async function ensureEnoughFreeVram(): Promise<void> {
  if (Date.now() < unavailableUntil) {
    throw new Error(`Local Qwen embedding is temporarily disabled: ${unavailableReason}`);
  }
  try {
    const { stdout } = await execFileAsync('nvidia-smi', ['--query-gpu=memory.free', '--format=csv,noheader,nounits'], {
      windowsHide: true,
      timeout: 2_000,
    });
    const freeMib = Math.max(...stdout.split(/\s+/u).map(Number).filter(Number.isFinite));
    if (Number.isFinite(freeMib) && freeMib < MIN_FREE_VRAM_MIB) {
      throw markUnavailable(`${freeMib} MiB free VRAM; ${MIN_FREE_VRAM_MIB} MiB required`);
    }
  } catch (error) {
    // nvidia-smi being absent should not disable an otherwise usable local runtime.
    if (error instanceof Error && error.message.includes('MiB free VRAM')) throw error;
  }
}

async function isReady(): Promise<boolean> {
  try {
    const response = await fetch(`${BASE_URL}/health`, { signal: AbortSignal.timeout(800) });
    return response.ok && Boolean((await response.json() as { ready?: boolean }).ready);
  } catch {
    return false;
  }
}

async function ensureServer(): Promise<void> {
  if (await isReady()) return;
  await ensureEnoughFreeVram();
  if (!bootPromise) {
    bootPromise = (async () => {
      const child = spawn(PYTHON, [BRIDGE, '--http', String(PORT), MODEL_DIR], {
        cwd: PROJECT_ROOT,
        windowsHide: true,
        detached: true,
        stdio: 'ignore',
        env: {
          ...process.env,
          PYTHONIOENCODING: 'utf-8',
          PYTHONUTF8: '1',
          HF_HUB_OFFLINE: '1',
          OMP_NUM_THREADS: '1',
          MKL_NUM_THREADS: '1',
          TOKENIZERS_PARALLELISM: 'false',
        },
      });
      child.unref();
      let exitDescription = '';
      child.once('exit', (code, signal) => {
        exitDescription = `local embedding process exited${code === null ? '' : ` with code ${code}`}${signal ? ` (${signal})` : ''}`;
      });
      const deadline = Date.now() + 90_000;
      while (Date.now() < deadline) {
        if (await isReady()) return;
        if (exitDescription) throw markUnavailable(exitDescription);
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      throw markUnavailable('timed out while starting the shared local Qwen embedding service');
    })().finally(() => { bootPromise = null; });
  }
  return bootPromise;
}

export function localQwenEmbeddingAvailable(): boolean {
  return process.env.MEMORY_LOCAL_QWEN_EMBEDDINGS !== 'false'
    && existsSync(PYTHON)
    && existsSync(REQUIRED_SHARD);
}

export async function embedLocalQwen(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  if (!localQwenEmbeddingAvailable()) throw new Error('Local Qwen3 embedding runtime is unavailable.');
  await ensureServer();
  const response = await fetch(`${BASE_URL}/embed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ texts }),
    signal: AbortSignal.timeout(120_000),
  });
  const payload = await response.json() as { vectors?: number[][]; error?: string };
  if (!response.ok || !Array.isArray(payload.vectors)) {
    const reason = payload.error || `Local Qwen embedding service returned HTTP ${response.status}.`;
    if (/cuda.*out of memory|outofmemory|cublas.*alloc/i.test(reason)) {
      throw markUnavailable(reason);
    }
    throw new Error(reason);
  }
  return payload.vectors;
}
