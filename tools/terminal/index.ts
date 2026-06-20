/**
 * Terminal system package.
 *
 * Automatically injected into every LocalSandbox action as `terminal`.
 */

import { spawn } from 'child_process';
import { createRequire } from 'module';
import * as path from 'path';

type RunOptions = {
    timeoutMs?: number;
    cwd?: string;
    allowExternal?: boolean;
    env?: Record<string, string | undefined>;
};

type StartOptions = {
    cwd?: string;
    allowExternal?: boolean;
    env?: Record<string, string | undefined>;
    cols?: number;
    rows?: number;
};

type ReadOptions = {
    tail?: number;
};

type TerminalSession = {
    name: string;
    command: string;
    startedAt: string;
    output: string[];
    pty: {
        write(data: string): void;
        kill(signal?: string): void;
        resize?(cols: number, rows: number): void;
        onData(callback: (data: string) => void): void;
        onExit(callback: (event: { exitCode: number; signal?: number }) => void): void;
        pid?: number;
    };
    exitCode?: number;
    signal?: number;
};

const MAX_BUFFER_CHARS = 200_000;
const sessions = new Map<string, TerminalSession>();
const requireFromHere = createRequire(import.meta.url);

function sandboxRoot(): string {
    return path.resolve(process.env.SANDBOX_DIR || process.cwd());
}

function isInsidePath(root: string, target: string): boolean {
    const relative = path.relative(path.resolve(root), path.resolve(target));
    return !relative.startsWith('..') && !path.isAbsolute(relative);
}

function resolveCwd(inputPath?: string, allowExternal = false): string {
    if (!inputPath) {
        return sandboxRoot();
    }
    const root = sandboxRoot();
    const target = path.isAbsolute(inputPath)
        ? path.resolve(inputPath)
        : path.resolve(root, inputPath);
    if (!allowExternal && !isInsidePath(root, target)) {
        throw new Error(`Security Error: cwd resolves outside sandbox: ${inputPath}. Pass { allowExternal: true } to intentionally run from a directory outside the project.`);
    }
    return target;
}

function commandForShell(command: string): { file: string; args: string[] } {
    if (process.platform === 'win32') {
        return {
            file: 'powershell.exe',
            args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command],
        };
    }
    return {
        file: process.env.SHELL || '/bin/sh',
        args: ['-lc', command],
    };
}

function appendOutput(session: TerminalSession, chunk: string): void {
    session.output.push(chunk);
    let total = session.output.reduce((sum, part) => sum + part.length, 0);
    while (total > MAX_BUFFER_CHARS && session.output.length > 1) {
        const removed = session.output.shift() || '';
        total -= removed.length;
    }
}

function requireNodePty(): any {
    try {
        return requireFromHere('node-pty');
    } catch (error: any) {
        throw new Error(`terminal.start requires node-pty, but it could not be loaded: ${error?.message || String(error)}`);
    }
}

function assertPersistentRuntime(): void {
    if (!(globalThis as any).__TELOS_ACTION_WORKER_RUNTIME__) {
        throw new Error('terminal.start requires the persistent LocalSandbox action worker. Enable it by leaving TELOS_SANDBOX_PERSISTENT_ACTION_WORKER unset or not false.');
    }
}

export async function run(command: string, options: RunOptions = {}): Promise<{
    success: boolean;
    code: number | null;
    output: string;
    stdout: string;
    stderr: string;
    timedOut: boolean;
}> {
    if (typeof command !== 'string' || command.trim().length === 0) {
        throw new Error('terminal.run(command): command must be a non-empty string');
    }

    const timeoutMs = options.timeoutMs === undefined ? 60_000 : Math.max(1, Math.floor(options.timeoutMs));
    const shellCommand = commandForShell(command);
    const cwd = resolveCwd(options.cwd, options.allowExternal === true);
    const env = { ...process.env, ...(options.env || {}) } as NodeJS.ProcessEnv;

    return new Promise((resolve) => {
        const stdout: string[] = [];
        const stderr: string[] = [];
        let timedOut = false;
        let settled = false;
        const child = spawn(shellCommand.file, shellCommand.args, {
            cwd,
            env,
            shell: false,
            windowsHide: true,
        });

        const timer = setTimeout(() => {
            timedOut = true;
            child.kill('SIGTERM');
            setTimeout(() => {
                if (!settled) child.kill('SIGKILL');
            }, 1000).unref();
        }, timeoutMs);
        timer.unref();

        child.stdout?.on('data', (data) => stdout.push(data.toString()));
        child.stderr?.on('data', (data) => stderr.push(data.toString()));
        child.on('error', (error) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve({
                success: false,
                code: null,
                output: '',
                stdout: '',
                stderr: `Failed to start command: ${error.message}`,
                timedOut,
            });
        });
        child.on('close', (code) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            const out = stdout.join('').trim();
            const err = stderr.join('').trim();
            resolve({
                success: code === 0 && !timedOut,
                code,
                output: [out, err].filter(Boolean).join('\n') || '(no output)',
                stdout: out,
                stderr: err,
                timedOut,
            });
        });
    });
}

