import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentMemoryNotesSyncConfig } from '../types/index.js';
import type { MemoryQueueService } from '../memory_system/MemoryQueueService.js';
import type { MemoryService } from '../memory_system/MemoryService.js';
import { KeepAuthStore, type KeepAuthProfile } from './auth-store.js';
import { bridgeProfileFromAuth, runBridge } from './bridge.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const DATA_DIR = path.join(PROJECT_ROOT, 'data', 'memory');
const NOTES_DATA_DIR = path.join(PROJECT_ROOT, 'data', 'memory-notes');
const STATE_PATH = path.join(DATA_DIR, 'notes-sync-state.json');
const DEFAULT_POLL_INTERVAL_MS = 60_000;
const DEFAULT_STABLE_DELAY_MS = 30 * 60_000;
const RECENT_LIMIT = 100;

interface KeepNoteSummary {
  id: string;
  title: string;
  logicalTitle: string;
  rawTitle: string;
  kind: 'note' | 'list';
  owner: 'system' | 'owner' | 'user';
  archived: boolean;
  trashed: boolean;
  pinned: boolean;
  createdAt?: string | null;
  updatedAt?: string | null;
  preview: string;
}

interface KeepListItem {
  id: string;
  text: string;
  checked: boolean;
  sort?: number | null;
}

interface KeepNoteDetail extends KeepNoteSummary {
  text: string;
  items?: KeepListItem[];
}

interface NoteFingerprint {
  modifiedAt: string | null;
  contentHash: string;
}

interface TrackedNoteState {
  noteId: string;
  sourceId: string;
  sourceLabel: string;
  fingerprint: NoteFingerprint;
}

interface PendingSyncState {
  noteId: string;
  action: 'sync' | 'remove';
  dueAt: number;
}

interface NotesSyncState {
  version: 1;
  trackedNotes: Record<string, TrackedNoteState>;
  pending: Record<string, PendingSyncState>;
}

const DEFAULT_STATE: NotesSyncState = {
  version: 1,
  trackedNotes: {},
  pending: {},
};

function hashContent(text: string): string {
  let hash = 0;
  for (let i = 0; i < text.length; i += 1) {
    hash = ((hash << 5) - hash) + text.charCodeAt(i);
    hash |= 0;
  }
  return hash.toString(36);
}

function noteText(detail: KeepNoteDetail): string {
  if (detail.kind === 'list') {
    return (detail.items || [])
      .map((item) => `${item.checked ? '[x]' : '[ ]'} ${item.text}`)
      .join('\n')
      .trim();
  }
  return String(detail.text || '').trim();
}

function buildFingerprint(detail: KeepNoteDetail): NoteFingerprint {
  return {
    modifiedAt: detail.updatedAt || detail.createdAt || null,
    contentHash: hashContent(noteText(detail)),
  };
}

