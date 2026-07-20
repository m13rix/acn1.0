import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { lookup as lookupMime } from 'mime-types';
import { structuredLlm } from '../../../../src/utils/structuredLlm.js';
import type { HeartbeatSensorEvent, SensorAskInput } from '../../../../src/heartbeat/types.js';
import { ContentMemoryService } from '../../../../src/content_memory/service.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '..', '..', '..', '..');
const DATA_DIR = path.join(ROOT_DIR, 'data', 'heartbeat');
const STATE_PATH = path.join(DATA_DIR, 'notes-sensor-state.json');
const POLL_INTERVAL_MS = 60_000;
const NOTE_STABLE_DELAY_MS = 5 * 60_000;

type PendingKind = 'newNote' | 'noteUpdated';

export interface NoteFingerprint {
  modifiedAtMs: number;
  size: number;
  contentHash: string;
}

interface FileSnapshot {
  id: string;
  name: string;
  relativePath: string;
  path: string;
  extension: string;
  mimeType: string;
  isMarkdown: boolean;
  createdAt: string;
  modifiedAt: string;
  birthtimeMs: number;
  mtimeMs: number;
  size: number;
  contentHash: string;
}

interface PersistedFileState {
  fingerprint: NoteFingerprint;
  isMarkdown: boolean;
}

interface NotesSensorState {
  version: 1;
  vaultPath: string;
  initializedAt: string;
  knownFiles: Record<string, PersistedFileState>;
}

interface PendingNoteTrigger {
  kind: PendingKind;
  snapshot: FileSnapshot;
  timeoutId: NodeJS.Timeout;
}

let intervalId: NodeJS.Timeout | null = null;
let emitFn: ((event: Omit<HeartbeatSensorEvent, 'sensor'>) => void) | null = null;
let latestSnapshot: Record<string, unknown> | null = null;
let pollInFlight = false;
let state: NotesSensorState | null = null;
let sensorStartedAtMs = 0;

const knownFileStates: Map<string, PersistedFileState> = new Map();
const pendingNoteTriggers: Map<string, PendingNoteTrigger> = new Map();

function nowIso(): string {
  return new Date().toISOString();
}

function notesPath(): string {
  return ContentMemoryService.notesPath();
}

function normalizeRelativePath(filePath: string, vaultPath = notesPath()): string {
  return path.relative(vaultPath, filePath).replace(/\\/g, '/');
}

function isTechnicalPath(relativePath: string): boolean {
  const parts = relativePath.split(/[\\/]+/).map((part) => part.toLowerCase());
  const normalized = parts.join('/');
  return parts.some((part) =>
    part === '.obsidian'
    || part === '.git'
    || part === 'node_modules'
    || part === '.trash'
    || part === '.stfolder'
    || part === '.stversions'
    || part.endsWith('.tmp')
    || part.endsWith('.crdownload')
  )
    || normalized.startsWith('data/tool-output/')
    || normalized.startsWith('data/adaptive-step-context/')
    || /^exec_\d+\.cts$/i.test(parts.at(-1) || '')
    || /^action-observation-/i.test(parts.at(-1) || '');
}

function isMarkdownPath(filePath: string): boolean {
  return path.extname(filePath).toLowerCase() === '.md';
}

function hashContent(text: string | Buffer): string {
  const input = Buffer.isBuffer(text) ? text.toString('binary') : text;
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    hash = ((hash << 5) - hash) + input.charCodeAt(i);
    hash |= 0;
  }
  return hash.toString(36);
}

function getMimeType(filePath: string): string {
  return String(lookupMime(filePath) || 'application/octet-stream');
}

function fingerprintFromSnapshot(snapshot: FileSnapshot): NoteFingerprint {
  return {
    modifiedAtMs: snapshot.mtimeMs,
    size: snapshot.size,
    contentHash: snapshot.contentHash,
  };
}

function fingerprintsEqual(left?: NoteFingerprint, right?: NoteFingerprint): boolean {
  return Boolean(left
    && right
    && left.modifiedAtMs === right.modifiedAtMs
    && left.size === right.size
    && left.contentHash === right.contentHash);
}

function hasMeaningfulContentChange(previous: NoteFingerprint | undefined, next: NoteFingerprint): boolean {
  return !previous || previous.contentHash !== next.contentHash || previous.size !== next.size;
}

function isPreexistingAtStartup(snapshot: FileSnapshot, startedAtMs: number): boolean {
  if (!startedAtMs) {
    return false;
  }
  const graceMs = 2_000;
  return snapshot.birthtimeMs < startedAtMs - graceMs && snapshot.mtimeMs < startedAtMs - graceMs;
}

