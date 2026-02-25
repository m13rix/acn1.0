/**
 * Microsoft OneNote Sensor
 * 
 * Monitors the user's OneNote for new/modified pages and triggers an event.
 * Uses content-hash deduplication to prevent double-triggers on the same note.
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '..', '..', '..', '..');
const DATA_DIR = path.join(ROOT_DIR, 'data', 'heartbeat');
const TOKEN_FILE = path.join(DATA_DIR, 'onenote_token.json');

// Configuration
const TENANT = 'consumers';
const SCOPES = ['Notes.Read', 'offline_access'];
let CLIENT_ID = process.env.ONENOTE_CLIENT_ID || '';

let intervalId: NodeJS.Timeout | null = null;
let emitFn: ((event: string, payload?: any) => void) | null = null;
let currentToken: any = null;
let lastKnownModifiedTime: string | null = null;
let currentNoteContent: string = '';

/**
 * Deduplication map: pageId -> hash of last processed content.
 * Prevents re-triggering on the same note when OneNote bumps
 * lastModifiedDateTime from background syncs without actual content changes.
 */
const processedContentHashes: Map<string, string> = new Map();

/** Simple fast string hash for content deduplication */
function hashContent(text: string): string {
    let hash = 0;
    for (let i = 0; i < text.length; i++) {
        const chr = text.charCodeAt(i);
        hash = ((hash << 5) - hash) + chr;
        hash |= 0;
    }
    return hash.toString(36);
}

export const events = {
    newNote: () => `events.newNote()`
};

export async function start(emit: (event: string, payload?: any) => void) {
    console.log('[Notes Sensor] Sensor starting...');
    emitFn = emit;

    if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
    }

    CLIENT_ID = (process.env.ONENOTE_CLIENT_ID || '').replace('api://', '');
    if (!CLIENT_ID) {
        console.error('[Notes Sensor] ERROR: ONENOTE_CLIENT_ID is not set in environment.');
        return;
    }

    try {
        await ensureAuthenticated();
        // Initial fetch to set the baseline
        const latestPages = await getLatestPages(5);
        if (latestPages && latestPages.length > 0) {
            lastKnownModifiedTime = latestPages[0].lastModifiedDateTime;
            console.log(`[Notes Sensor] Baseline set to page: ${latestPages[0].title} (Modified: ${lastKnownModifiedTime})`);

            // Pre-populate hashes for existing pages so they don't trigger on first real poll
            for (const page of latestPages) {
                try {
                    const html = await getPageContent(page.contentUrl);
                    const text = stripHtml(html);
                    processedContentHashes.set(page.id, hashContent(text));
                } catch { /* ignore baseline errors */ }
            }
        } else {
            lastKnownModifiedTime = new Date().toISOString();
        }

        // Poll every 60 seconds
        intervalId = setInterval(checkNewNotes, 60000);
        console.log('[Notes Sensor] Started polling OneNote.');
    } catch (error) {
        console.error('[Notes Sensor] Failed to start:', error);
    }
}

export async function stop() {
    if (intervalId) clearInterval(intervalId);
    intervalId = null;
    emitFn = null;
    processedContentHashes.clear();
    console.log('[Notes Sensor] Stopped.');
}

export async function getContext(): Promise<string> {
    return currentNoteContent;
}

export async function onTaskExecuted(taskId: string) {
    // Context is left intact until a genuinely new/changed note overwrites it.
}

async function checkNewNotes() {
    if (!emitFn || !lastKnownModifiedTime) return;
    try {
        await ensureAuthenticated();
        const latestPages = await getLatestPages(10);

        if (latestPages && latestPages.length > 0) {
            // Filter pages modified after our last known time
            const newPages = latestPages.filter(p => p.lastModifiedDateTime > lastKnownModifiedTime!);

            if (newPages.length > 0) {
                lastKnownModifiedTime = newPages[0].lastModifiedDateTime;

                // Process oldest first
                for (const page of newPages.reverse()) {
                    const contentHtml = await getPageContent(page.contentUrl);
                    const text = stripHtml(contentHtml);

                    // Skip empty / untitled notes
                    if (text.length < 5 && (page.title.includes('Untitled') || page.title.trim() === '')) {
                        console.log(`[Notes Sensor] Skipping empty/untitled note: "${page.title}"`);
                        continue;
                    }

                    // Deduplication: skip if content hash is identical to last processed
                    const contentHash = hashContent(text);
                    const prevHash = processedContentHashes.get(page.id);
                    if (prevHash === contentHash) {
                        console.log(`[Notes Sensor] Skipping duplicate trigger for "${page.title}" (content unchanged).`);
                        continue;
                    }
                    processedContentHashes.set(page.id, contentHash);

                    currentNoteContent = text;
                    console.log(`[Notes Sensor] Note changed: "${page.title}" | Context: ${currentNoteContent.length} chars`);
                    emitFn('events.newNote()');

                    // Small delay so Heartbeat can pull context before we overwrite it
                    await new Promise(r => setTimeout(r, 2000));
                }
            }
        }
    } catch (e: any) {
        console.error('[Notes Sensor] Error checking notes:', e.message);
    }
}

