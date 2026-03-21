import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

type StoredNote = {
  title: string;
  content: string;
  createdAt: string;
  updatedAt: string;
};

type NotesStore = {
  notes: StoredNote[];
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STORE_DIR = path.resolve(__dirname, '..', '..', 'data', 'notepad');
const STORE_PATH = path.join(STORE_DIR, 'notes.json');

function normalizeTitle(title: string): string {
  const normalized = title.trim();
  if (!normalized) {
    throw new Error('Note title must be a non-empty string.');
  }
  return normalized;
}

function decodeEscapedValue(value: string): string {
  return value
    .replace(/\\n/g, '\n')
    .replace(/\\t/g, '\t')
    .replace(/\\\\/g, '\\');
}

async function ensureStore(): Promise<void> {
  await fs.mkdir(STORE_DIR, { recursive: true });
  try {
    await fs.access(STORE_PATH);
  } catch {
    const initialStore: NotesStore = { notes: [] };
    await fs.writeFile(STORE_PATH, JSON.stringify(initialStore, null, 2), 'utf8');
  }
}

async function readStore(): Promise<NotesStore> {
  await ensureStore();
  const raw = await fs.readFile(STORE_PATH, 'utf8');
  const parsed = JSON.parse(raw) as Partial<NotesStore>;
  const notes = Array.isArray(parsed.notes) ? parsed.notes : [];
  return {
    notes: notes
      .filter((note): note is StoredNote => !!note && typeof note.title === 'string' && typeof note.content === 'string')
      .map((note) => ({
        title: note.title,
        content: note.content,
        createdAt: typeof note.createdAt === 'string' ? note.createdAt : new Date(0).toISOString(),
        updatedAt: typeof note.updatedAt === 'string' ? note.updatedAt : new Date(0).toISOString(),
      })),
  };
}

async function writeStore(store: NotesStore): Promise<void> {
  await ensureStore();
  await fs.writeFile(STORE_PATH, JSON.stringify(store, null, 2), 'utf8');
}

function findNoteIndex(notes: StoredNote[], title: string): number {
  return notes.findIndex((note) => note.title.toLowerCase() === title.toLowerCase());
}

function normalizeSearch(search: string): string {
  const normalized = decodeEscapedValue(String(search ?? ''));
  if (!normalized) {
    throw new Error('Search text must not be empty.');
  }
  return normalized;
}

function normalizeReplace(replace: string): string {
  return decodeEscapedValue(String(replace ?? ''));
}

export async function listNotes(): Promise<string[]> {
  const store = await readStore();
  return store.notes
    .map((note) => note.title)
    .sort((left, right) => left.localeCompare(right));
}

export async function addNote(title: string, content: string): Promise<string> {
  const normalizedTitle = normalizeTitle(title);
  const store = await readStore();

  if (findNoteIndex(store.notes, normalizedTitle) !== -1) {
    throw new Error(`A note named "${normalizedTitle}" already exists.`);
  }

  const now = new Date().toISOString();
  store.notes.push({
    title: normalizedTitle,
    content: String(content ?? ''),
    createdAt: now,
    updatedAt: now,
  });

  await writeStore(store);
  return `Created note "${normalizedTitle}".`;
}

export async function viewNote(title: string): Promise<string> {
  const normalizedTitle = normalizeTitle(title);
  const store = await readStore();
  const noteIndex = findNoteIndex(store.notes, normalizedTitle);

  if (noteIndex === -1) {
    throw new Error(`Note "${normalizedTitle}" was not found.`);
  }

  return store.notes[noteIndex]!.content;
}

export async function editNote(title: string, search: string, replace: string): Promise<string> {
  const normalizedTitle = normalizeTitle(title);
  const normalizedSearch = normalizeSearch(search);
  const normalizedReplace = normalizeReplace(replace);
  const store = await readStore();
  const noteIndex = findNoteIndex(store.notes, normalizedTitle);

  if (noteIndex === -1) {
    throw new Error(`Note "${normalizedTitle}" was not found.`);
  }

  const note = store.notes[noteIndex]!;
  const occurrences = note.content.split(normalizedSearch).length - 1;

  if (occurrences === 0) {
    throw new Error(`Search text was not found in note "${normalizedTitle}".`);
  }

  if (occurrences > 1) {
    throw new Error(
      `Search text matched ${occurrences} times in note "${normalizedTitle}". Make the search text more specific.`,
    );
  }

  note.content = note.content.replace(normalizedSearch, normalizedReplace);
  note.updatedAt = new Date().toISOString();
  store.notes[noteIndex] = note;

  await writeStore(store);
  return `Updated note "${normalizedTitle}".`;
}
