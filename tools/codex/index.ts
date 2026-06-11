import { spawn } from 'child_process';
import { randomUUID } from 'crypto';
import { existsSync } from 'fs';
import { mkdir, readFile, rename, stat, unlink, writeFile } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import type {
    Input,
    ModelReasoningEffort,
    ThreadItem,
    ThreadOptions,
    Turn,
    TurnOptions,
    Usage,
    UserInput,
} from '@openai/codex-sdk';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const DATA_DIR = path.join(PROJECT_ROOT, 'data', 'codex');
const THREADS_FILE = path.join(DATA_DIR, 'threads.json');
const STREAMS_DIR = path.join(DATA_DIR, 'streams');
const STREAM_WORKER_PATH = path.join(__dirname, 'stream-worker.mjs');
const STREAM_POLL_INTERVAL_MS = 500;

const DEFAULT_THREAD_OPTIONS: ThreadOptions = {
    model: 'gpt-5.4',
    modelReasoningEffort: 'medium',
    approvalPolicy: 'never',
    networkAccessEnabled: true,
    webSearchEnabled: true,
    sandboxMode: 'danger-full-access',
    skipGitRepoCheck: true,
};

export interface ManagedThreadRecord {
    id: string;
    name: string;
    sdkThreadId: string | null;
    workingDirectory: string;
    options: ThreadOptions;
    createdAt: string;
    updatedAt: string;
}

export interface StreamStatus {
    threadId: string;
    sdkThreadId: string | null;
    completed: boolean;
    items: ThreadItem[];
    finalResponse: string;
    usage: Usage | null;
    error?: string;
    startedAt: string;
    updatedAt: string;
}

interface StreamRequestPayload {
    input: Input;
    turnOptions?: Omit<TurnOptions, 'signal'>;
}

async function createCodexClient() {
    const { Codex } = await import('@openai/codex-sdk');
    return new Codex();
}

function nowIso(): string {
    return new Date().toISOString();
}

function cloneThreadRecord(record: ManagedThreadRecord): ManagedThreadRecord {
    return {
        ...record,
        options: { ...record.options },
    };
}

function cloneStreamStatus(status: StreamStatus): StreamStatus {
    return {
        ...status,
        items: [...status.items],
        usage: status.usage ? { ...status.usage } : null,
    };
}

function getStreamStatePath(threadId: string): string {
    return path.join(STREAMS_DIR, `${threadId}.json`);
}

function getStreamRequestPath(threadId: string): string {
    return path.join(STREAMS_DIR, `${threadId}.request.json`);
}

async function ensureStorage(): Promise<void> {
    await mkdir(DATA_DIR, { recursive: true });
    await mkdir(STREAMS_DIR, { recursive: true });

    if (!existsSync(THREADS_FILE)) {
        await writeJsonAtomic(THREADS_FILE, []);
    }
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
    const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(tempPath, JSON.stringify(value, null, 2), 'utf-8');
    await rename(tempPath, filePath);
}

async function readJsonFile<T>(filePath: string, fallback: T): Promise<T> {
    try {
        const raw = await readFile(filePath, 'utf-8');
        return JSON.parse(raw) as T;
    } catch (error) {
        const err = error as NodeJS.ErrnoException;
        if (err.code === 'ENOENT') {
            return fallback;
        }
        throw error;
    }
}

async function loadThreadRecords(): Promise<ManagedThreadRecord[]> {
    await ensureStorage();
    const records = await readJsonFile<ManagedThreadRecord[]>(THREADS_FILE, []);
    return Array.isArray(records) ? records : [];
}

async function saveThreadRecords(records: ManagedThreadRecord[]): Promise<void> {
    await writeJsonAtomic(THREADS_FILE, records);
}

async function upsertThreadRecord(record: ManagedThreadRecord): Promise<void> {
    const records = await loadThreadRecords();
    const index = records.findIndex(existing => existing.id === record.id);

    if (index >= 0) {
        records[index] = cloneThreadRecord(record);
    } else {
        records.push(cloneThreadRecord(record));
    }

    await saveThreadRecords(records);
}

async function findThreadRecord(id: string): Promise<ManagedThreadRecord | null> {
    const records = await loadThreadRecords();
    const match = records.find(record => record.id === id || record.sdkThreadId === id);
    return match ? cloneThreadRecord(match) : null;
}

