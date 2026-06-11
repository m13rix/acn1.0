import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { structuredLlm } from '../../../../src/utils/structuredLlm.js';
import type { HeartbeatSensorEvent, SensorAskInput } from '../../../../src/heartbeat/types.js';
import { KeepAuthStore, type KeepAuthProfile } from '../../../../src/memory_notes/auth-store.js';
import { bridgeProfileFromAuth, runBridge } from '../../../../src/memory_notes/bridge.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '..', '..', '..', '..');
const DATA_DIR = path.join(ROOT_DIR, 'data', 'heartbeat');
const NOTES_DATA_DIR = path.join(ROOT_DIR, 'data', 'memory-notes');
const POLL_INTERVAL_MS = 60000;
const RECENT_LIMIT = 10;
const STABLE_DELAY_MS = 10000;

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

interface PendingTrigger {
  noteId: string;
  title: string;
  kind: KeepNoteDetail['kind'];
  owner: KeepNoteDetail['owner'];
  text: string;
  items: KeepListItem[];
  createdAt: string | null;
  modifiedAt: string | null;
  fingerprint: NoteFingerprint;
  timeoutId: NodeJS.Timeout;
}

let intervalId: NodeJS.Timeout | null = null;
let emitFn: ((event: Omit<HeartbeatSensorEvent, 'sensor'>) => void) | null = null;
let latestNoteSnapshot: Record<string, unknown> | null = null;
let baselineProfileId: string | null = null;
let pollInFlight = false;

const knownNoteStates: Map<string, NoteFingerprint> = new Map();
const pendingTriggers: Map<string, PendingTrigger> = new Map();
const authStore = new KeepAuthStore(NOTES_DATA_DIR);

function hashContent(text: string): string {
  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    const chr = text.charCodeAt(i);
    hash = ((hash << 5) - hash) + chr;
    hash |= 0;
  }
  return hash.toString(36);
}

function describeNote(note: Pick<KeepNoteSummary, 'title' | 'id' | 'kind' | 'owner'>): string {
  const title = typeof note.title === 'string' && note.title.trim() ? note.title.trim() : '(untitled)';
  const suffix = typeof note.id === 'string' && note.id ? ` [${note.id}]` : '';
  return `${title}${suffix} <${note.kind}/${note.owner}>`;
}

function formatLogValue(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch (error) {
    return `[unserializable: ${error instanceof Error ? error.message : String(error)}]`;
  }
}

function schemaHasBooleanAndReasonFields(schema: unknown): boolean {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    return false;
  }

  const properties = (schema as any).properties;
  return !!properties
    && typeof properties === 'object'
    && !Array.isArray(properties)
    && properties.shouldHandle?.type === 'boolean'
    && properties.reason?.type === 'string';
}

function extractPromptField(prompt: string, label: string): string {
  const escapedLabel = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = prompt.match(new RegExp(`${escapedLabel}:\\s*([\\s\\S]*?)(?:\\n[A-ZА-ЯЁ][^\\n]*:|$)`, 'i'));
  return match?.[1]?.trim() || '';
}

function fallbackHomeworkClassification(prompt: string): { shouldHandle: boolean; reason: string } | null {
  const title = extractPromptField(prompt, 'Название заметки');
  const text = extractPromptField(prompt, 'Текст заметки');
  const corpus = `${title}\n${text}\n${prompt}`.toLowerCase();

  const strongSignals = [
    /домашн(?:ее|яя)?\s+задан/i,
    /(?:^|\s)дз(?:\s|$)/i,
    /параграф/i,
    /конспект/i,
    /упражнен/i,
    /задач/i,
    /истори/i,
    /геометр/i,
    /алгебр/i,
    /русск/i,
    /английск/i,
    /физик/i,
    /хими/i,
    /биолог/i,
    /учить/i,
  ];

  const signalCount = strongSignals.reduce((count, pattern) => count + (pattern.test(corpus) ? 1 : 0), 0);
  if (signalCount >= 2) {
    return {
      shouldHandle: true,
      reason: 'Fallback notes heuristic matched multiple school/homework signals in the note text.',
    };
  }

  return {
    shouldHandle: false,
    reason: 'Fallback notes heuristic did not find enough school/homework signals in the note text.',
  };
}