async function getLatestPages(limit: number): Promise<any[]> {
    const url = `https://graph.microsoft.com/v1.0/me/onenote/pages?orderBy=lastModifiedDateTime%20desc&$top=${limit}`;
    const response = await fetch(url, {
        headers: {
            'Authorization': `Bearer ${currentToken.access_token}`
        }
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
            'Authorization': `Bearer ${currentToken.access_token}`
        }
    });

    if (!response.ok) {
        throw new Error(`Graph API Error fetching content: ${response.status} ${response.statusText}`);
    }

    const html = await response.text();
    return html;
}

function stripHtml(html: string): string {
    return html.replace(/<[^>]*>?/gm, ' ').replace(/\s+/g, ' ').trim();
}

// ==========================================
// Authentication Logic (Device Code Flow)
// ==========================================

async function ensureAuthenticated() {
    if (currentToken && !isTokenExpired(currentToken)) {
        return;
    }

    if (fs.existsSync(TOKEN_FILE)) {
        const stored = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf-8'));
        if (!isTokenExpired(stored)) {
            currentToken = stored;
            return;
        } else if (stored.refresh_token) {
            // Try refresh
            try {
                await refreshToken(stored.refresh_token);
                return;
            } catch (e) {
                console.warn('[Notes Sensor] Refresh token failed, falling back to device flow.');
            }
        }
    }

    // Require new login
    await loginWithDeviceCode();
}

function isTokenExpired(token: any): boolean {
    if (!token.expires_on) return true;
    let expiresAt = 0;
    if (typeof token.expires_in === 'number' && token.obtained_at) {
        expiresAt = token.obtained_at + (token.expires_in * 1000);
    } else if (typeof token.expires_on === 'number') {
        expiresAt = token.expires_on * 1000;
    } else {
        return true;
    }
    // Add 5 minute buffer
    return Date.now() > (expiresAt - 300000);
}

async function refreshToken(refresh_token: string) {
    const params = new URLSearchParams({
        client_id: CLIENT_ID,
        grant_type: 'refresh_token',
        refresh_token: refresh_token,
        scope: SCOPES.join(' ')
    });

    const res = await fetch(`https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params.toString()
    });

    if (!res.ok) {
        throw new Error(`Refresh failed: ${await res.text()}`);
    }

    const data = await res.json();
    data.obtained_at = Date.now();
    currentToken = data;
    fs.writeFileSync(TOKEN_FILE, JSON.stringify(data, null, 2));
}

async function loginWithDeviceCode() {
    console.log('[Notes Sensor] Initiating Device Code Flow...');

    const params = new URLSearchParams({
        client_id: CLIENT_ID,
        scope: SCOPES.join(' ')
    });

    const initRes = await fetch(`https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/devicecode`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params.toString()
    });

    if (!initRes.ok) throw new Error(`Device code init failed: ${await initRes.text()}`);

    const deviceData = await initRes.json();
    console.log('\n======================================================');
    console.log('To sign in, use a web browser to open the page:');
    console.log(`  >>>  ${deviceData.verification_uri}  <<<`);
    console.log('and enter the code:');
    console.log(`  >>>  ${deviceData.user_code}  <<<`);
    console.log('to authenticate.');
    console.log('======================================================\n');

    const expiresAt = Date.now() + (deviceData.expires_in * 1000);
    const interval = deviceData.interval * 1000 || 5000;

    while (Date.now() < expiresAt) {
        await new Promise(r => setTimeout(r, interval));

        const pollParams = new URLSearchParams({
            grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
            client_id: CLIENT_ID,
            device_code: deviceData.device_code
        });

        const pollRes = await fetch(`https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: pollParams.toString()
        });

        if (pollRes.ok) {
            const tokenData = await pollRes.json();
            tokenData.obtained_at = Date.now();
            currentToken = tokenData;
            fs.writeFileSync(TOKEN_FILE, JSON.stringify(tokenData, null, 2));
            console.log('[Notes Sensor] Successfully authenticated!');
            return;
        } else {
            const errData = await pollRes.json();
            if (errData.error === 'authorization_pending') {
                continue;
            } else {
                throw new Error(`Auth failed: ${errData.error_description}`);
            }
        }
    }

    throw new Error('Device code flow timed out.');
}
