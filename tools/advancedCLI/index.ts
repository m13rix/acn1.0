import { spawn } from 'child_process';
import { randomUUID } from 'crypto';
import { createWriteStream, existsSync } from 'fs';
import { mkdir, readFile, rename, stat, truncate, writeFile } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { buildPowerShellCommand, normalizeCliCommand, shouldFallbackToCmd } from '../../src/sandbox/windows-shell.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const RUNNER_PATH = path.join(__dirname, 'runner.mjs');
const INTERNAL_DIR_NAME = '.telos-advanced-cli';
const RUNS_DIR_NAME = 'runs';
const LOGS_DIR_NAME = 'logs';
const DEFAULT_WAIT_POLL_MS = 500;
const OUTPUT_PREVIEW_LIMIT = 4000;

type RunStatus = 'starting' | 'running' | 'completed' | 'failed' | 'terminated';

interface EvalOptions {
    waitForCompletion?: boolean;
    logFile?: string;
    env?: Record<string, string>;
}

interface ProcessRecord {
    id: string;
    command: string;
    cwd: string;
    pid: number | null;
    status: RunStatus;
    exitCode: number | null;
    startedAt: string;
    updatedAt: string;
    completedAt?: string;
    logFile: string;
    requestedLogFile?: string;
    envOverrides?: Record<string, string>;
    outputPreview: string;
    startError?: string;
}

interface EvalResult {
    success: boolean;
    command: string;
    status: RunStatus;
    id?: string;
    pid?: number | null;
    exitCode?: number | null;
    output: string;
    logFile?: string;
}

interface SpawnResult {
    success: boolean;
    stdout: string;
    stderr: string;
    exitCode: number | null;
    startError?: string;
}

function normalizeEnvOverrides(env: unknown): Record<string, string> | undefined {
    if (!env || typeof env !== 'object' || Array.isArray(env)) {
        return undefined;
    }

    const normalizedEntries = Object.entries(env as Record<string, unknown>)
        .filter(([key]) => typeof key === 'string' && key.trim().length > 0)
        .map(([key, value]) => [key.trim(), String(value ?? '')] as const);

    if (normalizedEntries.length === 0) {
        return undefined;
    }

    return Object.fromEntries(normalizedEntries);
}

function getSandboxRoot(): string {
    return path.resolve(process.env.SANDBOX_DIR || process.cwd());
}

function nowIso(): string {
    return new Date().toISOString();
}

function getInternalRoot(): string {
    return path.join(getSandboxRoot(), INTERNAL_DIR_NAME);
}

function getRunsDir(): string {
    return path.join(getInternalRoot(), RUNS_DIR_NAME);
}

function getLogsDir(): string {
    return path.join(getInternalRoot(), LOGS_DIR_NAME);
}

function getRunPath(id: string): string {
    return path.join(getRunsDir(), `${id}.json`);
}

function trimPreview(text: string): string {
    if (text.length <= OUTPUT_PREVIEW_LIMIT) {
        return text;
    }
    return text.slice(text.length - OUTPUT_PREVIEW_LIMIT);
}

async function ensureStorage(): Promise<void> {
    await mkdir(getRunsDir(), { recursive: true });
    await mkdir(getLogsDir(), { recursive: true });
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
    const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(tempPath, JSON.stringify(value, null, 2), 'utf-8');
    await rename(tempPath, filePath);
}

async function readJsonFile<T>(filePath: string): Promise<T> {
    const raw = await readFile(filePath, 'utf-8');
    return JSON.parse(raw) as T;
}

async function loadRecord(id: string): Promise<ProcessRecord> {
    try {
        return await readJsonFile<ProcessRecord>(getRunPath(id));
    } catch (error) {
        const err = error as NodeJS.ErrnoException;
        if (err.code === 'ENOENT') {
            throw new Error(`advancedCLI process "${id}" was not found`);
        }
        throw error;
    }
}

function resolveLogPath(id: string, requestedPath?: string): { absolutePath: string; displayPath: string; requested?: string } {
    const sandboxRoot = getSandboxRoot();
    const trimmed = typeof requestedPath === 'string' ? requestedPath.trim() : '';

    if (!trimmed) {
        const absolutePath = path.join(getLogsDir(), `${id}.log`);
        return {
            absolutePath,
            displayPath: path.relative(sandboxRoot, absolutePath).replace(/\\/g, '/'),
        };
    }

    const wantsAbsolute = path.isAbsolute(trimmed);
    const absolutePath = wantsAbsolute
        ? path.resolve(trimmed)
        : path.resolve(sandboxRoot, trimmed);

    if (!wantsAbsolute) {
        const relativeToSandbox = path.relative(sandboxRoot, absolutePath);
        if (relativeToSandbox.startsWith('..') || path.isAbsolute(relativeToSandbox)) {
            throw new Error(`Relative logFile "${requestedPath}" resolves outside the sandbox`);
        }
    }

    return {
        absolutePath,
        displayPath: wantsAbsolute
            ? absolutePath
            : path.relative(sandboxRoot, absolutePath).replace(/\\/g, '/'),
        requested: trimmed,
    };
}