async function requireThreadRecord(id: string): Promise<ManagedThreadRecord> {
    const record = await findThreadRecord(id);
    if (!record) {
        throw new Error(`Codex thread "${id}" was not found in data/codex/threads.json`);
    }
    return record;
}

async function ensureDirectoryExists(directory: string): Promise<void> {
    const info = await stat(directory).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') {
            throw new Error(`Working directory "${directory}" does not exist`);
        }
        throw error;
    });

    if (!info.isDirectory()) {
        throw new Error(`Working directory "${directory}" is not a directory`);
    }
}

function resolveWorkingDirectory(workingDirectory = './'): string {
    return path.resolve(process.cwd(), workingDirectory);
}

function buildThreadOptions(workingDirectory: string, options?: ThreadOptions): ThreadOptions {
    return {
        ...DEFAULT_THREAD_OPTIONS,
        ...options,
        workingDirectory,
    };
}

function normalizeInputForThread(input: Input, workingDirectory: string): Input {
    if (typeof input === 'string') {
        return input;
    }

    return input.map((entry: UserInput) => {
        if (entry.type !== 'local_image') {
            return { ...entry };
        }

        return {
            ...entry,
            path: path.isAbsolute(entry.path)
                ? entry.path
                : path.resolve(workingDirectory, entry.path),
        };
    });
}

function createInitialStreamStatus(record: ManagedThreadRecord): StreamStatus {
    const timestamp = nowIso();
    return {
        threadId: record.id,
        sdkThreadId: record.sdkThreadId,
        completed: false,
        items: [],
        finalResponse: '',
        usage: null,
        startedAt: timestamp,
        updatedAt: timestamp,
    };
}

async function readStreamStatusInternal(threadId: string): Promise<StreamStatus | null> {
    return readJsonFile<StreamStatus | null>(getStreamStatePath(threadId), null);
}

async function requireNoActiveStream(threadId: string): Promise<void> {
    const status = await readStreamStatusInternal(threadId);
    if (status && !status.completed) {
        throw new Error(`A Codex stream is already running for thread "${threadId}"`);
    }
}

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

export class ManagedCodexThread {
    private record: ManagedThreadRecord;

    constructor(record: ManagedThreadRecord) {
        this.record = cloneThreadRecord(record);
    }

    get id(): string {
        return this.record.id;
    }

    get name(): string {
        return this.record.name;
    }

    get sdkThreadId(): string | null {
        return this.record.sdkThreadId;
    }

    get workingDirectory(): string {
        return this.record.workingDirectory;
    }

    get options(): ThreadOptions {
        return { ...this.record.options };
    }

    private async createSdkThread() {
        const client = await createCodexClient();
        if (this.record.sdkThreadId) {
            return client.resumeThread(this.record.sdkThreadId, this.record.options);
        }
        return client.startThread(this.record.options);
    }

    private async refreshRecord(): Promise<void> {
        this.record = await requireThreadRecord(this.record.id);
    }

    private async syncAfterSdkTurn(sdkThreadId: string | null): Promise<void> {
        if (sdkThreadId) {
            this.record.sdkThreadId = sdkThreadId;
        }
        this.record.updatedAt = nowIso();
        await upsertThreadRecord(this.record);
    }

    async run(input: Input, turnOptions?: TurnOptions): Promise<Turn> {
        const thread = await this.createSdkThread();
        const normalizedInput = normalizeInputForThread(input, this.record.workingDirectory);
        const result = await thread.run(normalizedInput, turnOptions);
        await this.syncAfterSdkTurn(thread.id);
        await this.refreshRecord();
        return result;
    }

    async stream(input: Input, turnOptions?: Omit<TurnOptions, 'signal'>): Promise<string> {
        if (turnOptions && 'signal' in turnOptions) {
            throw new Error('Managed Codex streams do not support AbortSignal because they run in a detached worker');
        }

        await requireNoActiveStream(this.record.id);

        const statePath = getStreamStatePath(this.record.id);
        const requestPath = getStreamRequestPath(this.record.id);
        const request: StreamRequestPayload = {
            input: normalizeInputForThread(input, this.record.workingDirectory),
            turnOptions,
        };

        await writeJsonAtomic(statePath, createInitialStreamStatus(this.record));
        await writeJsonAtomic(requestPath, request);

        const child = spawn(process.execPath, [STREAM_WORKER_PATH, this.record.id], {
            cwd: PROJECT_ROOT,
            detached: true,
            env: process.env,
            stdio: 'ignore',
        });

        child.unref();

        this.record.updatedAt = nowIso();
        await upsertThreadRecord(this.record);

        return this.record.id;
    }
}

