import { spawn, type ChildProcess } from 'child_process';
import { existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import type { LoadedTool } from '../types/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..', '..');
const SERVER_PATH = join(PROJECT_ROOT, 'tools', 'mod', 'texture-server.ts');
const PORT = Number.parseInt(process.env.MINECRAFT_TEXTURE_API_PORT || '3018', 10);
const HEALTH_URL = `http://127.0.0.1:${PORT}/health`;

let processRef: ChildProcess | null = null;
let refCount = 0;
let externallyManaged = false;

function hasModTool(tools: LoadedTool[]): boolean {
  return tools.some(tool => tool.config.name === 'mod');
}

async function isServerAlreadyRunning(): Promise<boolean> {
  try {
    const response = await fetch(HEALTH_URL, { signal: AbortSignal.timeout(400) });
    return response.ok;
  } catch {
    return false;
  }
}

export async function startModTextureServerIfNeeded(tools: LoadedTool[]): Promise<void> {
  if (!hasModTool(tools)) {
    return;
  }

  refCount++;

  if (processRef || externallyManaged) {
    return;
  }

  if (await isServerAlreadyRunning()) {
    externallyManaged = true;
    return;
  }

  if (!existsSync(SERVER_PATH)) {
    console.warn(`[mod-texture-server] Server file not found: ${SERVER_PATH}`);
    return;
  }

  processRef = spawn(process.execPath, ['--import', 'tsx', SERVER_PATH], {
    cwd: PROJECT_ROOT,
    env: {
      ...process.env,
      MINECRAFT_TEXTURE_API_PORT: String(PORT),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  processRef.stdout?.on('data', chunk => {
    process.stdout.write(chunk);
  });

  processRef.stderr?.on('data', chunk => {
    process.stderr.write(chunk);
  });

  processRef.on('exit', () => {
    processRef = null;
  });
}

export async function stopModTextureServerIfNeeded(tools: LoadedTool[]): Promise<void> {
  if (!hasModTool(tools) || refCount <= 0) {
    return;
  }

  refCount--;
  if (refCount > 0) {
    return;
  }

  if (externallyManaged) {
    externallyManaged = false;
    return;
  }

  const child = processRef;
  processRef = null;
  if (!child || child.killed) {
    return;
  }

  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      resolve();
    }, 1500);

    child.once('exit', () => {
      clearTimeout(timeout);
      resolve();
    });

    child.kill();
  });
}
