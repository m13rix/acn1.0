import { createHash } from 'crypto';
import { mkdir, readFile, readdir, rm, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join, resolve } from 'path';
import { fileURLToPath } from 'url';

import type { SessionSnapshot } from '../core/Session.js';

const ROOT_DIR = resolve(fileURLToPath(new URL('../../', import.meta.url)));
const DEFAULT_DATA_DIR = join(ROOT_DIR, 'data', 'chat-sessions');
const INDEX_FILE = join(DEFAULT_DATA_DIR, 'route-index.json');

export interface PersistedChatSessionState {
  version: 1;
  savedAt: string;
  sessionKey: string;
  agentName: string;
  runPath?: string;
  snapshot: SessionSnapshot;
}

export interface PersistedRouteSelection {
  agentName: string;
  runPath?: string;
  savedAt: string;
}

function getSessionFilePath(sessionKey: string, agentName: string): string {
  const digest = createHash('sha1')
    .update(JSON.stringify({ sessionKey, agentName, runPath: '' }))
    .digest('hex');
  return join(DEFAULT_DATA_DIR, `${digest}.json`);
}

function getLegacySessionFilePath(sessionKey: string, agentName: string, runPath?: string): string {
  const digest = createHash('sha1')
    .update(JSON.stringify({ sessionKey, agentName, runPath: runPath || '' }))
    .digest('hex');
  return join(DEFAULT_DATA_DIR, `${digest}.json`);
}

async function ensureDataDir(): Promise<void> {
  await mkdir(DEFAULT_DATA_DIR, { recursive: true });
}

async function readIndex(): Promise<Record<string, PersistedRouteSelection>> {
  try {
    const raw = await readFile(INDEX_FILE, 'utf-8');
    const parsed = JSON.parse(raw) as Record<string, PersistedRouteSelection>;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (error: any) {
    if (error?.code === 'ENOENT') {
      return {};
    }
    throw error;
  }
}

async function writeIndex(index: Record<string, PersistedRouteSelection>): Promise<void> {
  await ensureDataDir();
  await writeFile(INDEX_FILE, JSON.stringify(index, null, 2), 'utf-8');
}

export async function savePersistedChatSessionState(
  state: PersistedChatSessionState,
  options: { updateRouteSelection?: boolean } = {},
): Promise<void> {
  await ensureDataDir();
  const filePath = getSessionFilePath(state.sessionKey, state.agentName);
  await writeFile(filePath, JSON.stringify(state, null, 2), 'utf-8');
  const legacyFilePath = getLegacySessionFilePath(state.sessionKey, state.agentName, state.runPath);
  if (legacyFilePath !== filePath) {
    await rm(legacyFilePath, { force: true });
  }

  if (options.updateRouteSelection !== false) {
    const index = await readIndex();
    index[state.sessionKey] = {
      agentName: state.agentName,
      runPath: state.runPath,
      savedAt: state.savedAt,
    };
    await writeIndex(index);
  }
}

export async function readPersistedChatSessionState(
  sessionKey: string,
  agentName: string,
  runPath?: string,
): Promise<PersistedChatSessionState | null> {
  const filePaths = [
    getSessionFilePath(sessionKey, agentName),
    getLegacySessionFilePath(sessionKey, agentName, runPath),
  ];

  for (const filePath of filePaths) {
    try {
      const raw = await readFile(filePath, 'utf-8');
      const parsed = JSON.parse(raw) as Partial<PersistedChatSessionState>;
      if (parsed?.version !== 1 || typeof parsed.sessionKey !== 'string' || typeof parsed.agentName !== 'string' || !parsed.snapshot) {
        return null;
      }
      return parsed as PersistedChatSessionState;
    } catch (error: any) {
      if (error?.code === 'ENOENT') {
        continue;
      }
      throw error;
    }
  }

  return null;
}

export async function clearPersistedChatSessionState(
  sessionKey: string,
  agentName: string,
  runPath?: string,
  options: { clearRouteSelection?: boolean } = {},
): Promise<void> {
  const filePaths = [
    getSessionFilePath(sessionKey, agentName),
    getLegacySessionFilePath(sessionKey, agentName, runPath),
  ];
  await Promise.all(filePaths.map((filePath) => rm(filePath, { force: true })));

  if (options.clearRouteSelection !== false) {
    const index = await readIndex();
    const current = index[sessionKey];
    if (current && current.agentName === agentName && (current.runPath || '') === (runPath || '')) {
      delete index[sessionKey];
      await writeIndex(index);
    }
  }
}

export async function readPersistedRouteSelection(routeKey: string): Promise<PersistedRouteSelection | null> {
  const index = await readIndex();
  return index[routeKey] || null;
}

export async function savePersistedRouteSelection(
  routeKey: string,
  selection: PersistedRouteSelection,
): Promise<void> {
  const index = await readIndex();
  index[routeKey] = selection;
  await writeIndex(index);
}

export async function clearPersistedRouteSelection(routeKey: string): Promise<void> {
  const index = await readIndex();
  if (!(routeKey in index)) {
    return;
  }
  delete index[routeKey];
  await writeIndex(index);
}

export async function clearPersistedRouteSessions(routeKey: string): Promise<void> {
  if (!existsSync(DEFAULT_DATA_DIR)) {
    return;
  }

  const entries = await readdir(DEFAULT_DATA_DIR);
  await Promise.all(entries
    .filter((entry) => entry.endsWith('.json') && entry !== 'route-index.json')
    .map(async (entry) => {
      const filePath = join(DEFAULT_DATA_DIR, entry);
      try {
        const raw = await readFile(filePath, 'utf-8');
        const parsed = JSON.parse(raw) as Partial<PersistedChatSessionState>;
        if (parsed?.sessionKey === routeKey) {
          await rm(filePath, { force: true });
        }
      } catch {
        // Ignore malformed files during cleanup.
      }
    }));

  await clearPersistedRouteSelection(routeKey);
}

export const __internals = {
  DEFAULT_DATA_DIR,
  INDEX_FILE,
  getSessionFilePath,
  getLegacySessionFilePath,
  readIndex,
  writeIndex,
};