function classifyNotePage(page: { title?: string; id?: string }, text: string): { emit: boolean; reason: string } {
  if (!text.trim()) {
    return { emit: false, reason: 'empty text after note normalization' };
  }

  if (text.length < 5 && ((page.title || '').includes('Untitled') || !(page.title || '').trim())) {
    return { emit: false, reason: 'short untitled placeholder note' };
  }

  return { emit: true, reason: 'note contains enough content' };
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
  const title = extractPromptField(prompt, 'Название заметки') || extractPromptField(prompt, 'Note name');
  const text = extractPromptField(prompt, 'Текст заметки') || extractPromptField(prompt, 'Note contents');
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
  return signalCount >= 2
    ? {
      shouldHandle: true,
      reason: 'Fallback notes heuristic matched multiple school/homework signals in the note text.',
    }
    : {
      shouldHandle: false,
      reason: 'Fallback notes heuristic did not find enough school/homework signals in the note text.',
    };
}

async function readState(vaultPath: string): Promise<NotesSensorState | null> {
  try {
    const raw = await fs.promises.readFile(STATE_PATH, 'utf8');
    const parsed = JSON.parse(raw) as Partial<NotesSensorState>;
    if (parsed.version !== 1 || parsed.vaultPath !== vaultPath || !parsed.knownFiles) {
      return null;
    }
    return {
      version: 1,
      vaultPath,
      initializedAt: parsed.initializedAt || nowIso(),
      knownFiles: parsed.knownFiles,
    };
  } catch {
    return null;
  }
}

async function persistState(): Promise<void> {
  if (!state) return;
  await fs.promises.mkdir(DATA_DIR, { recursive: true });
  await fs.promises.writeFile(STATE_PATH, JSON.stringify({
    ...state,
    knownFiles: Object.fromEntries(knownFileStates),
  }, null, 2) + '\n', 'utf8');
}

async function readMarkdown(filePath: string): Promise<string> {
  return fs.promises.readFile(filePath, 'utf8');
}

async function snapshotFile(filePath: string, vaultPath = notesPath()): Promise<FileSnapshot | null> {
  const relativePath = normalizeRelativePath(filePath, vaultPath);
  if (!relativePath || relativePath.startsWith('..') || path.isAbsolute(relativePath) || isTechnicalPath(relativePath)) {
    return null;
  }

  const info = await fs.promises.stat(filePath).catch(() => null);
  if (!info?.isFile()) {
    return null;
  }

  const isMarkdown = isMarkdownPath(filePath);
  const content = isMarkdown
    ? await readMarkdown(filePath).catch(() => '')
    : await fs.promises.readFile(filePath).catch(() => Buffer.alloc(0));
  const extension = path.extname(filePath).toLowerCase();

  return {
    id: relativePath,
    name: path.basename(filePath),
    relativePath,
    path: filePath,
    extension,
    mimeType: isMarkdown ? 'text/markdown' : getMimeType(filePath),
    isMarkdown,
    createdAt: info.birthtime.toISOString(),
    modifiedAt: info.mtime.toISOString(),
    birthtimeMs: info.birthtimeMs,
    mtimeMs: info.mtimeMs,
    size: info.size,
    contentHash: hashContent(content),
  };
}

async function scanVault(vaultPath = notesPath()): Promise<FileSnapshot[]> {
  const out: FileSnapshot[] = [];

  async function walk(dir: string): Promise<void> {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const absolute = path.join(dir, entry.name);
      const relative = normalizeRelativePath(absolute, vaultPath);
      if (isTechnicalPath(relative)) continue;
      if (entry.isDirectory()) {
        await walk(absolute);
      } else if (entry.isFile()) {
        const snapshot = await snapshotFile(absolute, vaultPath);
        if (snapshot) out.push(snapshot);
      }
    }
  }

  await walk(vaultPath);
  return out;
}

function clearPendingTrigger(id: string): void {
  const pending = pendingNoteTriggers.get(id);
  if (!pending) return;
  clearTimeout(pending.timeoutId);
  pendingNoteTriggers.delete(id);
}

function clearAllPendingTriggers(): void {
  for (const id of pendingNoteTriggers.keys()) {
    clearPendingTrigger(id);
  }
}