export async function newThread(
    name: string,
    workingDirectory = './',
    options?: ThreadOptions & {
        model?: string;
        modelReasoningEffort?: ModelReasoningEffort;
    }
): Promise<ManagedCodexThread> {
    const normalizedName = String(name || '').trim();
    if (!normalizedName) {
        throw new Error('codex.newThread(name, workingDirectory) requires a non-empty thread name');
    }

    const resolvedWorkingDirectory = resolveWorkingDirectory(workingDirectory);
    await ensureDirectoryExists(resolvedWorkingDirectory);
    await ensureStorage();

    const timestamp = nowIso();
    const record: ManagedThreadRecord = {
        id: randomUUID(),
        name: normalizedName,
        sdkThreadId: null,
        workingDirectory: resolvedWorkingDirectory,
        options: buildThreadOptions(resolvedWorkingDirectory, options),
        createdAt: timestamp,
        updatedAt: timestamp,
    };

    await upsertThreadRecord(record);
    return new ManagedCodexThread(record);
}

export async function listThreads(): Promise<ManagedThreadRecord[]> {
    const records = await loadThreadRecords();
    return records
        .map(record => cloneThreadRecord(record))
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

export async function getThread(id: string): Promise<ManagedCodexThread> {
    const record = await requireThreadRecord(id);
    return new ManagedCodexThread(record);
}

export async function streamStatus(id: string): Promise<StreamStatus> {
    const record = await requireThreadRecord(id);
    const status = await readStreamStatusInternal(record.id);

    if (!status) {
        return {
            threadId: record.id,
            sdkThreadId: record.sdkThreadId,
            completed: true,
            items: [],
            finalResponse: '',
            usage: null,
            error: 'No Codex stream has been started for this thread yet',
            startedAt: nowIso(),
            updatedAt: nowIso(),
        };
    }

    return cloneStreamStatus(status);
}

export async function waitStream(id: string, minNewItems = 1): Promise<StreamStatus> {
    const normalizedMinItems = Number.isFinite(minNewItems) ? Math.floor(minNewItems) : 1;
    if (normalizedMinItems < 1) {
        throw new Error('codex.waitStream(id, minNewItems) requires minNewItems >= 1');
    }

    const initialStatus = await streamStatus(id);
    if (initialStatus.completed || initialStatus.error && initialStatus.items.length === 0) {
        return initialStatus;
    }

    const baselineCount = initialStatus.items.length;
    const targetCount = baselineCount + normalizedMinItems;

    for (;;) {
        await sleep(STREAM_POLL_INTERVAL_MS);
        const status = await streamStatus(id);
        if (status.completed || status.items.length >= targetCount) {
            return status;
        }
    }
}

export async function joinStream(id: string): Promise<StreamStatus> {
    for (;;) {
        const status = await streamStatus(id);
        if (status.completed) {
            return status;
        }
        await sleep(STREAM_POLL_INTERVAL_MS);
    }
}

export const waitForStreamItem = waitStream;
export const waitForStreamCompletion = joinStream;

export async function clearCompletedStream(id: string): Promise<boolean> {
    const record = await requireThreadRecord(id);
    const statePath = getStreamStatePath(record.id);
    const requestPath = getStreamRequestPath(record.id);
    const status = await readStreamStatusInternal(record.id);

    if (status && !status.completed) {
        throw new Error(`Cannot clear stream state for "${record.id}" while the stream is still running`);
    }

    let removed = false;
    for (const filePath of [statePath, requestPath]) {
        try {
            await unlink(filePath);
            removed = true;
        } catch (error) {
            const err = error as NodeJS.ErrnoException;
            if (err.code !== 'ENOENT') {
                throw error;
            }
        }
    }

    return removed;
}