function fingerprintsEqual(left?: NoteFingerprint, right?: NoteFingerprint): boolean {
  return Boolean(left && right && left.modifiedAt === right.modifiedAt && left.contentHash === right.contentHash);
}

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
  private readonly memoryService: MemoryService;
  private readonly queueService: MemoryQueueService;
  private readonly authStore = new KeepAuthStore(NOTES_DATA_DIR);
  private state: NotesSyncState = { ...DEFAULT_STATE };
  private initialized = false;
  private pollIntervalMs = DEFAULT_POLL_INTERVAL_MS;
  private stableDelayMs = DEFAULT_STABLE_DELAY_MS;
  private pollTimer: NodeJS.Timeout | null = null;
  private settleTimer: NodeJS.Timeout | null = null;
  private pollInFlight = false;

  constructor(memoryService: MemoryService, queueService: MemoryQueueService) {
    this.memoryService = memoryService;
    this.queueService = queueService;
  }

  async initialize(config?: AgentMemoryNotesSyncConfig): Promise<void> {
    this.pollIntervalMs = normalizePollIntervalMs(config);
    this.stableDelayMs = normalizeStableDelayMs(config);
    if (this.initialized) {
      this.armTimers();
      return;
    }

    await mkdir(DATA_DIR, { recursive: true });
    this.state = await this.readState();
    this.initialized = true;
    this.armTimers();
    void this.poll();
  }

  async notifyNoteUpsert(noteId: string, sourceLabel?: string): Promise<void> {
    await this.initialize();
    const normalizedNoteId = String(noteId || '').trim();
    if (!normalizedNoteId) return;
    this.state.pending[normalizedNoteId] = {
      noteId: normalizedNoteId,
      action: 'sync',
      dueAt: Date.now() + this.stableDelayMs,
    };
    if (sourceLabel && this.state.trackedNotes[normalizedNoteId]) {
      this.state.trackedNotes[normalizedNoteId]!.sourceLabel = sourceLabel;
    }
    await this.persistState();
    this.armTimers();
  }

  async notifyNoteRemoval(noteId: string): Promise<void> {
    await this.initialize();
    const normalizedNoteId = String(noteId || '').trim();
    if (!normalizedNoteId) return;
    this.state.pending[normalizedNoteId] = {
      noteId: normalizedNoteId,
      action: 'remove',
      dueAt: Date.now(),
    };
    await this.persistState();
    this.armTimers();
    void this.settlePending();
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
        version: 1,
        trackedNotes: parsed.trackedNotes && typeof parsed.trackedNotes === 'object' ? parsed.trackedNotes as Record<string, TrackedNoteState> : {},
        pending: parsed.pending && typeof parsed.pending === 'object' ? parsed.pending as Record<string, PendingSyncState> : {},
      };
    } catch {
      return { ...DEFAULT_STATE };
    }
  }

  private async persistState(): Promise<void> {
    await mkdir(DATA_DIR, { recursive: true });
    await writeFile(STATE_PATH, JSON.stringify(this.state, null, 2) + '\n', 'utf8');
  }

  private armTimers(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
    }
    this.pollTimer = setInterval(() => {
      void this.poll();
    }, this.pollIntervalMs);
    this.pollTimer.unref?.();

    if (this.settleTimer) {
      clearTimeout(this.settleTimer);
      this.settleTimer = null;
    }

    const nextPending = Object.values(this.state.pending)
      .sort((left, right) => left.dueAt - right.dueAt)[0];
    if (!nextPending) {
      return;
    }

    this.settleTimer = setTimeout(() => {
      void this.settlePending();
    }, Math.max(0, nextPending.dueAt - Date.now()));
    this.settleTimer.unref?.();
  }

  private async getActiveProfile(): Promise<KeepAuthProfile | null> {
    return (await this.authStore.getActiveProfile()) || null;
  }

  private async runKeepBridge<T>(profile: KeepAuthProfile, action: string, input?: Record<string, unknown>): Promise<T> {
    const statePath = this.authStore.getStatePath(profile.id);
    return runBridge<T>({
      action,
      profile: bridgeProfileFromAuth(profile, statePath),
      input,
    });
  }

  private async listRecentNotes(profile: KeepAuthProfile): Promise<KeepNoteSummary[]> {
    return this.runKeepBridge<KeepNoteSummary[]>(profile, 'list_notes', {
      limit: RECENT_LIMIT,
      trashed: false,
    });
  }

  private async getNoteDetail(profile: KeepAuthProfile, noteId: string): Promise<KeepNoteDetail> {
    return this.runKeepBridge<KeepNoteDetail>(profile, 'get_note', { note: noteId });
  }

  private async poll(): Promise<void> {
    if (!this.initialized || this.pollInFlight) {
      return;
    }
    this.pollInFlight = true;

    try {
      const profile = await this.getActiveProfile();
      if (!profile) {
        return;
      }

      const notes = await this.listRecentNotes(profile);
      for (const note of notes) {
        if (note.owner === 'system' || note.archived || note.trashed) {
          continue;
        }
        const detail = await this.getNoteDetail(profile, note.id);
        const fingerprint = buildFingerprint(detail);
        const tracked = this.state.trackedNotes[detail.id];
        if (!tracked || !fingerprintsEqual(tracked.fingerprint, fingerprint)) {
          this.state.pending[detail.id] = {
            noteId: detail.id,
            action: 'sync',
            dueAt: Date.now() + this.stableDelayMs,
          };
        }
      }

      await this.persistState();
      this.armTimers();
    } finally {
      this.pollInFlight = false;
    }
  }

  private async settlePending(): Promise<void> {
    if (!this.initialized) {
      return;
    }

    const dueItems = Object.values(this.state.pending)
      .filter((item) => item.dueAt <= Date.now())
      .sort((left, right) => left.dueAt - right.dueAt);
    if (dueItems.length === 0) {
      this.armTimers();
      return;
    }

    const profile = await this.getActiveProfile();
    for (const pending of dueItems) {
      delete this.state.pending[pending.noteId];

      if (pending.action === 'remove') {
        await this.memoryService.deleteFactsBySourceId(`keep:${pending.noteId}`);
        delete this.state.trackedNotes[pending.noteId];
        continue;
      }

      if (!profile) {
        this.state.pending[pending.noteId] = {
          ...pending,
          dueAt: Date.now() + this.pollIntervalMs,
        };
        continue;
      }

      try {
        const detail = await this.getNoteDetail(profile, pending.noteId);
        if (detail.archived || detail.trashed || detail.owner === 'system') {
          await this.memoryService.deleteFactsBySourceId(`keep:${pending.noteId}`);
          delete this.state.trackedNotes[pending.noteId];
          continue;
        }

        const fingerprint = buildFingerprint(detail);
        const tracked = this.state.trackedNotes[pending.noteId];
        if (!tracked || !fingerprintsEqual(tracked.fingerprint, fingerprint)) {
          await this.memoryService.deleteFactsBySourceId(`keep:${pending.noteId}`);
          await this.queueService.enqueue({
            text: noteText(detail),
            sourceId: `keep:${detail.id}`,
            sourceLabel: detail.logicalTitle || detail.title,
          });
          this.state.trackedNotes[pending.noteId] = {
            noteId: detail.id,
            sourceId: `keep:${detail.id}`,
            sourceLabel: detail.logicalTitle || detail.title,
            fingerprint,
          };
        }
      } catch {
        this.state.pending[pending.noteId] = {
          ...pending,
          dueAt: Date.now() + this.pollIntervalMs,
        };
      }
    }

    await this.persistState();
    this.armTimers();
  }
}