function noteText(detail: KeepNoteDetail): string {
  if (detail.kind === 'list') {
    return (detail.items || [])
      .map(item => `${item.checked ? '[x]' : '[ ]'} ${item.text}`)
      .join('\n')
      .trim();
  }
  return String(detail.text || '').trim();
}

function shouldIgnoreSystemNote(note: Pick<KeepNoteSummary, 'owner'>): boolean {
  return note.owner === 'system';
}

function noteModifiedAt(note: Pick<KeepNoteSummary, 'updatedAt' | 'createdAt'>): string | null {
  return note.updatedAt || note.createdAt || null;
}

function buildNoteFingerprint(detail: KeepNoteDetail, text: string): NoteFingerprint {
  return {
    modifiedAt: noteModifiedAt(detail),
    contentHash: hashContent(text),
  };
}

function hasFingerprintChanged(previous: NoteFingerprint | undefined, next: NoteFingerprint): boolean {
  return !previous
    || previous.modifiedAt !== next.modifiedAt
    || previous.contentHash !== next.contentHash;
}

function hasMeaningfulContentChange(previous: NoteFingerprint | undefined, next: NoteFingerprint): boolean {
  return !previous || previous.contentHash !== next.contentHash;
}

export function classifyNotePage(page: { title?: string; id?: string }, text: string): { emit: boolean; reason: string } {
  if (!text.trim()) {
    return { emit: false, reason: 'empty text after note normalization' };
  }

  if (text.length < 5 && ((page.title || '').includes('Untitled') || !(page.title || '').trim())) {
    return { emit: false, reason: 'short untitled placeholder note' };
  }

  return { emit: true, reason: 'note contains enough content' };
}

async function getActiveProfile(): Promise<KeepAuthProfile | null> {
  return (await authStore.getActiveProfile()) || null;
}

async function runKeepBridge<T>(profile: KeepAuthProfile, action: string, input?: Record<string, unknown>): Promise<T> {
  const statePath = authStore.getStatePath(profile.id);
  return runBridge<T>({
    action,
    profile: bridgeProfileFromAuth(profile, statePath),
    input,
  });
}

async function getLatestNotes(profile: KeepAuthProfile, limit: number): Promise<KeepNoteSummary[]> {
  return runKeepBridge<KeepNoteSummary[]>(profile, 'list_notes', {
    limit,
    trashed: false,
  });
}

async function getNoteDetail(profile: KeepAuthProfile, noteId: string): Promise<KeepNoteDetail> {
  return runKeepBridge<KeepNoteDetail>(profile, 'get_note', { note: noteId });
}

function clearPendingTrigger(noteId: string): void {
  const pending = pendingTriggers.get(noteId);
  if (!pending) {
    return;
  }
  clearTimeout(pending.timeoutId);
  pendingTriggers.delete(noteId);
}

function clearAllPendingTriggers(): void {
  for (const noteId of pendingTriggers.keys()) {
    clearPendingTrigger(noteId);
  }
}

function buildLatestSnapshot(detail: KeepNoteDetail, text: string): Record<string, unknown> {
  return {
    id: detail.id,
    title: detail.title,
    logicalTitle: detail.logicalTitle,
    rawTitle: detail.rawTitle,
    owner: detail.owner,
    kind: detail.kind,
    text,
    items: detail.items || [],
    createdAt: detail.createdAt || null,
    modifiedAt: detail.updatedAt || null,
  };
}

async function refreshBaseline(profile: KeepAuthProfile): Promise<void> {
  clearAllPendingTriggers();
  knownNoteStates.clear();
  baselineProfileId = profile.id;

  const latestNotes = await getLatestNotes(profile, RECENT_LIMIT);
  if (latestNotes.length > 0) {
    for (const note of latestNotes) {
      try {
        const detail = await getNoteDetail(profile, note.id);
        const text = noteText(detail);
        knownNoteStates.set(note.id, buildNoteFingerprint(detail, text));
      } catch {
        // Ignore baseline hydration failures.
      }
    }
    console.log(`[Notes Sensor] Baseline initialized from ${latestNotes.length} recent Google Keep note(s). Existing notes are now tracked and will emit only after a later user edit settles.`);
  } else {
    console.log('[Notes Sensor] No recent Google Keep notes found. Sensor is ready for the next user-authored change.');
  }
}