function buildNotePayload(snapshot: FileSnapshot, contents: string): Record<string, unknown> {
  return {
    id: snapshot.id,
    name: snapshot.name,
    title: path.basename(snapshot.name, snapshot.extension),
    path: snapshot.path,
    relativePath: snapshot.relativePath,
    contents,
    createdAt: snapshot.createdAt,
    modifiedAt: snapshot.modifiedAt,
  };
}

function buildAttachmentPayload(snapshot: FileSnapshot): Record<string, unknown> {
  return {
    id: snapshot.id,
    name: snapshot.name,
    path: snapshot.path,
    relativePath: snapshot.relativePath,
    mimeType: snapshot.mimeType,
    createdAt: snapshot.createdAt,
    modifiedAt: snapshot.modifiedAt,
    size: snapshot.size,
  };
}

function scheduleNoteTrigger(kind: PendingKind, snapshot: FileSnapshot): boolean {
  const existing = pendingNoteTriggers.get(snapshot.id);
  if (existing && fingerprintsEqual(fingerprintFromSnapshot(existing.snapshot), fingerprintFromSnapshot(snapshot))) {
    return false;
  }
  if (existing) clearTimeout(existing.timeoutId);

  const timeoutId = setTimeout(() => {
    void settlePendingNote(snapshot.id);
  }, NOTE_STABLE_DELAY_MS);
  timeoutId.unref?.();

  pendingNoteTriggers.set(snapshot.id, {
    kind: existing?.kind || kind,
    snapshot,
    timeoutId,
  });

  console.log(`[Notes Sensor] Queued ${existing ? 'updated' : kind} debounce for ${snapshot.relativePath} (${Math.floor(NOTE_STABLE_DELAY_MS / 1000)}s).`);
  return true;
}

async function settlePendingNote(id: string): Promise<void> {
  const pending = pendingNoteTriggers.get(id);
  if (!pending || !emitFn) return;

  const snapshot = await snapshotFile(pending.snapshot.path).catch(() => null);
  if (!snapshot || !snapshot.isMarkdown) {
    clearPendingTrigger(id);
    return;
  }

  const pendingFingerprint = fingerprintFromSnapshot(pending.snapshot);
  const currentFingerprint = fingerprintFromSnapshot(snapshot);
  if (!fingerprintsEqual(pendingFingerprint, currentFingerprint)) {
      scheduleNoteTrigger(pending.kind, snapshot);
    return;
  }

  const contents = await readMarkdown(snapshot.path).catch(() => '');
  const classification = classifyNotePage({ title: snapshot.name, id: snapshot.id }, contents);
  knownFileStates.set(snapshot.id, {
    fingerprint: currentFingerprint,
    isMarkdown: true,
  });
  clearPendingTrigger(id);
  await persistState();

  if (!classification.emit) {
    console.log(`[Notes Sensor] Skipping ${snapshot.relativePath} after debounce: ${classification.reason}.`);
    return;
  }

  latestSnapshot = buildNotePayload(snapshot, contents);
  emitFn({
    event: pending.kind,
    args: [],
    payload: latestSnapshot,
    occurredAt: snapshot.modifiedAt || snapshot.createdAt || nowIso(),
  });
  console.log(`[Notes Sensor] Emitted ${pending.kind} for ${snapshot.relativePath}.`);
}

async function initializeBaseline(vaultPath: string): Promise<void> {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const persisted = await readState(vaultPath);
  if (persisted) {
    state = persisted;
    knownFileStates.clear();
    for (const [id, fileState] of Object.entries(persisted.knownFiles)) {
      knownFileStates.set(id, fileState);
    }
    console.log(`[Notes Sensor] Loaded Obsidian baseline with ${knownFileStates.size} tracked file(s).`);
    return;
  }

  const files = await scanVault(vaultPath);
  knownFileStates.clear();
  for (const file of files) {
    knownFileStates.set(file.id, {
      fingerprint: fingerprintFromSnapshot(file),
      isMarkdown: file.isMarkdown,
    });
  }
  state = {
    version: 1,
    vaultPath,
    initializedAt: nowIso(),
    knownFiles: Object.fromEntries(knownFileStates),
  };
  await persistState();
  console.log(`[Notes Sensor] Baseline initialized from ${files.length} existing Obsidian vault file(s). Existing files will not emit until changed.`);
}

