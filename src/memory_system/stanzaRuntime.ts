import { existsSync } from 'fs';
import { mkdir, readFile, writeFile } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import type { MemoryDebugLogger } from './debug.js';
import { summarizeText } from './debug.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const DATA_DIR = path.join(PROJECT_ROOT, 'data', 'memory-v2');
const PYTHON_ENV_DIR = path.join(DATA_DIR, 'python-env');
const MODEL_DIR = path.join(DATA_DIR, 'stanza-models');
const BRIDGE_PATH = path.join(__dirname, 'stanza', 'bridge.py');
const REQUIREMENTS_PATH = path.join(__dirname, 'stanza', 'requirements.txt');
const RUNTIME_STAMP_PATH = path.join(PYTHON_ENV_DIR, '.requirements.stamp');

export interface StanzaDependencyWord {
  id: number;
  text: string;
  lemma: string | null;
  upos: string | null;
  xpos: string | null;
  head: number;
  deprel: string | null;
}

export interface StanzaSentenceAnnotation {
  sentenceIndex: number;
  text: string;
  constituency: string | null;
  dependencies: StanzaDependencyWord[];
}

export interface StanzaTextAnnotation {
  language: 'en' | 'ru';
  parserMode: 'constituency' | 'ud';
  sentences: StanzaSentenceAnnotation[];
}

interface BridgeRequest {
  action: 'analyze_text' | 'warm_pipelines';
  modelDir: string;
  text: string;
  language?: string;
  languages?: string[];
}

interface BridgeError {
  message: string;
}

interface BridgeResponse<T> {
  ok: boolean;
  result?: T;
  error?: BridgeError;
}

let runtimePromise: Promise<string> | null = null;
let bridgeQueue: Promise<void> = Promise.resolve();
let bridgeProcessPromise: Promise<PersistentBridge> | null = null;
let stanzaWarmPromise: Promise<void> | null = null;
const analysisCache = new Map<string, StanzaTextAnnotation>();

interface PersistentBridge {
  python: string;
  process: ReturnType<typeof spawn>;
  stderrBuffer: string;
  stdoutBuffer: string;
  currentRequest: {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
  } | null;
}

function getVenvPythonPath(): string {
  if (process.platform === 'win32') {
    return path.join(PYTHON_ENV_DIR, 'Scripts', 'python.exe');
  }
  return path.join(PYTHON_ENV_DIR, 'bin', 'python');
}

async function readFileIfPresent(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, 'utf8');
  } catch {
    return null;
  }
}

async function runProcess(
  command: string,
  args: string[],
  input?: string,
): Promise<{ stdout: string; stderr: string; exitCode: number | null; startError?: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: PROJECT_ROOT,
      env: {
        ...process.env,
        PYTHONIOENCODING: 'utf-8',
        PYTHONUTF8: '1',
      },
      stdio: 'pipe',
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';
    let startError: string | undefined;

    child.stdout.on('data', chunk => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', chunk => {
      stderr += chunk.toString();
    });
    child.once('error', error => {
      startError = error.message;
    });
    child.once('close', code => {
      resolve({
        stdout,
        stderr,
        exitCode: typeof code === 'number' ? code : null,
        startError,
      });
    });

    if (input) {
      child.stdin.write(input);
    }
    child.stdin.end();
  });
}

async function resolveBasePython(): Promise<{ command: string; argsPrefix: string[] }> {
  for (const candidate of [
    { command: 'python', argsPrefix: [] },
    { command: 'py', argsPrefix: ['-3'] },
  ]) {
    const probe = await runProcess(candidate.command, [...candidate.argsPrefix, '--version']);
    if (!probe.startError && probe.exitCode === 0) {
      return candidate;
    }
  }

  throw new Error('Python 3 is required for Stanza memory support, but no python executable was found.');
}

