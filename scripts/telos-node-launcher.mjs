#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { config } from 'dotenv';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..');
const [entrypoint, ...scriptArgs] = process.argv.slice(2);

if (!entrypoint) {
  console.error('[telos] Missing TypeScript entrypoint.');
  process.exit(1);
}

const requireFromProjectRoot = createRequire(join(projectRoot, 'package.json'));
const tsxImport = pathToFileURL(requireFromProjectRoot.resolve('tsx')).href;

config({ path: join(projectRoot, '.env') });

function parseOldSpaceMb(raw, fallback = 8192) {
  if (!raw || !String(raw).trim()) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

const oldSpaceMb = parseOldSpaceMb(
  process.env.TELOS_MAIN_OLD_SPACE_MB
    || process.env.TELOS_NODE_MAX_OLD_SPACE_MB
    || process.env.TELOS_ACTION_WORKER_OLD_SPACE_MB
);

const child = spawn(process.execPath, [
  `--max-old-space-size=${oldSpaceMb}`,
  '--import',
  tsxImport,
  resolve(projectRoot, entrypoint),
  ...scriptArgs,
], {
  cwd: projectRoot,
  env: {
    ...process.env,
    TELOS_MAIN_HEAP_REEXEC: '1',
    TELOS_MAIN_OLD_SPACE_MB: String(oldSpaceMb),
  },
  stdio: 'inherit',
  windowsHide: false,
});

child.on('error', (error) => {
  console.error(`[telos] Failed to launch ${entrypoint}: ${error.message}`);
  process.exitCode = 1;
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.exit(signal === 'SIGINT' ? 130 : 1);
  }
  process.exit(code ?? 0);
});