export async function start(emit: (event: Omit<HeartbeatSensorEvent, 'sensor'>) => void) {
  emitFn = emit;
  sensorStartedAtMs = Date.now();
  const vaultPath = notesPath();

  try {
    console.log(`[Notes Sensor] Starting Obsidian vault polling sensor: ${vaultPath}`);
    await initializeBaseline(vaultPath);
    intervalId = setInterval(checkNotesDirectory, POLL_INTERVAL_MS);
    intervalId.unref?.();
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
  latestSnapshot = null;
  pollInFlight = false;
  state = null;
  sensorStartedAtMs = 0;
  clearAllPendingTriggers();
  knownFileStates.clear();
}

export async function getContext(): Promise<string> {
  if (!latestSnapshot) {
    return 'No recent Obsidian notes sensor snapshot is available.';
  }
  return JSON.stringify(latestSnapshot, null, 2);
}

export async function ask(input: SensorAskInput): Promise<unknown> {
  const context = await getContext();
  console.log('[Notes Sensor] .ask() request prompt:', input.prompt);
  console.log('[Notes Sensor] .ask() request schema:', formatLogValue(input.schema));
  console.log('[Notes Sensor] .ask() current snapshot:', context);

  try {
    const result = await structuredLlm([
      'You are answering questions about the most recent Obsidian notes event observed by the heartbeat notes sensor.',
      '',
      'Latest note or attachment snapshot:',
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

async function checkNotesDirectory() {
  if (!emitFn || pollInFlight) {
    return;
  }

  pollInFlight = true;
  try {
    const vaultPath = notesPath();
    if (!state || state.vaultPath !== vaultPath) {
      await initializeBaseline(vaultPath);
      return;
    }

    const files = await scanVault(vaultPath);
    const seen = new Set<string>();
    let queuedCount = 0;
    let attachmentCount = 0;
    let baselinedCount = 0;

    for (const file of files) {
      seen.add(file.id);
      const nextFingerprint = fingerprintFromSnapshot(file);
      const previous = knownFileStates.get(file.id);

      if (!previous) {
        if (isPreexistingAtStartup(file, sensorStartedAtMs)) {
          knownFileStates.set(file.id, { fingerprint: nextFingerprint, isMarkdown: file.isMarkdown });
          baselinedCount += 1;
          continue;
        }

        if (file.isMarkdown) {
          if (scheduleNoteTrigger('newNote', file)) {
            queuedCount += 1;
          }
        } else {
          knownFileStates.set(file.id, { fingerprint: nextFingerprint, isMarkdown: false });
          latestSnapshot = buildAttachmentPayload(file);
          emitFn({
            event: 'newAttachment',
            args: [],
            payload: latestSnapshot,
            occurredAt: file.createdAt || nowIso(),
          });
          attachmentCount += 1;
        }
        continue;
      }

      if (file.isMarkdown && hasMeaningfulContentChange(previous.fingerprint, nextFingerprint)) {
        if (scheduleNoteTrigger('noteUpdated', file)) {
          queuedCount += 1;
        }
      } else if (!file.isMarkdown && hasMeaningfulContentChange(previous.fingerprint, nextFingerprint)) {
        knownFileStates.set(file.id, { fingerprint: nextFingerprint, isMarkdown: false });
      }
    }

    for (const id of Array.from(knownFileStates.keys())) {
      if (!seen.has(id)) {
        knownFileStates.delete(id);
        clearPendingTrigger(id);
      }
    }

    await persistState();

    if (queuedCount > 0 || attachmentCount > 0 || baselinedCount > 0 || pendingNoteTriggers.size > 0) {
      console.log(`[Notes Sensor] Poll complete: ${files.length} file(s) scanned, ${queuedCount} note debounce(s), ${attachmentCount} attachment event(s), ${baselinedCount} pre-existing file(s) baselined, ${pendingNoteTriggers.size} note(s) waiting.`);
    }
  } catch (error: any) {
    console.error('[Notes Sensor] Error checking Obsidian notes:', error.message || error);
  } finally {
    pollInFlight = false;
  }
}

export const __internals = {
  buildAttachmentPayload,
  buildNotePayload,
  classifyNotePage,
  fallbackHomeworkClassification,
  fingerprintFromSnapshot,
  fingerprintsEqual,
  hasMeaningfulContentChange,
  hashContent,
  isPreexistingAtStartup,
  isMarkdownPath,
  isTechnicalPath,
  normalizeRelativePath,
};

export {
  buildAttachmentPayload,
  buildNotePayload,
  classifyNotePage,
  fingerprintFromSnapshot,
  fingerprintsEqual,
  hasMeaningfulContentChange,
  hashContent,
  isPreexistingAtStartup,
  isMarkdownPath,
  isTechnicalPath,
  normalizeRelativePath,
};