async function ensurePythonRuntimeInternal(): Promise<string> {
  await mkdir(DATA_DIR, { recursive: true });
  await mkdir(MODEL_DIR, { recursive: true });

  const basePython = await resolveBasePython();
  const venvPython = getVenvPythonPath();

  if (!existsSync(venvPython)) {
    const createEnv = await runProcess(basePython.command, [...basePython.argsPrefix, '-m', 'venv', PYTHON_ENV_DIR]);
    if (createEnv.exitCode !== 0) {
      throw new Error(createEnv.stderr || createEnv.startError || 'Failed to create Stanza virtual environment.');
    }
  }

  const requirementsText = await readFile(REQUIREMENTS_PATH, 'utf8');
  const currentStamp = await readFileIfPresent(RUNTIME_STAMP_PATH);
  if (currentStamp !== requirementsText) {
    const install = await runProcess(
      venvPython,
      ['-m', 'pip', 'install', '--disable-pip-version-check', '-r', REQUIREMENTS_PATH],
    );
    if (install.exitCode !== 0) {
      throw new Error(install.stderr || install.startError || 'Failed to install Stanza runtime requirements.');
    }
    await writeFile(RUNTIME_STAMP_PATH, requirementsText, 'utf8');
  }

  return venvPython;
}

function analysisCacheKey(text: string, language?: string): string {
  return `${(language ?? '').trim().toLowerCase()}::${text}`;
}

function setAnalysisCache(key: string, value: StanzaTextAnnotation): void {
  if (analysisCache.has(key)) {
    analysisCache.delete(key);
  }
  analysisCache.set(key, value);
  if (analysisCache.size > 256) {
    const oldestKey = analysisCache.keys().next().value;
    if (oldestKey) {
      analysisCache.delete(oldestKey);
    }
  }
}

export async function ensureStanzaRuntime(): Promise<string> {
  if (!runtimePromise) {
    runtimePromise = ensurePythonRuntimeInternal().catch(error => {
      runtimePromise = null;
      throw error;
    });
  }
  return runtimePromise;
}

async function startBridgeProcess(): Promise<PersistentBridge> {
  const python = await ensureStanzaRuntime();
  const child = spawn(python, [BRIDGE_PATH, '--stdio-loop'], {
    cwd: PROJECT_ROOT,
    env: {
      ...process.env,
      PYTHONIOENCODING: 'utf-8',
      PYTHONUTF8: '1',
    },
    stdio: 'pipe',
    windowsHide: true,
  });

  const bridge: PersistentBridge = {
    python,
    process: child,
    stderrBuffer: '',
    stdoutBuffer: '',
    currentRequest: null,
  };

  // The bridge is meant to be reused while the current process is alive,
  // but it must not prevent short-lived action processes from exiting.
  child.unref();

  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');

  child.stdout.on('data', (chunk: string | Buffer) => {
    bridge.stdoutBuffer += chunk.toString();
    for (;;) {
      const newlineIndex = bridge.stdoutBuffer.indexOf('\n');
      if (newlineIndex === -1) break;
      const line = bridge.stdoutBuffer.slice(0, newlineIndex).trim();
      bridge.stdoutBuffer = bridge.stdoutBuffer.slice(newlineIndex + 1);
      if (!line) continue;
      const pending = bridge.currentRequest;
      bridge.currentRequest = null;
      if (!pending) continue;
      try {
        pending.resolve(JSON.parse(line));
      } catch (error) {
        pending.reject(new Error(`Stanza bridge returned invalid JSON line: ${error instanceof Error ? error.message : String(error)}`));
      }
    }
  });

  child.stderr.on('data', (chunk: string | Buffer) => {
    bridge.stderrBuffer += chunk.toString();
    if (bridge.stderrBuffer.length > 8000) {
      bridge.stderrBuffer = bridge.stderrBuffer.slice(-8000);
    }
  });

  const resetBridge = (error?: Error) => {
    if (bridge.currentRequest) {
      bridge.currentRequest.reject(error ?? new Error('Stanza bridge process exited unexpectedly.'));
      bridge.currentRequest = null;
    }
    bridgeProcessPromise = null;
  };

  child.once('error', (error) => {
    resetBridge(error instanceof Error ? error : new Error(String(error)));
  });
  child.once('exit', (code, signal) => {
    resetBridge(new Error(`Stanza bridge process exited (code=${code ?? 'null'}, signal=${signal ?? 'null'}). ${bridge.stderrBuffer.trim()}`.trim()));
  });

  return bridge;
}

