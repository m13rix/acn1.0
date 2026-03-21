import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { structuredLlm } from '../../../../src/utils/structuredLlm.js';
import type { HeartbeatSensorEvent, SensorAskInput } from '../../../../src/heartbeat/types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '..', '..', '..', '..');
const DATA_DIR = path.join(ROOT_DIR, 'data', 'heartbeat');
const TOKEN_FILE = path.join(DATA_DIR, 'onenote_token.json');

const TENANT = 'consumers';
const SCOPES = ['Notes.Read', 'offline_access'];
let CLIENT_ID = process.env.ONENOTE_CLIENT_ID || '';

let intervalId: NodeJS.Timeout | null = null;
let emitFn: ((event: Omit<HeartbeatSensorEvent, 'sensor'>) => void) | null = null;
let currentToken: any = null;
let lastKnownModifiedTime: string | null = null;
let latestNoteSnapshot: Record<string, unknown> | null = null;

const processedContentHashes: Map<string, string> = new Map();

function hashContent(text: string): string {
  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    const chr = text.charCodeAt(i);
    hash = ((hash << 5) - hash) + chr;
    hash |= 0;
  }
  return hash.toString(36);
}

function describePage(page: { title?: string; id?: string }): string {
  const title = typeof page.title === 'string' && page.title.trim() ? page.title.trim() : '(untitled)';
  const suffix = typeof page.id === 'string' && page.id ? ` [${page.id}]` : '';
  return `${title}${suffix}`;
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

export function classifyNotePage(page: { title?: string; id?: string }, text: string): { emit: boolean; reason: string } {
  if (!text.trim()) {
    return { emit: false, reason: 'empty text after HTML stripping' };
  }

  if (text.length < 5 && ((page.title || '').includes('Untitled') || !(page.title || '').trim())) {
    return { emit: false, reason: 'short untitled placeholder page' };
  }

  return { emit: true, reason: 'page contains enough note content' };
}

export async function start(emit: (event: Omit<HeartbeatSensorEvent, 'sensor'>) => void) {
  emitFn = emit;

  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }

  CLIENT_ID = (process.env.ONENOTE_CLIENT_ID || '').replace('api://', '');
  if (!CLIENT_ID) {
    console.error('[Notes Sensor] ONENOTE_CLIENT_ID is not set.');
    return;
  }

  try {
    console.log('[Notes Sensor] Starting OneNote polling sensor.');
    await ensureAuthenticated();
    const latestPages = await getLatestPages(5);
    if (latestPages.length > 0) {
      lastKnownModifiedTime = latestPages[0].lastModifiedDateTime;
      for (const page of latestPages) {
        try {
          const html = await getPageContent(page.contentUrl);
          const text = stripHtml(html);
          processedContentHashes.set(page.id, hashContent(text));
        } catch {
          // Ignore baseline hydration failures.
        }
      }
      console.log(`[Notes Sensor] Baseline initialized from ${latestPages.length} recent page(s). Existing pages at or before ${lastKnownModifiedTime} will not emit.`);
    } else {
      lastKnownModifiedTime = new Date().toISOString();
      console.log(`[Notes Sensor] No recent pages found. Baseline starts at ${lastKnownModifiedTime}.`);
    }

    intervalId = setInterval(checkNewNotes, 60000);
    console.log('[Notes Sensor] Poll interval armed for every 60 seconds.');
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
  processedContentHashes.clear();
}

export async function getContext(): Promise<string> {
  if (!latestNoteSnapshot) {
    return 'No recent note snapshot is available.';
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
      'You are answering questions about the most recent OneNote note observed by the heartbeat notes sensor.',
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
  if (!emitFn || !lastKnownModifiedTime) {
    return;
  }

  try {
    await ensureAuthenticated();
    const latestPages = await getLatestPages(10);
    const newPages = latestPages.filter(page => page.lastModifiedDateTime > lastKnownModifiedTime!);

    console.log(`[Notes Sensor] Poll complete: ${latestPages.length} page(s) scanned, ${newPages.length} new/updated page(s) after ${lastKnownModifiedTime}.`);

    if (newPages.length === 0) {
      return;
    }

    lastKnownModifiedTime = newPages[0].lastModifiedDateTime;

    for (const page of newPages.reverse()) {
      const contentHtml = await getPageContent(page.contentUrl);
      const text = stripHtml(contentHtml);

      const classification = classifyNotePage(page, text);
      if (!classification.emit) {
        console.log(`[Notes Sensor] Skipping ${describePage(page)}: ${classification.reason}.`);
        continue;
      }

      const contentHash = hashContent(text);
      if (processedContentHashes.get(page.id) === contentHash) {
        console.log(`[Notes Sensor] Skipping ${describePage(page)}: content hash already processed.`);
        continue;
      }
      processedContentHashes.set(page.id, contentHash);

      latestNoteSnapshot = {
        id: page.id,
        title: page.title,
        text,
        createdAt: page.createdDateTime || null,
        modifiedAt: page.lastModifiedDateTime || null,
        contentUrl: page.contentUrl,
      };

      console.log(`[Notes Sensor] Emitting newNote for ${describePage(page)}.`);

      emitFn({
        event: 'newNote',
        args: [],
        payload: latestNoteSnapshot,
        occurredAt: page.lastModifiedDateTime || new Date().toISOString(),
      });

      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  } catch (error: any) {
    console.error('[Notes Sensor] Error checking notes:', error.message || error);
  }
}

async function getLatestPages(limit: number): Promise<any[]> {
  const url = `https://graph.microsoft.com/v1.0/me/onenote/pages?orderBy=lastModifiedDateTime%20desc&$top=${limit}`;
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${currentToken.access_token}`,
    },
  });

  if (!response.ok) {
    throw new Error(`Graph API Error: ${response.status} ${response.statusText}`);
  }

  const data = await response.json();
  return data.value || [];
}

async function getPageContent(contentUrl: string): Promise<string> {
  const response = await fetch(contentUrl, {
    headers: {
      Authorization: `Bearer ${currentToken.access_token}`,
    },
  });

  if (!response.ok) {
    throw new Error(`Graph API Error fetching content: ${response.status} ${response.statusText}`);
  }

  return response.text();
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]*>?/gm, ' ').replace(/\s+/g, ' ').trim();
}

async function ensureAuthenticated() {
  if (currentToken && !isTokenExpired(currentToken)) {
    return;
  }

  if (fs.existsSync(TOKEN_FILE)) {
    const stored = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf-8'));
    if (!isTokenExpired(stored)) {
      currentToken = stored;
      return;
    }
    if (stored.refresh_token) {
      try {
        await refreshToken(stored.refresh_token);
        return;
      } catch {
        // Fall back to device login.
      }
    }
  }

  await loginWithDeviceCode();
}

function isTokenExpired(token: any): boolean {
  if (!token.expires_on) {
    return true;
  }

  let expiresAt = 0;
  if (typeof token.expires_in === 'number' && token.obtained_at) {
    expiresAt = token.obtained_at + (token.expires_in * 1000);
  } else if (typeof token.expires_on === 'number') {
    expiresAt = token.expires_on * 1000;
  } else {
    return true;
  }

  return Date.now() > (expiresAt - 300000);
}

async function refreshToken(refreshTokenValue: string) {
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    grant_type: 'refresh_token',
    refresh_token: refreshTokenValue,
    scope: SCOPES.join(' '),
  });

  const response = await fetch(`https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });

  if (!response.ok) {
    throw new Error(`Refresh failed: ${await response.text()}`);
  }

  const data = await response.json();
  data.obtained_at = Date.now();
  currentToken = data;
  fs.writeFileSync(TOKEN_FILE, JSON.stringify(data, null, 2));
}

async function loginWithDeviceCode() {
  const deviceCodeParams = new URLSearchParams({
    client_id: CLIENT_ID,
    scope: SCOPES.join(' '),
  });

  const deviceCodeResponse = await fetch(`https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/devicecode`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: deviceCodeParams.toString(),
  });

  if (!deviceCodeResponse.ok) {
    throw new Error(`Device code request failed: ${await deviceCodeResponse.text()}`);
  }

  const deviceData = await deviceCodeResponse.json();
  console.log(`[Notes Sensor] ${deviceData.message}`);

  const tokenParams = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    client_id: CLIENT_ID,
    device_code: deviceData.device_code,
  });

  while (true) {
    await new Promise(resolve => setTimeout(resolve, deviceData.interval * 1000));

    const tokenResponse = await fetch(`https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: tokenParams.toString(),
    });

    const tokenData = await tokenResponse.json();

    if (tokenResponse.ok) {
      tokenData.obtained_at = Date.now();
      currentToken = tokenData;
      fs.writeFileSync(TOKEN_FILE, JSON.stringify(tokenData, null, 2));
      console.log('[Notes Sensor] Authentication successful.');
      return;
    }

    if (tokenData.error !== 'authorization_pending') {
      throw new Error(`Login failed: ${JSON.stringify(tokenData)}`);
    }
  }
}

export const __internals = {
  fallbackHomeworkClassification,
  schemaHasBooleanAndReasonFields,
};
