import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentMemoryNotesSyncConfig } from '../types/index.js';
import type { MemoryQueueService } from '../memory_system/MemoryQueueService.js';
import type { MemoryService } from '../memory_system/MemoryService.js';
import { getContentMemoryService } from '../content_memory/service.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const DATA_DIR = path.join(PROJECT_ROOT, 'data', 'memory');
const STATE_PATH = path.join(DATA_DIR, 'notes-sync-state.json');
const DEFAULT_POLL_INTERVAL_MS = 60_000;
const DEFAULT_STABLE_DELAY_MS = 24 * 60 * 60_000;
const WARNING_THROTTLE_MS = 60_000;

interface PendingSyncState {
  noteId: string;
  action: 'sync' | 'remove';
  dueAt: number;
}

interface NotesSyncState {
  version: 2;
  trackedNotes: Record<string, { noteId: string; sourceLabel: string; updatedAt: string }>;
  pending: Record<string, PendingSyncState>;
  lastScanAt?: string;
  lastArchived?: number;
  lastSkipped?: number;
  lastErrors?: Array<{ path: string; error: string }>;
}

const DEFAULT_STATE: NotesSyncState = {
  version: 2,
  trackedNotes: {},
  pending: {},
};

function normalizePollIntervalMs(config?: AgentMemoryNotesSyncConfig): number {
  const raw = config?.pollIntervalSeconds;
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) {
    return DEFAULT_POLL_INTERVAL_MS;
  }
  return Math.max(5_000, Math.floor(raw * 1_000));
}

function normalizeStableDelayMs(config?: AgentMemoryNotesSyncConfig): number {
  const raw = config?.stableDelayMinutes;
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) {
    return DEFAULT_STABLE_DELAY_MS;
  }
  return Math.max(60_000, Math.floor(raw * 60_000));
}

export class MemoryNotesSyncService {
  private state: NotesSyncState = { ...DEFAULT_STATE };
  private initialized = false;
  private pollIntervalMs = DEFAULT_POLL_INTERVAL_MS;
  private stableDelayMs = DEFAULT_STABLE_DELAY_MS;
  private pollTimer: NodeJS.Timeout | null = null;
  private pollInFlight = false;
  private lastWarningAt = 0;

  constructor(_memoryService: MemoryService, _queueService: MemoryQueueService) {}

  async initialize(config?: AgentMemoryNotesSyncConfig): Promise<void> {
    this.pollIntervalMs = normalizePollIntervalMs(config);
    this.stableDelayMs = normalizeStableDelayMs(config);
    if (this.initialized) {
      this.armTimer();
      return;
    }

    await mkdir(DATA_DIR, { recursive: true });
    this.state = await this.readState();
    this.initialized = true;
    this.armTimer();
    this.runBestEffort('vault scan', () => this.poll());
  }

  async notifyNoteUpsert(noteId: string, sourceLabel?: string): Promise<void> {
    await this.initialize();
    const normalizedNoteId = String(noteId || '').trim();
    if (!normalizedNoteId) return;
    this.state.trackedNotes[normalizedNoteId] = {
      noteId: normalizedNoteId,
      sourceLabel: sourceLabel || normalizedNoteId,
      updatedAt: new Date().toISOString(),
    };
    await this.persistState();
  }

  async notifyNoteRemoval(noteId: string): Promise<void> {
    await this.initialize();
    delete this.state.trackedNotes[String(noteId || '').trim()];
    await this.persistState();
  }

  async getState(): Promise<NotesSyncState> {
    await this.initialize();
    return JSON.parse(JSON.stringify(this.state)) as NotesSyncState;
  }

  private async readState(): Promise<NotesSyncState> {
    try {
      const raw = await readFile(STATE_PATH, 'utf8');
      const parsed = JSON.parse(raw) as Partial<NotesSyncState>;
      return {
        version: 2,
        trackedNotes: parsed.trackedNotes && typeof parsed.trackedNotes === 'object' ? parsed.trackedNotes as NotesSyncState['trackedNotes'] : {},
        pending: parsed.pending && typeof parsed.pending === 'object' ? parsed.pending as Record<string, PendingSyncState> : {},
        lastScanAt: parsed.lastScanAt,
        lastArchived: parsed.lastArchived,
        lastSkipped: parsed.lastSkipped,
        lastErrors: Array.isArray(parsed.lastErrors) ? parsed.lastErrors : [],
      };
    } catch {
      return { ...DEFAULT_STATE };
    }
  }

  private async persistState(): Promise<void> {
    await mkdir(DATA_DIR, { recursive: true });
    await writeFile(STATE_PATH, JSON.stringify(this.state, null, 2) + '\n', 'utf8');
  }

  private armTimer(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
    }
    this.pollTimer = setInterval(() => {
      this.runBestEffort('vault scan', () => this.poll());
    }, this.pollIntervalMs);
    this.pollTimer.unref?.();
  }

  private runBestEffort(label: string, task: () => Promise<void>): void {
    void task().catch(error => {
      const message = error instanceof Error ? error.message : String(error);
      this.warnSyncFailure(`Obsidian notes ${label} failed; memory sync will retry later: ${message}`);
    });
  }

  private warnSyncFailure(message: string): void {
    const now = Date.now();
    if (now - this.lastWarningAt < WARNING_THROTTLE_MS) {
      return;
    }
    this.lastWarningAt = now;
    console.warn(`[memory.notes] ${message}`);
  }

  private async poll(): Promise<void> {
    if (!this.initialized || this.pollInFlight) {
      return;
    }
    this.pollInFlight = true;
    try {
      const result = await getContentMemoryService().settleNotesVault({ olderThanMs: this.stableDelayMs });
      this.state.lastScanAt = new Date().toISOString();
      this.state.lastArchived = result.archived;
      this.state.lastSkipped = result.skipped;
      this.state.lastErrors = result.errors.slice(0, 20);
      await this.persistState();
    } finally {
      this.pollInFlight = false;
    }
  }
}