async function ensureBridgeProcess(debug?: MemoryDebugLogger): Promise<PersistentBridge> {
  if (!bridgeProcessPromise) {
    bridgeProcessPromise = startBridgeProcess().catch((error) => {
      bridgeProcessPromise = null;
      throw error;
    });
  }

  const bridge = await bridgeProcessPromise;
  debug?.('stanza.bridge', 'Resolved persistent Stanza bridge process.', {
    python: bridge.python,
  });
  return bridge;
}

async function runBridgeInternal<T>(request: BridgeRequest, debug?: MemoryDebugLogger): Promise<T> {
  const runtimeStarted = Date.now();
  const python = await ensureStanzaRuntime();
  debug?.('stanza.runtime', 'Resolved Stanza runtime.', {
    durationMs: Date.now() - runtimeStarted,
    python,
    modelDir: request.modelDir,
  });
  const bridge = await ensureBridgeProcess(debug);
  const payload = JSON.stringify(request);
  debug?.('stanza.request', 'Sending text to Stanza bridge.', {
    request: {
      ...request,
      text: summarizeText(request.text, 3000),
    },
  });
  const started = Date.now();
  const parsed = await new Promise<BridgeResponse<T>>((resolve, reject) => {
    if (bridge.currentRequest) {
      reject(new Error('Stanza bridge already has an in-flight request.'));
      return;
    }

    bridge.currentRequest = {
      resolve: (value) => resolve(value as BridgeResponse<T>),
      reject,
    };

    const stdin = bridge.process.stdin;
    if (!stdin) {
      reject(new Error('Stanza bridge stdin is not available.'));
      return;
    }

    stdin.write(`${payload}\n`, 'utf8', (error) => {
      if (!error) return;
      bridge.currentRequest = null;
      reject(error instanceof Error ? error : new Error(String(error)));
    });
  });

  if (!parsed.ok) {
    throw new Error(parsed.error?.message || 'Stanza bridge failed.');
  }

  debug?.('stanza.response', 'Received Stanza bridge response.', {
    durationMs: Date.now() - started,
    stderr: summarizeText(bridge.stderrBuffer, 2000),
    response: parsed.result,
  });
  return parsed.result as T;
}

export async function warmStanzaBridge(debug?: MemoryDebugLogger): Promise<void> {
  if (!stanzaWarmPromise) {
    stanzaWarmPromise = bridgeQueue.then(async () => {
      await runBridgeInternal<{ languages: string[] }>({
        action: 'warm_pipelines',
        modelDir: MODEL_DIR,
        text: '',
        languages: ['en', 'ru'],
      }, debug);
    }).catch((error) => {
      stanzaWarmPromise = null;
      throw error;
    });
    bridgeQueue = stanzaWarmPromise.then(() => undefined, () => undefined);
  }

  await stanzaWarmPromise;
}

export async function analyzeWithStanza(text: string, language?: string, debug?: MemoryDebugLogger): Promise<StanzaTextAnnotation> {
  const cacheKey = analysisCacheKey(text, language);
  const cached = analysisCache.get(cacheKey);
  if (cached) {
    debug?.('stanza.cache_hit', 'Returned cached Stanza analysis.', {
      language,
      text: summarizeText(text, 3000),
    });
    return cached;
  }

  const request: BridgeRequest = {
    action: 'analyze_text',
    modelDir: MODEL_DIR,
    text,
    ...(language ? { language } : {}),
  };

  const pending = bridgeQueue.then(() => runBridgeInternal<StanzaTextAnnotation>(request, debug));
  bridgeQueue = pending.then(() => undefined, () => undefined);
  const result = await pending;
  setAnalysisCache(cacheKey, result);
  return result;
}
