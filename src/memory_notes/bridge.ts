import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import type { KeepAuthProfile } from './auth-store.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const DATA_DIR = path.join(PROJECT_ROOT, 'data', 'memory-notes');
const PYTHON_ENV_DIR = path.join(DATA_DIR, 'python-env');
const BRIDGE_PATH = path.join(__dirname, 'bridge.py');
const REQUIREMENTS_PATH = path.join(__dirname, 'requirements.txt');
const RUNTIME_STAMP_PATH = path.join(PYTHON_ENV_DIR, '.requirements.stamp');

export interface BridgeProfileInput {
  email: string;
  masterToken: string;
  deviceId: string;
  statePath?: string;
}

interface BridgeRequest {
  action: string;
  profile?: BridgeProfileInput;
  input?: Record<string, unknown>;
}

interface BridgeResponse<T> {
  ok: boolean;
  result?: T;
  error?: {
    code?: string;
    message: string;
    details?: unknown;
  };
}

let runtimePromise: Promise<string> | null = null;
let bridgeQueue: Promise<void> = Promise.resolve();

function getVenvPythonPath(): string {
  if (process.platform === 'win32') {
    return path.join(PYTHON_ENV_DIR, 'Scripts', 'python.exe');
  }
  return path.join(PYTHON_ENV_DIR, 'bin', 'python');
}

function normalizeMultiline(text: string): string {
  return text.replace(/\r\n/g, '\n').trim();
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
  return new Promise((resolve, reject) => {
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
    try {
      await runProcess(candidate.command, [...candidate.argsPrefix, '--version']);
      return candidate;
    } catch {
      // Try next candidate.
    }
  }

  throw new Error('Python 3 is required for Google Keep support, but no python executable was found.');
}

async function ensurePythonRuntimeInternal(): Promise<string> {
  await mkdir(DATA_DIR, { recursive: true });
  const basePython = await resolveBasePython();
  const venvPython = getVenvPythonPath();

  if (!existsSync(venvPython)) {
    await runProcess(basePython.command, [...basePython.argsPrefix, '-m', 'venv', PYTHON_ENV_DIR]);
  }

  const requirementsText = await readFile(REQUIREMENTS_PATH, 'utf8');
  const currentStamp = await readFileIfPresent(RUNTIME_STAMP_PATH);
  if (currentStamp !== requirementsText) {
    await runProcess(venvPython, ['-m', 'pip', 'install', '--disable-pip-version-check', '-r', REQUIREMENTS_PATH]);
    await writeFile(RUNTIME_STAMP_PATH, requirementsText, 'utf8');
  }

  return venvPython;
}

export async function ensurePythonRuntime(): Promise<string> {
  if (!runtimePromise) {
    runtimePromise = ensurePythonRuntimeInternal().catch(error => {
      runtimePromise = null;
      throw error;
    });
  }
  return runtimePromise;
}

async function runBridgeInternal<T>(request: BridgeRequest): Promise<T> {
  const python = await ensurePythonRuntime();
  const payload = JSON.stringify(request);
  const { stdout, stderr, exitCode, startError } = await runProcess(python, [BRIDGE_PATH], payload);

  let parsed: BridgeResponse<T>;
  try {
    parsed = JSON.parse(stdout) as BridgeResponse<T>;
  } catch {
    const details = [normalizeMultiline(stdout), normalizeMultiline(stderr), startError].filter(Boolean).join('\n');
    if (exitCode !== 0) {
      throw new Error(details || `Google Keep bridge exited with code ${exitCode}.`);
    }
    throw new Error(`Google Keep bridge returned invalid JSON: ${normalizeMultiline(stdout)}`);
  }

  if (!parsed.ok) {
    throw new Error(parsed.error?.message || 'Google Keep bridge failed.');
  }

  if (exitCode !== 0) {
    throw new Error(normalizeMultiline(stderr) || startError || `Google Keep bridge exited with code ${exitCode}.`);
  }

  return parsed.result as T;
}

export async function runBridge<T>(request: BridgeRequest): Promise<T> {
  const pending = bridgeQueue.then(() => runBridgeInternal<T>(request));
  bridgeQueue = pending.then(() => undefined, () => undefined);
  return pending;
}

export function bridgeProfileFromAuth(profile: KeepAuthProfile, statePath?: string): BridgeProfileInput {
  return {
    email: profile.email,
    masterToken: profile.masterToken,
    deviceId: profile.deviceId,
    statePath,
  };
}
