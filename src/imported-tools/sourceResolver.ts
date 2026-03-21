import { execFile } from 'child_process';
import { promisify } from 'util';
import { copyFile, mkdtemp, readFile, readdir } from 'fs/promises';
import { basename, extname, join, resolve } from 'path';
import type { ImportedRuntimeSpec, ImportedSource } from '../types/index.js';
import { IMPORTED_TOOLS_STAGING_DIR } from './constants.js';
import {
  ensureDir,
  fileExists,
  isPlainObject,
  pathIsDirectory,
  readJson,
  removeDir,
  resolveWithin,
  sha256,
} from './utils.js';

const execFileAsync = promisify(execFile);

export interface ResolvedSource {
  sourceRoot: string;
  cleanup: () => Promise<void>;
  readme?: string;
  packageJson?: Record<string, unknown>;
  runtime: ImportedRuntimeSpec;
}

function cmdExeCommand(): string {
  return process.env.ComSpec || process.env.COMSPEC || 'cmd.exe';
}

function npmCommand(): string {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

function gitCommand(): string {
  return process.platform === 'win32' ? 'git.exe' : 'git';
}

function quoteWindowsArg(value: string): string {
  if (!value) return '""';
  if (!/[\s"&|<>^()]/.test(value)) return value;
  return `"${value.replace(/"/g, '""')}"`;
}

function normalizeSpawnCommand(command: string, args: string[] = []): { command: string; args: string[] } {
  if (process.platform !== 'win32') {
    return { command, args };
  }
  const extension = extname(command).toLowerCase();
  if (!['.cmd', '.bat'].includes(extension)) {
    return { command, args };
  }
  const commandLine = [quoteWindowsArg(command), ...args.map(quoteWindowsArg)].join(' ');
  return {
    command: cmdExeCommand(),
    args: ['/d', '/s', '/c', commandLine],
  };
}

async function runCommand(command: string, args: string[], cwd?: string): Promise<void> {
  const normalized = normalizeSpawnCommand(command, args);
  await execFileAsync(normalized.command, normalized.args, { cwd });
}

async function installNpmDependencies(targetDir: string, installArg?: string): Promise<string[]> {
  const args = installArg ? ['install', installArg] : ['install'];
  const normalized = normalizeSpawnCommand(npmCommand(), args);
  await execFileAsync(normalized.command, normalized.args, { cwd: targetDir });
  return [normalized.command, ...normalized.args];
}

async function tryReadReadme(sourceRoot: string): Promise<string | undefined> {
  for (const name of ['README.md', 'README.MD', 'readme.md']) {
    const path = join(sourceRoot, name);
    if (await fileExists(path)) {
      return (await import('fs/promises')).readFile(path, 'utf8');
    }
  }
  return undefined;
}

async function detectPackageRuntime(sourceRoot: string, source: ImportedSource): Promise<ImportedRuntimeSpec> {
  const packageJson = await readJson<Record<string, unknown>>(join(sourceRoot, 'package.json'));
  let command = source.command;
  let args = [...(source.args || [])];
  let cwd = source.cwd;

  const resolveBinPath = (binValue: string): string => resolve(sourceRoot, binValue);
  const resolveBinRuntime = async (binPath: string): Promise<Pick<ImportedRuntimeSpec, 'command' | 'args'>> => {
    const extension = extname(binPath).toLowerCase();
    if (extension === '.ts') {
      return {
        ...normalizeSpawnCommand(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['tsx', binPath]),
      };
    }
    if (['.js', '.cjs', '.mjs'].includes(extension)) {
      return {
        command: process.execPath,
        args: [binPath],
      };
    }
    if (await fileExists(binPath)) {
      const firstLine = (await readFile(binPath, 'utf8'))
        .split(/\r?\n/, 1)[0]
        ?.trim()
        .toLowerCase();
      if (firstLine?.startsWith('#!') && firstLine.includes('node')) {
        return {
          command: process.execPath,
          args: [binPath],
        };
      }
    }
    return {
      command: binPath,
      args: [],
    };
  };
  const packageName = typeof packageJson.name === 'string' ? packageJson.name : source.value;
  const unscopedPackageName = packageName.startsWith('@')
    ? packageName.split('/')[1] || packageName
    : packageName;
  const packageRefName = source.value.startsWith('@')
    ? (source.value.lastIndexOf('@') > 0 ? source.value.slice(0, source.value.lastIndexOf('@')) : source.value)
    : source.value.split('@')[0]!;

  if (!command) {
    if (isPlainObject(packageJson.bin)) {
      const binEntries = Object.entries(packageJson.bin).map(([name, value]) => ({
        name,
        path: String(value),
      }));
      const selectedBin = binEntries.length === 1
        ? binEntries[0]
        : binEntries.find((entry) => entry.name === packageName)
          || binEntries.find((entry) => entry.name === unscopedPackageName)
          || binEntries.find((entry) => entry.name === packageRefName)
          || binEntries.find((entry) => entry.name.includes('mcp'))
          || binEntries[0];
      if (selectedBin) {
        const binPath = resolveBinPath(selectedBin.path);
        const runtime = await resolveBinRuntime(binPath);
        command = runtime.command;
        args = [...runtime.args, ...args];
      }
    } else if (typeof packageJson.bin === 'string') {
      const binPath = resolveBinPath(packageJson.bin);
      const runtime = await resolveBinRuntime(binPath);
      command = runtime.command;
      args = [...runtime.args, ...args];
    }
  }

  if (!command) {
    throw new Error('Could not detect a runnable command. Provide command/args explicitly.');
  }

  const normalized = normalizeSpawnCommand(command, args);

  return {
    command: normalized.command,
    args: normalized.args,
    cwd,
    env: source.env,
    runtimeDir: sourceRoot,
    sourceDigest: sha256(JSON.stringify({ source, command: normalized.command, args: normalized.args, cwd })),
    installCommand: [],
  };
}

export async function resolveImportedSource(source: ImportedSource): Promise<ResolvedSource> {
  await ensureDir(IMPORTED_TOOLS_STAGING_DIR);
  const stagingRoot = await mkdtemp(join(IMPORTED_TOOLS_STAGING_DIR, `${sha256(JSON.stringify(source)).slice(0, 8)}-`));

  let sourceRoot = stagingRoot;
  let cleanupNeeded = true;

  if (source.type === 'localPath') {
    const resolved = resolve(source.value);
    if (!await pathIsDirectory(resolved)) {
      throw new Error(`Local path "${source.value}" does not exist or is not a directory.`);
    }
    sourceRoot = resolved;
    cleanupNeeded = false;
  } else if (source.type === 'git' || source.type === 'clawhubSlug') {
    const targetDir = join(stagingRoot, 'repo');
    await ensureDir(targetDir);
    const repo = source.type === 'clawhubSlug' && !source.value.startsWith('http')
      ? `https://github.com/${source.value.replace(/^\/+/, '').replace(/\/+$/, '')}.git`
      : source.value;
    await runCommand(gitCommand(), ['clone', '--depth', '1', repo, targetDir]);
    sourceRoot = source.subpath ? resolveWithin(targetDir, source.subpath) : targetDir;
  } else if (source.type === 'package') {
    if (source.command) {
      const runtime = {
        ...normalizeSpawnCommand(source.command, [...(source.args || [])]),
        cwd: source.cwd,
        env: source.env,
        runtimeDir: stagingRoot,
        sourceDigest: sha256(JSON.stringify({
          source,
          command: source.command,
          args: source.args || [],
          cwd: source.cwd,
        })),
        installCommand: [],
      };
      return {
        sourceRoot: stagingRoot,
        cleanup: async () => { await removeDir(stagingRoot); },
        runtime,
      };
    }

    const projectDir = join(stagingRoot, 'package');
    await ensureDir(projectDir);
    await runCommand(npmCommand(), ['init', '-y'], projectDir);
    const installCommand = await installNpmDependencies(projectDir, source.value);
    const atIndex = source.value.lastIndexOf('@');
    const packageName = source.value.startsWith('@')
      ? (atIndex > 0 ? source.value.slice(0, atIndex) : source.value)
      : source.value.split('@')[0]!;
    sourceRoot = resolve(projectDir, 'node_modules', packageName);
    if (!await pathIsDirectory(sourceRoot)) {
      throw new Error(`Installed package "${packageName}" could not be found.`);
    }
    const runtime = await detectPackageRuntime(sourceRoot, source);
    runtime.runtimeDir = projectDir;
    runtime.installCommand = installCommand;
    return {
      sourceRoot,
      cleanup: async () => { await removeDir(stagingRoot); },
      readme: await tryReadReadme(sourceRoot),
      packageJson: await readJson<Record<string, unknown>>(join(sourceRoot, 'package.json')),
      runtime,
    };
  }

  const packageJsonPath = join(sourceRoot, 'package.json');
  const packageJson = await fileExists(packageJsonPath)
    ? await readJson<Record<string, unknown>>(packageJsonPath)
    : undefined;

  const runtime = packageJson
    ? await detectPackageRuntime(sourceRoot, source)
    : {
      ...normalizeSpawnCommand(source.command || '', [...(source.args || [])]),
      cwd: source.cwd,
      env: source.env,
      runtimeDir: sourceRoot,
      sourceDigest: sha256(JSON.stringify({ source })),
      installCommand: [],
    };

  if (!runtime.command) {
    throw new Error('A runnable command is required for non-package sources.');
  }

  if (packageJson && source.type !== 'localPath') {
    runtime.installCommand = await installNpmDependencies(sourceRoot);
  }

  return {
    sourceRoot,
    cleanup: cleanupNeeded ? async () => { await removeDir(stagingRoot); } : async () => {},
    readme: await tryReadReadme(sourceRoot),
    packageJson,
    runtime,
  };
}

export async function copySourceSnapshot(sourceRoot: string, targetDir: string): Promise<void> {
  await ensureDir(targetDir);
  const entries = await readdir(sourceRoot, { withFileTypes: true });
  for (const entry of entries) {
    const sourcePath = join(sourceRoot, entry.name);
    const targetPath = join(targetDir, entry.name);
    if (entry.isDirectory()) {
      await copySourceSnapshot(sourcePath, targetPath);
    } else if (entry.isFile()) {
      await ensureDir(join(targetPath, '..'));
      await copyFile(sourcePath, targetPath);
    }
  }
}

export function inferDisplayName(source: ImportedSource): string {
  return source.displayName || basename(source.value).replace(/\.git$/i, '') || source.value;
}
