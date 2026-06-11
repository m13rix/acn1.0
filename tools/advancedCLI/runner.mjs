import { spawn } from 'child_process';
import { createWriteStream } from 'fs';
import { mkdir, readFile, rename, writeFile } from 'fs/promises';
import path from 'path';

const INTERNAL_DIR_NAME = '.telos-advanced-cli';
const RUNS_DIR_NAME = 'runs';
const OUTPUT_PREVIEW_LIMIT = 4000;

function nowIso() {
  return new Date().toISOString();
}

function trimPreview(text) {
  if (text.length <= OUTPUT_PREVIEW_LIMIT) {
    return text;
  }
  return text.slice(text.length - OUTPUT_PREVIEW_LIMIT);
}

function normalizeCliCommand(command, platform = process.platform) {
  const lines = String(command || '')
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0 && !line.startsWith('#'));

  if (lines.length === 0) {
    return '';
  }

  let normalized = lines.length > 1
    ? lines.join(platform === 'win32' ? '; ' : ' && ')
    : lines[0];

  if (platform === 'win32') {
    normalized = normalized.replace(/\bmkdir\s+-p\s+/g, 'mkdir ');
  }

  return normalized;
}

function buildPowerShellCommand(command) {
  return `$ErrorActionPreference = 'Stop'; ${command}`;
}

function shouldFallbackToCmd(stderr, startError) {
  const text = `${startError || ''}\n${stderr || ''}`.toLowerCase();
  if (!text.trim()) return false;

  const fallbackSignals = [
    'commandnotfoundexception',
    'is not recognized as the name of a cmdlet',
    'parsererror',
    'unexpected token',
    'missing terminator',
    'failed to start process',
  ];

  return fallbackSignals.some(signal => text.includes(signal));
}

function getRunPath(sandboxRoot, id) {
  return path.join(sandboxRoot, INTERNAL_DIR_NAME, RUNS_DIR_NAME, `${id}.json`);
}

async function readJsonFile(filePath) {
  const raw = await readFile(filePath, 'utf-8');
  return JSON.parse(raw);
}

async function writeJsonAtomic(filePath, value) {
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(tempPath, JSON.stringify(value, null, 2), 'utf-8');
  await rename(tempPath, filePath);
}

async function loadRecord(sandboxRoot, id) {
  return readJsonFile(getRunPath(sandboxRoot, id));
}

async function updateRecord(sandboxRoot, id, updater) {
  const current = await loadRecord(sandboxRoot, id);
  const next = updater({ ...current });
  next.updatedAt = nowIso();
  await writeJsonAtomic(getRunPath(sandboxRoot, id), next);
  return next;
}

function shellPlan(command) {
  if (process.platform === 'win32') {
    return {
      command: 'powershell',
      args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', buildPowerShellCommand(command)],
      shell: false,
      fallback: {
        command: 'cmd.exe',
        args: ['/d', '/s', '/c', command],
        shell: false,
      },
    };
  }

  return {
    command,
    args: [],
    shell: true,
  };
}

function spawnCommand(plan, cwd, envOverrides, onChunk, onStartError) {
  return new Promise((resolve) => {
    const stdout = [];
    const stderr = [];
    let startError;

    const child = spawn(plan.command, plan.args, {
      cwd,
      shell: plan.shell,
      env: {
        ...process.env,
        ...(envOverrides || {}),
      },
      windowsHide: true,
      detached: process.platform !== 'win32',
    });

    onStartError?.(child.pid || null);

    child.stdout?.on('data', (chunk) => {
      const text = chunk.toString();
      stdout.push(text);
      onChunk(text);
    });

    child.stderr?.on('data', (chunk) => {
      const text = chunk.toString();
      stderr.push(text);
      onChunk(text);
    });

    child.once('error', (error) => {
      startError = `Failed to start process: ${error.message}`;
      onChunk(`${startError}\n`);
    });

    child.once('close', (code, signal) => {
      resolve({
        success: code === 0 && !startError,
        stdout: stdout.join(''),
        stderr: stderr.join(''),
        exitCode: typeof code === 'number' ? code : null,
        signal: signal || null,
        startError,
      });
    });
  });
}

async function runBackgroundProcess(sandboxRoot, id) {
  const record = await loadRecord(sandboxRoot, id);
  const normalizedCommand = normalizeCliCommand(record.command, process.platform);
  const plan = shellPlan(normalizedCommand);
  const writer = createWriteStream(record.logFile, { flags: 'a' });
  const envOverrides = record.envOverrides && typeof record.envOverrides === 'object'
    ? record.envOverrides
    : undefined;
  let combined = '';

  const appendChunk = async (chunk) => {
    combined += chunk;
    writer.write(chunk);
    await updateRecord(sandboxRoot, id, (current) => ({
      ...current,
      outputPreview: trimPreview(combined),
    }));
  };

  try {
    await updateRecord(sandboxRoot, id, (current) => ({
      ...current,
      status: 'running',
    }));

    let result = await spawnCommand(
      plan,
      sandboxRoot,
      envOverrides,
      (chunk) => {
        void appendChunk(chunk);
      },
      (pid) => {
        void updateRecord(sandboxRoot, id, (current) => ({
          ...current,
          pid,
          status: pid ? 'running' : current.status,
        }));
      }
    );

    if (!result.success && plan.fallback && shouldFallbackToCmd(result.stderr, result.startError)) {
      await appendChunk('[advancedCLI] PowerShell failed; retrying via cmd.exe.\n');
      result = await spawnCommand(
        plan.fallback,
        sandboxRoot,
        envOverrides,
        (chunk) => {
          void appendChunk(chunk);
        },
        (pid) => {
          void updateRecord(sandboxRoot, id, (current) => ({
            ...current,
            pid,
            status: pid ? 'running' : current.status,
          }));
        }
      );
    }

    const finalStatus = result.signal
      ? 'terminated'
      : (result.success ? 'completed' : 'failed');

    await updateRecord(sandboxRoot, id, (current) => ({
      ...current,
      status: finalStatus,
      exitCode: result.exitCode,
      completedAt: nowIso(),
      startError: result.startError,
      outputPreview: trimPreview(combined),
    }));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await appendChunk(`${message}\n`);
    await updateRecord(sandboxRoot, id, (current) => ({
      ...current,
      status: 'failed',
      exitCode: current.exitCode,
      completedAt: nowIso(),
      startError: message,
      outputPreview: trimPreview(combined),
    }));
  } finally {
    await new Promise((resolve) => writer.end(resolve));
  }
}

const sandboxRoot = process.argv[2];
const id = process.argv[3];

if (!sandboxRoot || !id) {
  throw new Error('Usage: node runner.mjs <sandboxRoot> <runId>');
}

await runBackgroundProcess(path.resolve(sandboxRoot), id);