async function initializeLogFile(absolutePath: string): Promise<void> {
    await mkdir(path.dirname(absolutePath), { recursive: true });
    if (existsSync(absolutePath)) {
        await truncate(absolutePath, 0);
        return;
    }
    await writeFile(absolutePath, '', 'utf-8');
}

function normalizeCommand(command: string): string {
    const normalized = normalizeCliCommand(command, process.platform);
    if (!normalized) {
        return '';
    }
    return normalized;
}

function shellPlan(command: string): {
    command: string;
    args: string[];
    shell: boolean;
    fallback?: { command: string; args: string[]; shell: boolean };
} {
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

function spawnCommandOnce(
    plan: { command: string; args: string[]; shell: boolean },
    cwd: string,
    envOverrides?: Record<string, string>,
    onChunk?: (chunk: string) => void
): Promise<SpawnResult> {
    return new Promise((resolve) => {
        const stdout: string[] = [];
        const stderr: string[] = [];
        let startError: string | undefined;

        const child = spawn(plan.command, plan.args, {
            cwd,
            shell: plan.shell,
            env: {
                ...process.env,
                ...(envOverrides || {}),
            },
            windowsHide: true,
        });

        child.stdout?.on('data', (chunk) => {
            const text = chunk.toString();
            stdout.push(text);
            onChunk?.(text);
        });

        child.stderr?.on('data', (chunk) => {
            const text = chunk.toString();
            stderr.push(text);
            onChunk?.(text);
        });

        child.once('error', (error) => {
            startError = `Failed to start process: ${error.message}`;
        });

        child.once('close', (code) => {
            resolve({
                success: code === 0 && !startError,
                stdout: stdout.join(''),
                stderr: stderr.join(''),
                exitCode: typeof code === 'number' ? code : null,
                startError,
            });
        });
    });
}

async function runCommand(
    command: string,
    cwd: string,
    logPath?: string,
    envOverrides?: Record<string, string>
): Promise<SpawnResult & { output: string }> {
    const plan = shellPlan(command);
    const writer = logPath ? createWriteStream(logPath, { flags: 'a' }) : null;
    let combined = '';

    const appendChunk = (chunk: string) => {
        combined += chunk;
        writer?.write(chunk);
    };

    try {
        let result = await spawnCommandOnce(plan, cwd, envOverrides, appendChunk);

        if (!result.success && plan.fallback && shouldFallbackToCmd(result.stderr, result.startError)) {
            const fallbackNotice = '[advancedCLI] PowerShell failed; retrying via cmd.exe.\n';
            appendChunk(fallbackNotice);
            result = await spawnCommandOnce(plan.fallback, cwd, envOverrides, appendChunk);
        }

        if (result.startError) {
            appendChunk(`${result.startError}\n`);
        }

        return {
            ...result,
            output: combined.trim() || (result.success ? '(no output)' : ''),
        };
    } finally {
        await new Promise<void>((resolve) => {
            if (!writer) {
                resolve();
                return;
            }
            writer.end(() => resolve());
        });
    }
}

async function writeInitialRecord(record: ProcessRecord): Promise<void> {
    await writeJsonAtomic(getRunPath(record.id), record);
}

function toPublicRecord(record: ProcessRecord) {
    return {
        id: record.id,
        command: record.command,
        cwd: record.cwd,
        pid: record.pid,
        status: record.status,
        exitCode: record.exitCode,
        startedAt: record.startedAt,
        updatedAt: record.updatedAt,
        completedAt: record.completedAt,
        logFile: record.logFile,
        outputPreview: record.outputPreview,
        startError: record.startError,
    };
}

async function readLogText(absolutePath: string): Promise<string> {
    try {
        return await readFile(absolutePath, 'utf-8');
    } catch (error) {
        const err = error as NodeJS.ErrnoException;
        if (err.code === 'ENOENT') {
            return '';
        }
        throw error;
    }
}

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function killProcessTree(pid: number): Promise<void> {
    if (!Number.isInteger(pid) || pid <= 0) {
        throw new Error(`Invalid pid: ${pid}`);
    }

    if (process.platform === 'win32') {
        await new Promise<void>((resolve, reject) => {
            const child = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], {
                shell: false,
                windowsHide: true,
            });

            let stderr = '';
            child.stderr?.on('data', chunk => {
                stderr += chunk.toString();
            });

            child.once('error', reject);
            child.once('close', code => {
                if (code === 0) {
                    resolve();
                    return;
                }
                reject(new Error(stderr.trim() || `taskkill exited with code ${code}`));
            });
        });
        return;
    }

    try {
        process.kill(-pid, 'SIGTERM');
    } catch {
        process.kill(pid, 'SIGTERM');
    }
}

