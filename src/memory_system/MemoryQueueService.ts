import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import type { IngestTextInput } from './types.js';
import type { MemoryService } from './MemoryService.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', '..', 'data', 'memory');
const STATE_PATH = join(DATA_DIR, 'queue-state.json');
const DEFAULT_SPACING_MS = 30_000;

export interface QueuedMemoryJob {
  id: string;
  createdAt: number;
  availableAt: number;
  attempts: number;
  lastError: string | null;
  input: IngestTextInput;
}

interface QueueState {
  version: 1;
  spacingMs: number;
  lastProcessedAt: number | null;
  jobs: QueuedMemoryJob[];
}

export interface QueueReceipt {
  queued: true;
  id: string;
  etaSeconds: number;
}

const DEFAULT_STATE: QueueState = {
  version: 1,
  spacingMs: DEFAULT_SPACING_MS,
  lastProcessedAt: null,
  jobs: [],
};

function normalizeSpacingMs(spacingSeconds?: number): number {
  if (typeof spacingSeconds !== 'number' || !Number.isFinite(spacingSeconds) || spacingSeconds <= 0) {
    return DEFAULT_SPACING_MS;
  }
  return Math.max(1_000, Math.floor(spacingSeconds * 1_000));
}

export class MemoryQueueService {
  private readonly memoryService: MemoryService;
  private state: QueueState = { ...DEFAULT_STATE };
  private initialized = false;
  private processing = false;
  private timer: NodeJS.Timeout | null = null;

  constructor(memoryService: MemoryService, spacingSeconds?: number) {
    this.memoryService = memoryService;
    this.state.spacingMs = normalizeSpacingMs(spacingSeconds);
  }

  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    await mkdir(DATA_DIR, { recursive: true });
    this.state = await this.readState();
    this.state.spacingMs = normalizeSpacingMs(this.state.spacingMs / 1000);
    this.initialized = true;
    this.scheduleNext();
  }

  async setSpacingSeconds(spacingSeconds?: number): Promise<void> {
    await this.initialize();
    this.state.spacingMs = normalizeSpacingMs(spacingSeconds);
    await this.persistState();
    this.scheduleNext();
  }

  async enqueue(input: IngestTextInput): Promise<QueueReceipt> {
    await this.initialize();

    const now = Date.now();
    const lastScheduledAt = this.state.jobs.length > 0
      ? Math.max(...this.state.jobs.map((job) => job.availableAt))
      : (this.state.lastProcessedAt ?? now);
    const availableAt = Math.max(now, lastScheduledAt + this.state.spacingMs);
    const job: QueuedMemoryJob = {
      id: randomUUID(),
      createdAt: now,
      availableAt,
      attempts: 0,
      lastError: null,
      input,
    };

    this.state.jobs.push(job);
    await this.persistState();
    this.scheduleNext();

    return {
      queued: true,
      id: job.id,
      etaSeconds: Math.max(0, Math.ceil((availableAt - now) / 1000)),
    };
  }

  async getState(): Promise<QueueState> {
    await this.initialize();
    return JSON.parse(JSON.stringify(this.state)) as QueueState;
  }

  private async readState(): Promise<QueueState> {
    try {
      const raw = await readFile(STATE_PATH, 'utf8');
      const parsed = JSON.parse(raw) as Partial<QueueState>;
      return {
        version: 1,
        spacingMs: normalizeSpacingMs(typeof parsed.spacingMs === 'number' ? parsed.spacingMs / 1000 : undefined),
        lastProcessedAt: typeof parsed.lastProcessedAt === 'number' ? parsed.lastProcessedAt : null,
        jobs: Array.isArray(parsed.jobs) ? parsed.jobs.filter(Boolean) as QueuedMemoryJob[] : [],
      };
    } catch {
      return { ...DEFAULT_STATE, spacingMs: this.state.spacingMs };
    }
  }

  private async persistState(): Promise<void> {
    await mkdir(DATA_DIR, { recursive: true });
    await writeFile(STATE_PATH, JSON.stringify(this.state, null, 2) + '\n', 'utf8');
  }

  private scheduleNext(): void {
    if (!this.initialized) {
      return;
    }

    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    const nextJob = this.state.jobs
      .slice()
      .sort((left, right) => left.availableAt - right.availableAt)[0];
    if (!nextJob) {
      return;
    }

    const delayMs = Math.max(0, nextJob.availableAt - Date.now());
    this.timer = setTimeout(() => {
      void this.processDueJobs();
    }, delayMs);
    this.timer.unref?.();
  }

  private async processDueJobs(): Promise<void> {
    if (this.processing) {
      return;
    }
    this.processing = true;

    try {
      await this.initialize();

      for (;;) {
        const nextJob = this.state.jobs
          .slice()
          .sort((left, right) => left.availableAt - right.availableAt)[0];
        if (!nextJob) {
          break;
        }
        if (nextJob.availableAt > Date.now()) {
          break;
        }

        const targetJob = this.state.jobs.find((job) => job.id === nextJob.id);
        if (!targetJob) {
          continue;
        }

        try {
          await this.memoryService.ingestText(targetJob.input);
          this.state.jobs = this.state.jobs.filter((job) => job.id !== targetJob.id);
          this.state.lastProcessedAt = Date.now();
        } catch (error) {
          targetJob.attempts += 1;
          targetJob.lastError = error instanceof Error ? error.message : String(error);
          targetJob.availableAt = Date.now() + this.state.spacingMs;
        }

        await this.persistState();
      }
    } finally {
      this.processing = false;
      this.scheduleNext();
    }
  }
}
