import { createRequire } from 'module';

type RunMessage = {
    type: 'run';
    id: string;
    filePath: string;
    env: Record<string, string | undefined>;
};

class WorkerProcessExit extends Error {
    __telosWorkerProcessExit = true;
    code: number;

    constructor(code = 0) {
        super('__TELOS_WORKER_PROCESS_EXIT__');
        this.code = code;
    }
}

const requireFromWorker = createRequire(import.meta.url);
const baseGlobalKeys = new Set(Reflect.ownKeys(globalThis));
const originalExit = process.exit.bind(process);

(globalThis as any).__TELOS_ACTION_WORKER_RUNTIME__ = true;

function send(message: Record<string, unknown>): void {
    if (typeof process.send === 'function') {
        process.send(message);
    }
}

function restoreEnv(previous: NodeJS.ProcessEnv): void {
    for (const key of Object.keys(process.env)) {
        if (!(key in previous)) {
            delete process.env[key];
        }
    }
    for (const [key, value] of Object.entries(previous)) {
        process.env[key] = value;
    }
}

function restoreGlobalAdditions(): void {
    for (const key of Reflect.ownKeys(globalThis)) {
        if (baseGlobalKeys.has(key) || key === '__TELOS_ACTION_WORKER_RUNTIME__') {
            continue;
        }
        try {
            delete (globalThis as any)[key as any];
        } catch {
            // Non-configurable globals are rare; leaving them is safer than failing the worker.
        }
    }
}

function chunkToString(chunk: unknown, encoding: unknown): string {
    if (!Buffer.isBuffer(chunk)) {
        return String(chunk);
    }
    return chunk.toString(typeof encoding === 'string' ? encoding as BufferEncoding : undefined);
}

async function runAction(message: RunMessage): Promise<void> {
    const previousEnv = { ...process.env };
    const previousExit = process.exit;
    const previousStdoutWrite = process.stdout.write;
    const previousStderrWrite = process.stderr.write;
    let stdout = '';
    let stderr = '';

    process.stdout.write = ((chunk: any, encoding?: any, callback?: any) => {
        stdout += chunkToString(chunk, encoding);
        if (typeof encoding === 'function') {
            encoding();
        }
        if (typeof callback === 'function') {
            callback();
        }
        return true;
    }) as typeof process.stdout.write;

    process.stderr.write = ((chunk: any, encoding?: any, callback?: any) => {
        const text = chunkToString(chunk, encoding);
        stderr += text;
        send({ type: 'stderr', id: message.id, data: text });
        if (typeof encoding === 'function') {
            encoding();
        }
        if (typeof callback === 'function') {
            callback();
        }
        return true;
    }) as typeof process.stderr.write;

    process.exit = ((code?: string | number | null | undefined) => {
        const numericCode = typeof code === 'number' ? code : Number(code || 0);
        throw new WorkerProcessExit(Number.isFinite(numericCode) ? numericCode : 0);
    }) as typeof process.exit;

    try {
        restoreEnv(message.env as NodeJS.ProcessEnv);
        process.exitCode = 0;

        const resolved = requireFromWorker.resolve(message.filePath);
        delete requireFromWorker.cache[resolved];
        const exported = requireFromWorker(resolved);
        if (exported && typeof exported.then === 'function') {
            await exported;
        }

        const exitCode = typeof process.exitCode === 'number' ? process.exitCode : 0;
        send({
            type: 'result',
            id: message.id,
            success: exitCode === 0,
            output: stdout.trim() || (exitCode === 0 ? '(no output)' : ''),
            error: exitCode === 0 ? undefined : (stderr.trim() || `Process exited with code ${exitCode}`),
        });
    } catch (error: any) {
        if (error?.__telosWorkerProcessExit) {
            const exitCode = typeof error.code === 'number' ? error.code : 0;
            send({
                type: 'result',
                id: message.id,
                success: exitCode === 0,
                output: stdout.trim() || (exitCode === 0 ? '(no output)' : ''),
                error: exitCode === 0 ? undefined : (stderr.trim() || `Process exited with code ${exitCode}`),
            });
        } else {
            const rendered = error instanceof Error ? (error.stack || error.message) : String(error);
            if (rendered && !stderr.includes(rendered)) {
                stderr += rendered;
            }
            send({
                type: 'result',
                id: message.id,
                success: false,
                output: stdout.trim(),
                error: stderr.trim() || rendered || 'Action failed',
            });
        }
    } finally {
        process.stdout.write = previousStdoutWrite;
        process.stderr.write = previousStderrWrite;
        process.exit = previousExit;
        restoreEnv(previousEnv);
        restoreGlobalAdditions();
    }
}

process.on('message', (message: RunMessage) => {
    if (!message || message.type !== 'run') {
        return;
    }
    runAction(message).catch((error: any) => {
        send({
            type: 'result',
            id: message.id,
            success: false,
            output: '',
            error: error instanceof Error ? (error.stack || error.message) : String(error),
        });
    });
});

process.on('disconnect', () => {
    originalExit(0);
});