function schedulePendingTrigger(detail: KeepNoteDetail, text: string, fingerprint: NoteFingerprint): void {
  const existing = pendingTriggers.get(detail.id);
  if (existing) {
    clearTimeout(existing.timeoutId);
  }

  const timeoutId = setTimeout(() => {
    void settlePendingTrigger(detail.id);
  }, STABLE_DELAY_MS);

  pendingTriggers.set(detail.id, {
    noteId: detail.id,
    title: detail.title,
    kind: detail.kind,
    owner: detail.owner,
    text,
    items: detail.items || [],
    createdAt: detail.createdAt || null,
    modifiedAt: detail.updatedAt || null,
    fingerprint,
    timeoutId,
  });

  const logAction = existing ? 'Reset stability wait for' : 'Queued stability wait for';
  console.log(`[Notes Sensor] ${logAction} ${describeNote(detail)} (${Math.floor(STABLE_DELAY_MS / 1000)}s retriggerable delay).`);
}

async function settlePendingTrigger(noteId: string): Promise<void> {
  const pending = pendingTriggers.get(noteId);
  if (!pending) {
    return;
  }

  try {
    const profile = await getActiveProfile();
    if (!profile || profile.id !== baselineProfileId) {
      clearPendingTrigger(noteId);
      return;
    }

    const detail = await getNoteDetail(profile, noteId);
    const text = noteText(detail);
    const fingerprint = buildNoteFingerprint(detail, text);

    if (shouldIgnoreSystemNote(detail)) {
      knownNoteStates.set(detail.id, fingerprint);
      clearPendingTrigger(noteId);
      console.log(`[Notes Sensor] Skipping ${describeNote(detail)} after stability wait: system-owned note.`);
      return;
    }

    const classification = classifyNotePage({ title: detail.title, id: detail.id }, text);
    if (!classification.emit) {
      knownNoteStates.set(detail.id, fingerprint);
      clearPendingTrigger(noteId);
      console.log(`[Notes Sensor] Skipping ${describeNote(detail)} after stability wait: ${classification.reason}.`);
      return;
    }

    if (hasMeaningfulContentChange(pending.fingerprint, fingerprint)) {
      console.log(`[Notes Sensor] ${describeNote(detail)} changed again during stability wait; extending delay.`);
      schedulePendingTrigger(detail, text, fingerprint);
      return;
    }

    const previous = knownNoteStates.get(detail.id);
    if (!hasMeaningfulContentChange(previous, fingerprint)) {
      knownNoteStates.set(detail.id, fingerprint);
      clearPendingTrigger(noteId);
      return;
    }

    latestNoteSnapshot = buildLatestSnapshot(detail, text);
    knownNoteStates.set(detail.id, fingerprint);
    clearPendingTrigger(noteId);

    console.log(`[Notes Sensor] Emitting newNote for ${describeNote(detail)} after stable content confirmation.`);

    emitFn?.({
      event: 'newNote',
      args: [],
      payload: latestNoteSnapshot,
      occurredAt: detail.updatedAt || detail.createdAt || new Date().toISOString(),
    });
  } catch (error: any) {
    clearPendingTrigger(noteId);
    console.error('[Notes Sensor] Error settling pending note:', error?.message || error);
  }
}

export async function start(emit: (event: Omit<HeartbeatSensorEvent, 'sensor'>) => void) {
  emitFn = emit;

  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }

  try {
    console.log('[Notes Sensor] Starting Google Keep polling sensor.');
    const profile = await getActiveProfile();
    if (!profile) {
      console.warn('[Notes Sensor] Google Keep is not authenticated yet. Sensor will keep polling and wait for a saved profile.');
    } else {
      await refreshBaseline(profile);
    }

    intervalId = setInterval(checkNewNotes, POLL_INTERVAL_MS);
    console.log(`[Notes Sensor] Poll interval armed for every ${Math.floor(POLL_INTERVAL_MS / 1000)} seconds.`);
  } catch (error) {
    console.error('[Notes Sensor] Failed to start:', error);
  }
}

export async function stop() {
  if (intervalId) {
    clearInterval(intervalId);
  }
  intervalId = null;
  emitFn = null;
  latestNoteSnapshot = null;
  baselineProfileId = null;
  pollInFlight = false;
  clearAllPendingTriggers();
  knownNoteStates.clear();
}