export async function start(name: string, command: string, options: StartOptions = {}): Promise<string> {
    assertPersistentRuntime();
    if (typeof name !== 'string' || !/^[A-Za-z0-9_.-]+$/.test(name)) {
        throw new Error('terminal.start(name, command): name must contain only letters, numbers, dots, underscores, or hyphens');
    }
    if (sessions.has(name)) {
        throw new Error(`terminal session "${name}" already exists`);
    }
    if (typeof command !== 'string' || command.trim().length === 0) {
        throw new Error('terminal.start(name, command): command must be a non-empty string');
    }

    const pty = requireNodePty();
    const shellCommand = commandForShell(command);
    const term = pty.spawn(shellCommand.file, shellCommand.args, {
        name: process.platform === 'win32' ? 'xterm-256color' : 'xterm-color',
        cols: Math.max(20, Math.floor(options.cols ?? 120)),
        rows: Math.max(5, Math.floor(options.rows ?? 30)),
        cwd: resolveCwd(options.cwd, options.allowExternal === true),
        env: { ...process.env, ...(options.env || {}) },
    });

    const session: TerminalSession = {
        name,
        command,
        startedAt: new Date().toISOString(),
        output: [],
        pty: term,
    };
    sessions.set(name, session);

    term.onData((data: string) => appendOutput(session, data));
    term.onExit((event: { exitCode: number; signal?: number }) => {
        session.exitCode = event.exitCode;
        session.signal = event.signal;
        appendOutput(session, `\n[terminal exited with code ${event.exitCode}${event.signal ? ` signal ${event.signal}` : ''}]\n`);
    });

    return `Started terminal "${name}" (pid ${term.pid ?? 'unknown'}).`;
}

export async function read(name: string, options: ReadOptions = {}): Promise<string> {
    const session = sessions.get(name);
    if (!session) {
        throw new Error(`terminal session "${name}" does not exist`);
    }
    const output = session.output.join('');
    const tail = options.tail === undefined ? undefined : Math.max(1, Math.floor(options.tail));
    if (!tail) {
        return output || '(no output yet)';
    }
    const lines = output.split(/\r?\n/);
    return lines.slice(-tail).join('\n') || '(no output yet)';
}

export async function send(name: string, text: string): Promise<string> {
    const session = sessions.get(name);
    if (!session) {
        throw new Error(`terminal session "${name}" does not exist`);
    }
    session.pty.write(String(text));
    return `Sent input to terminal "${name}".`;
}

export async function stop(name: string): Promise<string> {
    const session = sessions.get(name);
    if (!session) {
        throw new Error(`terminal session "${name}" does not exist`);
    }
    sessions.delete(name);
    session.pty.kill();
    return `Stopped terminal "${name}".`;
}

export async function list(): Promise<Array<{
    name: string;
    command: string;
    startedAt: string;
    running: boolean;
    pid?: number;
    exitCode?: number;
}>> {
    return Array.from(sessions.values()).map((session) => ({
        name: session.name,
        command: session.command,
        startedAt: session.startedAt,
        running: session.exitCode === undefined,
        pid: session.pty.pid,
        exitCode: session.exitCode,
    }));
}

export async function stopAll(): Promise<void> {
    for (const name of Array.from(sessions.keys())) {
        await stop(name).catch(() => undefined);
    }
}

process.once('exit', () => {
    for (const session of sessions.values()) {
        try {
            session.pty.kill();
        } catch {
            // Best effort shutdown.
        }
    }
});

export default {
    run,
    start,
    read,
    send,
    stop,
    list,
    stopAll,
};