export async function evalCommand(command: string, options: EvalOptions = {}): Promise<EvalResult> {
    await ensureStorage();

    const normalizedCommand = normalizeCommand(command);
    if (!normalizedCommand) {
        return {
            success: true,
            command: '',
            status: 'completed',
            output: '(empty command)',
        };
    }

    const waitForCompletion = options.waitForCompletion ?? true;
    const envOverrides = normalizeEnvOverrides(options.env);

    if (waitForCompletion) {
        const log = options.logFile ? resolveLogPath(randomUUID(), options.logFile) : null;
        if (log) {
            await initializeLogFile(log.absolutePath);
        }

        const result = await runCommand(normalizedCommand, getSandboxRoot(), log?.absolutePath, envOverrides);
        return {
            success: result.success,
            command: normalizedCommand,
            status: result.success ? 'completed' : 'failed',
            exitCode: result.exitCode,
            output: result.output,
            logFile: log?.displayPath,
        };
    }

    const id = randomUUID();
    const log = resolveLogPath(id, options.logFile);
    await initializeLogFile(log.absolutePath);

    const timestamp = nowIso();
    const record: ProcessRecord = {
        id,
        command: normalizedCommand,
        cwd: getSandboxRoot(),
        pid: null,
        status: 'starting',
        exitCode: null,
        startedAt: timestamp,
        updatedAt: timestamp,
        logFile: log.absolutePath,
        requestedLogFile: log.requested,
        envOverrides,
        outputPreview: '',
    };

    await writeInitialRecord(record);

    const child = spawn(process.execPath, [RUNNER_PATH, getSandboxRoot(), id], {
        cwd: getSandboxRoot(),
        detached: true,
        env: process.env,
        stdio: 'ignore',
        windowsHide: true,
    });
    child.unref();

    return {
        success: true,
        command: normalizedCommand,
        status: 'running',
        id,
        output: '',
        logFile: log.displayPath,
    };
}

export { evalCommand as eval };

export async function status(id: string) {
    const record = await loadRecord(id);
    const logStats = await stat(record.logFile).catch(() => null);

    return {
        ...toPublicRecord(record),
        completed: record.status !== 'starting' && record.status !== 'running',
        logSize: logStats?.size ?? 0,
    };
}

export async function readLog(id: string): Promise<string> {
    const record = await loadRecord(id);
    return readLogText(record.logFile);
}

export async function wait(id: string, pollMs: number = DEFAULT_WAIT_POLL_MS) {
    const interval = Number.isFinite(pollMs) ? Math.max(50, Math.floor(pollMs)) : DEFAULT_WAIT_POLL_MS;

    for (;;) {
        const current = await status(id);
        if (current.completed) {
            const output = await readLog(id);
            return {
                ...current,
                output,
            };
        }
        await sleep(interval);
    }
}

export async function terminate(id: string) {
    const record = await loadRecord(id);

    if (record.status !== 'starting' && record.status !== 'running') {
        return {
            ...toPublicRecord(record),
            completed: true,
            terminated: record.status === 'terminated',
        };
    }

    if (!record.pid) {
        throw new Error(`advancedCLI process "${id}" has not published a child pid yet`);
    }

    await killProcessTree(record.pid);

    for (let attempt = 0; attempt < 20; attempt += 1) {
        const current = await loadRecord(id);
        if (current.status !== 'starting' && current.status !== 'running') {
            return {
                ...toPublicRecord(current),
                completed: true,
                terminated: current.status === 'terminated',
            };
        }
        await sleep(250);
    }

    const latest = await loadRecord(id);
    return {
        ...toPublicRecord(latest),
        completed: latest.status !== 'starting' && latest.status !== 'running',
        terminated: latest.status === 'terminated',
    };
}
