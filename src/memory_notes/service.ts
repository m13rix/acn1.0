import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { fileURLToPath } from 'node:url';
import { KeepAuthStore, type KeepAuthProfile } from './auth-store.js';
import { bridgeProfileFromAuth, runBridge } from './bridge.js';

export interface NoteSummary {
  id: string;
  serverId?: string | null;
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

export interface ListItem {
  id: string;
  text: string;
  checked: boolean;
  sort?: number | null;
}

export interface NoteDetail extends NoteSummary {
  text: string;
  items?: ListItem[];
}

interface SyncResult {
  notes: number;
  lists: number;
  updatedAt: string;
}

interface LegacyNote {
  rawTitle?: string;
  title: string;
  content: string;
  createdAt: string;
  updatedAt: string;
}

interface LegacyStore {
  notes: LegacyNote[];
}

type ListInput = number | string | {
  limit?: number;
  q?: string;
  query?: string;
  kind?: 'note' | 'list';
  archived?: boolean;
  trashed?: boolean;
};

type PutInput = string | {
  note?: string;
  id?: string;
  title: string;
  text?: string;
  content?: string;
  kind?: 'note' | 'list';
  items?: Array<string | { text: string; checked?: boolean }>;
  owner?: 'system' | 'user' | 'owner';
  createOnly?: boolean;
};

type AppendInput = string | {
  note: string;
  text: string;
};

type PatchInput = string | {
  note: string;
  search: string;
  replace: string;
};

type CreateListInput = string | {
  title: string;
  items?: Array<string | { text: string; checked?: boolean }>;
  owner?: 'system' | 'user' | 'owner';
  createOnly?: boolean;
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const DATA_DIR = path.join(PROJECT_ROOT, 'data', 'memory-notes');
const LEGACY_STORE_PATH = path.join(DATA_DIR, 'notes.json');
const authStore = new KeepAuthStore(DATA_DIR);
const LEGACY_TITLE_SUFFIXES = [' (Telos)', ' (owner)'];
let authFlowPromise: Promise<KeepAuthProfile> | null = null;

function normalizeText(value: unknown): string {
  return String(value ?? '')
    .replace(/\\n/g, '\n')
    .replace(/\\t/g, '\t')
    .replace(/\\\\/g, '\\');
}

function trimText(value: unknown): string {
  return String(value ?? '').trim();
}

function createDeviceId(): string {
  return randomBytes(8).toString('hex');
}

function makeProfileId(email: string): string {
  return `google-keep:${email.trim().toLowerCase()}`;
}

function stripKnownSuffix(title: string): string {
  let normalized = trimText(title);
  for (const suffix of LEGACY_TITLE_SUFFIXES) {
    if (normalized.toLowerCase().endsWith(suffix.toLowerCase())) {
      normalized = normalized.slice(0, -suffix.length).trimEnd();
      break;
    }
  }
  return normalized;
}

function ensureTitle(title: string): string {
  const normalized = trimText(title);
  if (!normalized) {
    throw new Error('Note title must be a non-empty string.');
  }
  return normalized;
}

function normalizeListInput(input?: ListInput): Record<string, unknown> {
  if (typeof input === 'number') {
    return { limit: Math.max(1, Math.floor(input)) };
  }
  if (typeof input === 'string') {
    return { query: trimText(input) };
  }
  if (!input) {
    return {};
  }
  return {
    limit: typeof input.limit === 'number' ? Math.max(1, Math.floor(input.limit)) : undefined,
    query: trimText(input.query ?? input.q),
    kind: input.kind,
    archived: typeof input.archived === 'boolean' ? input.archived : undefined,
    trashed: typeof input.trashed === 'boolean' ? input.trashed : undefined,
  };
}

function normalizePutInput(input: PutInput, second?: string): Record<string, unknown> {
  if (typeof input === 'string') {
    return {
      title: ensureTitle(input),
      text: normalizeText(second),
      owner: 'system',
      kind: 'note',
      createOnly: false,
    };
  }

  return {
    note: trimText(input.note ?? input.id),
    title: ensureTitle(input.title),
    text: normalizeText(input.text ?? input.content),
    kind: input.kind || 'note',
    items: input.items,
    owner: input.owner || 'system',
    createOnly: Boolean(input.createOnly),
  };
}

function normalizeAppendInput(input: AppendInput, second?: string): Record<string, unknown> {
  if (typeof input === 'string') {
    return {
      note: trimText(input),
      text: normalizeText(second),
    };
  }
  return {
    note: trimText(input.note),
    text: normalizeText(input.text),
  };
}

function normalizePatchInput(input: PatchInput, search?: string, replace?: string): Record<string, unknown> {
  if (typeof input === 'string') {
    return {
      note: trimText(input),
      search: normalizeText(search),
      replace: normalizeText(replace),
    };
  }
  return {
    note: trimText(input.note),
    search: normalizeText(input.search),
    replace: normalizeText(input.replace),
  };
}

function normalizeCreateListInput(input: CreateListInput, items?: Array<string | { text: string; checked?: boolean }>) {
  if (typeof input === 'string') {
    return {
      title: ensureTitle(input),
      items: items || [],
      owner: 'system',
      kind: 'list',
      createOnly: true,
    };
  }

  return {
    title: ensureTitle(input.title),
    items: input.items || [],
    owner: input.owner || 'system',
    kind: 'list',
    createOnly: input.createOnly ?? true,
  };
}

async function sendApiRequest<T = unknown>(apiUrl: string, pathName: string, payload: Record<string, unknown>): Promise<T> {
  const response = await fetch(`${apiUrl}${pathName}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Memory notes auth request failed: ${response.status} ${text}`);
  }

  return response.json() as Promise<T>;
}

function getAuthApiContext(): { apiUrl?: string; routeId?: string } {
  const apiUrl = process.env.TELOS_INTERFACE_API_URL || process.env.TELOS_API_URL;
  const routeId = process.env.TELOS_INTERFACE_ROUTE || process.env.TELOS_CHAT_ID;
  return { apiUrl, routeId };
}

function isTelegramAuthContext(): boolean {
  const context = getAuthApiContext();
  return Boolean(context.apiUrl && context.routeId);
}

async function askTelegram(question: string): Promise<string> {
  const context = getAuthApiContext();
  if (!context.apiUrl || !context.routeId) {
    throw new Error('Telegram auth prompt is unavailable outside Telegram execution context.');
  }

  const result = await sendApiRequest<{ questionId?: string; status?: string; response?: string; error?: string }>(context.apiUrl, '/api/ask', {
    chatId: context.routeId,
    question,
  });

  if (result.status === 'answered' && typeof result.response === 'string') {
    return result.response;
  }

  if (!result.questionId) {
    throw new Error(result.error || 'Memory notes auth did not receive either a direct answer or questionId.');
  }

  for (;;) {
    await new Promise(resolve => setTimeout(resolve, 2000));
    const pollResponse = await fetch(`${context.apiUrl}/api/ask/poll?questionId=${encodeURIComponent(result.questionId)}`);
    if (!pollResponse.ok) {
      const text = await pollResponse.text().catch(() => '');
      throw new Error(`Memory notes auth poll failed: ${pollResponse.status} ${text}`);
    }
    const payload = await pollResponse.json() as { status: string; response?: string };
    if (payload.status === 'answered' && typeof payload.response === 'string') {
      return payload.response;
    }
  }
}

async function askConsole(question: string): Promise<string> {
  const rl = createInterface({ input, output });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}

async function promptForCredential(question: string): Promise<string> {
  if (isTelegramAuthContext()) {
    return askTelegram(question);
  }
  return askConsole(question);
}

async function persistProfile(email: string, masterToken: string, deviceId: string): Promise<KeepAuthProfile> {
  const profileId = makeProfileId(email);
  const statePath = authStore.getStatePath(profileId);
  const existingProfile = (await authStore.read()).profiles[profileId];

  await runBridge<SyncResult>({
    action: 'probe',
    profile: {
      email,
      masterToken,
      deviceId,
      statePath,
    },
    input: {},
  });

  const now = Date.now();
  const profile: KeepAuthProfile = {
    id: profileId,
    provider: 'google-keep',
    email,
    deviceId,
    masterToken,
    createdAt: existingProfile?.createdAt ?? now,
    updatedAt: now,
    lastSyncAt: now,
  };
  await authStore.upsertProfile(profile);
  return profile;
}

async function runInteractiveLogin(): Promise<KeepAuthProfile> {
  const email = ensureTitle(await promptForCredential(
    `Google Keep login required for memory.notes.\nEmail: `,
  ));
  const deviceId = createDeviceId();
  const password = await promptForCredential(
    `Google password or App Password for ${email}:\n`,
  );

  try {
    const result = await runBridge<{ masterToken: string }>({
      action: 'password_login',
      input: {
        email,
        password,
        deviceId,
      },
    });

    return persistProfile(email, result.masterToken, deviceId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const needsFallback = /BadAuthentication|App Password|oauth_token|gpsoauth master login failed/i.test(message);
    if (!needsFallback) {
      throw error;
    }

    const oauthToken = ensureTitle(await promptForCredential(
      [
        `Google blocked direct password login for ${email}.`,
        'Open the EmbeddedSetup sign-in flow, copy the oauth_token, and paste it here.',
        'oauth_token:',
      ].join('\n'),
    ));

    const result = await runBridge<{ masterToken: string }>({
      action: 'exchange_token',
      input: {
        email,
        oauthToken,
        deviceId,
      },
    });

    return persistProfile(email, result.masterToken, deviceId);
  }
}

async function getRequiredProfile(): Promise<KeepAuthProfile> {
  const profile = await authStore.getActiveProfile();
  if (profile) {
    return profile;
  }

  if (!authFlowPromise) {
    authFlowPromise = runInteractiveLogin().finally(() => {
      authFlowPromise = null;
    });
  }

  return authFlowPromise;
}

async function withProfile<T>(action: string, input?: Record<string, unknown>): Promise<T> {
  const profile = await getRequiredProfile();
  const statePath = authStore.getStatePath(profile.id);
  const result = await runBridge<T>({
    action,
    profile: bridgeProfileFromAuth(profile, statePath),
    input,
  });

  await authStore.upsertProfile({
    ...profile,
    updatedAt: Date.now(),
    lastSyncAt: Date.now(),
  });

  return result;
}

export async function sync(): Promise<SyncResult> {
  return withProfile<SyncResult>('sync');
}

export async function list(input?: ListInput): Promise<NoteSummary[]> {
  return withProfile<NoteSummary[]>('list_notes', normalizeListInput(input));
}

export async function find(query: string, input?: number | Omit<Exclude<ListInput, number | string>, 'query' | 'q'>): Promise<NoteSummary[]> {
  if (typeof input === 'number') {
    return list({ query, limit: input });
  }
  return list({ ...(input || {}), query });
}

export const search = find;

export async function get(note: string): Promise<NoteDetail> {
  return withProfile<NoteDetail>('get_note', { note: trimText(note) });
}

export async function put(input: PutInput, text?: string): Promise<NoteDetail> {
  return withProfile<NoteDetail>('put_note', normalizePutInput(input, text));
}

export async function append(input: AppendInput, text?: string): Promise<NoteDetail> {
  return withProfile<NoteDetail>('append_note', normalizeAppendInput(input, text));
}

export async function patch(input: PatchInput, search?: string, replace?: string): Promise<NoteDetail> {
  return withProfile<NoteDetail>('patch_note', normalizePatchInput(input, search, replace));
}

export async function remove(note: string): Promise<NoteDetail> {
  return withProfile<NoteDetail>('remove_note', { note: trimText(note) });
}

export async function archive(note: string, archived = true): Promise<NoteDetail> {
  return withProfile<NoteDetail>('set_flags', { note: trimText(note), archived: Boolean(archived) });
}

export async function pin(note: string, pinned = true): Promise<NoteDetail> {
  return withProfile<NoteDetail>('set_flags', { note: trimText(note), pinned: Boolean(pinned) });
}

export async function restore(note: string): Promise<NoteDetail> {
  return withProfile<NoteDetail>('set_flags', { note: trimText(note), restore: true });
}

export async function createList(input: CreateListInput, items?: Array<string | { text: string; checked?: boolean }>): Promise<NoteDetail> {
  return withProfile<NoteDetail>('put_note', normalizeCreateListInput(input, items));
}

export async function itemAdd(note: string, text: string, checked = false): Promise<NoteDetail> {
  return withProfile<NoteDetail>('add_item', {
    note: trimText(note),
    text: normalizeText(text),
    checked: Boolean(checked),
  });
}

export async function itemCheck(note: string, item: string, checked = true): Promise<NoteDetail> {
  return withProfile<NoteDetail>('check_item', {
    note: trimText(note),
    item: trimText(item),
    checked: Boolean(checked),
  });
}

export async function itemRemove(note: string, item: string): Promise<NoteDetail> {
  return withProfile<NoteDetail>('remove_item', {
    note: trimText(note),
    item: trimText(item),
  });
}

async function listLegacyNotes(): Promise<LegacyNote[]> {
  try {
    const raw = await fs.readFile(LEGACY_STORE_PATH, 'utf8');
    const parsed = JSON.parse(raw) as Partial<LegacyStore>;
    const notes = Array.isArray(parsed.notes) ? parsed.notes : [];
    return notes
      .filter((note): note is LegacyNote => Boolean(note && typeof note.title === 'string' && typeof note.content === 'string'))
      .map(note => ({
        rawTitle: note.title,
        title: stripKnownSuffix(note.title),
        content: note.content,
        createdAt: typeof note.createdAt === 'string' ? note.createdAt : new Date(0).toISOString(),
        updatedAt: typeof note.updatedAt === 'string' ? note.updatedAt : new Date(0).toISOString(),
      }))
      .filter(note => note.title.length > 0);
  } catch {
    return [];
  }
}

export async function migrateLegacyNotes(options?: { dryRun?: boolean; force?: boolean; onlySystem?: boolean }) {
  const legacyNotes = await listLegacyNotes();
  const onlySystem = options?.onlySystem ?? true;
  const candidates = legacyNotes.filter(note => !onlySystem || !String(note.rawTitle || '').toLowerCase().endsWith(' (owner)'));
  const created: string[] = [];
  const skipped: string[] = [];
  const updated: string[] = [];

  for (const note of candidates) {
    let exact: NoteDetail | undefined;
    try {
      exact = await get(note.title);
    } catch {
      exact = undefined;
    }

    if (options?.dryRun) {
      (exact ? skipped : created).push(note.title);
      continue;
    }

    if (exact && !options?.force) {
      skipped.push(note.title);
      continue;
    }

    await put({
      note: exact?.id,
      title: note.title,
      text: note.content,
      owner: 'system',
      createOnly: false,
    });

    if (exact) {
      updated.push(note.title);
    } else {
      created.push(note.title);
    }
  }

  return {
    source: LEGACY_STORE_PATH,
    totalLegacyNotes: legacyNotes.length,
    migratedCandidates: candidates.length,
    created,
    updated,
    skipped,
  };
}

export async function listNotes(): Promise<string[]> {
  const notes = await list({ archived: false, trashed: false });
  return notes
    .map(note => note.logicalTitle)
    .sort((left, right) => left.localeCompare(right));
}

export async function addNote(title: string, content: string): Promise<string> {
  await put({
    title,
    text: content,
    owner: 'system',
    createOnly: true,
  });
  return `Created note "${stripKnownSuffix(title)}".`;
}

export async function viewNote(title: string): Promise<string> {
  const note = await get(title);
  return note.text;
}

export async function editNote(title: string, search: string, replace: string): Promise<string> {
  await patch(title, search, replace);
  return `Updated note "${stripKnownSuffix(title)}".`;
}

export {
  normalizeListInput,
  stripKnownSuffix,
};
