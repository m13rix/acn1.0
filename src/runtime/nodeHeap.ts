import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

const DEFAULT_MAIN_OLD_SPACE_MB = 8192;
const MAIN_HEAP_REEXEC_ENV = 'TELOS_MAIN_HEAP_REEXEC';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..', '..');
const requireFromProjectRoot = createRequire(join(PROJECT_ROOT, 'package.json'));
const TSX_LOADER_IMPORT = pathToFileURL(requireFromProjectRoot.resolve('tsx')).href;

export function parseOldSpaceMb(raw: string | undefined, fallback = DEFAULT_MAIN_OLD_SPACE_MB): number {
  if (!raw || !raw.trim()) {
    return fallback;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.floor(parsed);
}

export function resolveMainOldSpaceMb(env: NodeJS.ProcessEnv = process.env): number {
  return parseOldSpaceMb(
    env.TELOS_MAIN_OLD_SPACE_MB
      || env.TELOS_NODE_MAX_OLD_SPACE_MB
      || env.TELOS_ACTION_WORKER_OLD_SPACE_MB,
    DEFAULT_MAIN_OLD_SPACE_MB
  );
}

export function hasOldSpaceArg(args: readonly string[] = []): boolean {
  return args.some(arg => /^--max-old-space-size(?:=|$)/.test(arg));
}

export function buildHeapExecArgv(scriptPath: string, scriptArgs: readonly string[], oldSpaceMb: number): string[] {
  return [
    `--max-old-space-size=${oldSpaceMb}`,
    '--import',
    TSX_LOADER_IMPORT,
    scriptPath,
    ...scriptArgs,
  ];
}

export function ensureMainProcessHeapLimit(scriptUrl: string, scriptArgs = process.argv.slice(2)): void {
  if (process.env[MAIN_HEAP_REEXEC_ENV] === '1') {
    return;
  }
  if (hasOldSpaceArg(process.execArgv) || hasOldSpaceArg((process.env.NODE_OPTIONS || '').split(/\s+/))) {
    return;
  }

  const oldSpaceMb = resolveMainOldSpaceMb();
  const scriptPath = fileURLToPath(scriptUrl);
  const result = spawnSync(process.execPath, buildHeapExecArgv(scriptPath, scriptArgs, oldSpaceMb), {
    cwd: process.cwd(),
    env: {
      ...process.env,
      [MAIN_HEAP_REEXEC_ENV]: '1',
      TELOS_MAIN_OLD_SPACE_MB: String(oldSpaceMb),
    },
    stdio: 'inherit',
    windowsHide: false,
  });

  if (result.error) {
    console.warn(`[NodeHeap] Failed to relaunch with --max-old-space-size=${oldSpaceMb}: ${result.error.message}`);
    return;
  }

  if (result.signal) {
    process.exit(result.signal === 'SIGINT' ? 130 : 1);
  }
  process.exit(result.status ?? 0);
}