export async function getContext(): Promise<string> {
  if (!latestNoteSnapshot) {
    return 'No recent Google Keep note snapshot is available.';
  }
  return JSON.stringify(latestNoteSnapshot, null, 2);
}

export async function ask(input: SensorAskInput): Promise<unknown> {
  const context = await getContext();
  console.log('[Notes Sensor] .ask() request prompt:', input.prompt);
  console.log('[Notes Sensor] .ask() request schema:', formatLogValue(input.schema));
  console.log('[Notes Sensor] .ask() current snapshot:', context);

  try {
    const result = await structuredLlm([
      'You are answering questions about the most recent Google Keep note observed by the heartbeat notes sensor.',
      '',
      'Latest note snapshot:',
      context,
      '',
      'User request:',
      input.prompt,
    ].join('\n'), input.schema, input.imagePath);

    console.log('[Notes Sensor] .ask() response:', formatLogValue(result));
    return result;
  } catch (error) {
    if (schemaHasBooleanAndReasonFields(input.schema)) {
      const fallback = fallbackHomeworkClassification(input.prompt);
      if (fallback) {
        console.warn('[Notes Sensor] .ask() fell back to heuristic classification after structured LLM failure:', error);
        console.log('[Notes Sensor] .ask() fallback response:', formatLogValue(fallback));
        return fallback;
      }
    }
    throw error;
  }
}

async function checkNewNotes() {
  if (!emitFn || pollInFlight) {
    return;
  }

  pollInFlight = true;

  try {
    const profile = await getActiveProfile();
    if (!profile) {
      return;
    }

    if (baselineProfileId !== profile.id) {
      await refreshBaseline(profile);
      return;
    }

    const latestNotes = await getLatestNotes(profile, RECENT_LIMIT);
    let queuedCount = 0;

    for (const note of latestNotes) {
      const known = knownNoteStates.get(note.id);
      const summaryModifiedAt = noteModifiedAt(note);
      if (known && known.modifiedAt === summaryModifiedAt && !pendingTriggers.has(note.id)) {
        continue;
      }

      const detail = await getNoteDetail(profile, note.id);
      const text = noteText(detail);
      const fingerprint = buildNoteFingerprint(detail, text);
      const previous = knownNoteStates.get(detail.id);

      if (!hasMeaningfulContentChange(previous, fingerprint)) {
        knownNoteStates.set(detail.id, fingerprint);
        clearPendingTrigger(detail.id);
        continue;
      }

      if (shouldIgnoreSystemNote(detail)) {
        knownNoteStates.set(detail.id, fingerprint);
        clearPendingTrigger(detail.id);
        console.log(`[Notes Sensor] Skipping ${describeNote(detail)}: system-owned note.`);
        continue;
      }

      const classification = classifyNotePage({ title: detail.title, id: detail.id }, text);
      if (!classification.emit) {
        knownNoteStates.set(detail.id, fingerprint);
        clearPendingTrigger(detail.id);
        console.log(`[Notes Sensor] Skipping ${describeNote(detail)}: ${classification.reason}.`);
        continue;
      }

      schedulePendingTrigger(detail, text, fingerprint);
      queuedCount += 1;
    }

    if (queuedCount > 0 || pendingTriggers.size > 0) {
      console.log(`[Notes Sensor] Poll complete: ${latestNotes.length} note(s) scanned, ${queuedCount} note(s) queued/refreshed for stable-trigger confirmation, ${pendingTriggers.size} note(s) currently waiting.`);
    }
  } catch (error: any) {
    console.error('[Notes Sensor] Error checking notes:', error.message || error);
  } finally {
    pollInFlight = false;
  }
}

export const __internals = {
  buildNoteFingerprint,
  fallbackHomeworkClassification,
  hasFingerprintChanged,
  hasMeaningfulContentChange,
  noteModifiedAt,
  schemaHasBooleanAndReasonFields,
  noteText,
  shouldIgnoreSystemNote,
};

export {
  buildNoteFingerprint,
  hasFingerprintChanged,
  hasMeaningfulContentChange,
  noteModifiedAt,
  noteText,
  shouldIgnoreSystemNote,
};
