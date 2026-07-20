import { Telegraf, Markup } from 'telegraf';
import { message } from 'telegraf/filters';
import { createClient } from '@deepgram/sdk';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { getAgentSandbox } from '../../src/core/AgentContext.js';
import { appendAgentTextLog } from '../../src/core/agentTextLog.js';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegStatic from '@ffmpeg-installer/ffmpeg';
import wav from 'wav';
import * as os from 'os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_FILE = path.join(__dirname, 'owner.json');

// Configuration
const BOT_TOKEN = '8307545336:AAH9ok5fO1qlOGXGx0e_zbo_c-H4wy37tfs';
const DEEPGRAM_KEY = 'd41a097d9121982c5f8797e21477a0eb9a63a7d0';
const CLAIM_PASSWORD = 'agent'; // Password to claim ownership

// Initialize global instances
ffmpeg.setFfmpegPath(ffmpegStatic.path);

console.log('[Message] Module loaded successfully. sendVoice function is available.');

// Helper to manage owner persistence
function getOwner(): string | null {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
      return data.id;
    }
  } catch (e) {
    console.error('[Message] Error reading owner file:', e);
  }
  return null;
}

function saveOwner(id: string) {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify({ id }));
  } catch (e) {
    console.error('[Message] Error saving owner file:', e);
  }
}

function getBridgeApiUrl(): string | undefined {
  return process.env.TELOS_INTERFACE_API_URL || process.env.TELOS_API_URL;
}

const RESERVED_ROUTE_IDS = new Set(['HEARTBEAT_ROUTE']);

function getBridgeRouteId(): string | undefined {
  const routeId = process.env.TELOS_INTERFACE_ROUTE;
  if (!routeId || RESERVED_ROUTE_IDS.has(routeId)) {
    return undefined;
  }
  return routeId;
}

function getBridgeChatId(): string | undefined {
  const chatId = process.env.TELOS_CHAT_ID;
  if (!chatId || RESERVED_ROUTE_IDS.has(chatId)) {
    return undefined;
  }
  return chatId;
}

function getBridgeRecipient(ownerFallback?: string | null): { routeId?: string; chatId?: string } {
  const routeId = getBridgeRouteId();
  const chatId = getBridgeChatId() || ownerFallback || undefined;

  return {
    routeId: routeId || undefined,
    chatId: chatId || undefined,
  };
}

function isHeartbeatApiContext(): boolean {
  return process.env.TELOS_CHAT_ID === 'HEARTBEAT_ROUTE' && Boolean(process.env.TELOS_API_URL);
}

const DEFAULT_INTERNAL_API_PORT = 11342;
const DEFAULT_MESSAGE_API_TIMEOUT_MS = 15000;
const DEFAULT_MESSAGE_API_RETRIES = 4;
const DEFAULT_MESSAGE_ASK_POLL_INTERVAL_MS = 2000;
const DEFAULT_TELEGRAM_RETRY_DELAY_MS = 1500;
const DEFAULT_TELEGRAM_RETRY_ATTEMPTS = 3;
const TELEGRAM_TEXT_CHUNK_LIMIT = 3000;

type HarnessRequest = (type: string, payload: unknown) => Promise<unknown>;

function getHarnessRequest(): HarnessRequest | undefined {
  return (globalThis as typeof globalThis & {
    __TELOS_ACTION_WORKER_REQUEST__?: HarnessRequest;
  }).__TELOS_ACTION_WORKER_REQUEST__;
}

function getDiscoveredInternalApiUrl(): string {
  const rawPort = process.env.TELOS_INTERNAL_API_PORT;
  const parsedPort = rawPort ? Number.parseInt(rawPort, 10) : NaN;
  const port = Number.isFinite(parsedPort) && parsedPort > 0 ? parsedPort : DEFAULT_INTERNAL_API_PORT;
  return `http://localhost:${port}`;
}

function getMessageApiContext(): {
  explicitApiUrl?: string;
  apiUrl?: string;
  recipient: { routeId?: string; chatId?: string };
} {
  if (isHeartbeatApiContext()) {
    return {
      explicitApiUrl: process.env.TELOS_API_URL,
      apiUrl: process.env.TELOS_API_URL,
      recipient: { chatId: 'HEARTBEAT_ROUTE' },
    };
  }

  const explicitApiUrl = getBridgeApiUrl();
  if (explicitApiUrl) {
    return {
      explicitApiUrl,
      apiUrl: explicitApiUrl,
      recipient: getBridgeRecipient(),
    };
  }

  return {
    explicitApiUrl: undefined,
    apiUrl: getDiscoveredInternalApiUrl(),
    recipient: getBridgeRecipient(getOwner()),
  };
}

function shouldFallbackToLegacyFromApi(error: unknown, explicitApiUrl?: string): boolean {
  if (isHeartbeatApiContext()) {
    return false;
  }

  if (explicitApiUrl) {
    return false;
  }

  const message = error instanceof Error ? error.message : String(error || '');
  return /ECONNREFUSED|fetch failed|network|socket|timed out|timeout|Missing routeId|Missing parameters|404/i.test(message);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readPositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw || !raw.trim()) {
    return fallback;
  }

  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    return fallback;
  }

  return Math.floor(value);
}

function readOptionalTimeoutEnv(name: string, fallback?: number): number | undefined {
  const raw = process.env[name];
  if (!raw || !raw.trim()) {
    return fallback;
  }

  const normalized = raw.trim().toLowerCase();
  if (normalized === '0' || normalized === 'off' || normalized === 'none' || normalized === 'false' || normalized === 'infinite' || normalized === 'infinity') {
    return undefined;
  }

  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    return fallback;
  }

  return Math.floor(value);
}

function readOptionalRetryCountEnv(name: string, fallback?: number): number | undefined {
  const raw = process.env[name];
  if (!raw || !raw.trim()) {
    return fallback;
  }

  const normalized = raw.trim().toLowerCase();
  if (normalized === '0' || normalized === 'off' || normalized === 'none' || normalized === 'false' || normalized === 'infinite' || normalized === 'infinity') {
    return undefined;
  }

  const value = Number(raw);
  if (!Number.isFinite(value) || value < 1) {
    return fallback;
  }

  return Math.floor(value);
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status === 502 || status === 503 || status === 504;
}

function getRetryAfterMsFromValue(value: string | null | undefined): number | null {
  if (!value) {
    return null;
  }

  const numericSeconds = Number(value);
  if (Number.isFinite(numericSeconds) && numericSeconds > 0) {
    return numericSeconds * 1000;
  }

  const dateMs = Date.parse(value);
  if (Number.isFinite(dateMs)) {
    return Math.max(0, dateMs - Date.now());
  }

  return null;
}

async function readResponsePayload(response: Response): Promise<any> {
  const text = await response.text();
  if (!text.trim()) {
    return {};
  }

  try {
    return JSON.parse(text);
  } catch {
    return { error: text };
  }
}

function extractErrorMessage(payload: any, fallback: string): string {
  if (typeof payload === 'string' && payload.trim()) {
    return payload.trim();
  }
  if (payload && typeof payload === 'object') {
    if (typeof payload.error === 'string' && payload.error.trim()) {
      return payload.error.trim();
    }
    if (typeof payload.message === 'string' && payload.message.trim()) {
      return payload.message.trim();
    }
  }
  return fallback;
}

async function fetchJsonWithRetry(
  url: string,
  init: RequestInit,
  options?: {
    timeoutMs?: number;
    maxRetries?: number;
    label?: string;
  }
): Promise<any> {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_MESSAGE_API_TIMEOUT_MS;
  const maxRetries = options?.maxRetries ?? DEFAULT_MESSAGE_API_RETRIES;
  const label = options?.label || url;
  let lastError: unknown = null;
  let attempt = 1;

  for (;;) {
    const controller = new AbortController();
    const hasTimeout = Number.isFinite(timeoutMs) && timeoutMs > 0;
    const timeout = hasTimeout
      ? setTimeout(() => controller.abort(new Error(`Timed out after ${timeoutMs}ms`)), timeoutMs)
      : null;

    try {
      const response = await fetch(url, {
        ...init,
        signal: controller.signal,
      });
      if (timeout) {
        clearTimeout(timeout);
      }

      if (!response.ok) {
        const payload = await readResponsePayload(response);
        const message = extractErrorMessage(payload, `HTTP ${response.status}`);

        const canRetry = maxRetries === undefined || attempt < maxRetries;
        if (canRetry && isRetryableStatus(response.status)) {
          const retryMs = getRetryAfterMsFromValue(response.headers.get('retry-after'))
            ?? (response.status === 429
              ? DEFAULT_TELEGRAM_RETRY_DELAY_MS * Math.max(1, 2 ** (attempt - 1))
              : 1000 * Math.max(1, attempt));
          console.warn(`[Message] ${label} retrying after HTTP ${response.status} in ${retryMs}ms`);
          await sleep(retryMs);
          attempt += 1;
          continue;
        }

        throw new Error(message);
      }

      return await readResponsePayload(response);
    } catch (error: any) {
      if (timeout) {
        clearTimeout(timeout);
      }
      lastError = error;
      const isAbort = error?.name === 'AbortError';
      const message = String(error?.message || error || '');
      const retryable = isAbort
        || /fetch failed|network|socket|timed out|timeout|ECONNRESET|ECONNREFUSED|ETIMEDOUT/i.test(message);

      const canRetry = maxRetries === undefined || attempt < maxRetries;
      if (!canRetry || !retryable) {
        throw error;
      }

      const retryMs = DEFAULT_TELEGRAM_RETRY_DELAY_MS * Math.max(1, 2 ** (attempt - 1));
      console.warn(`[Message] ${label} transient failure, retrying in ${retryMs}ms: ${message}`);
      await sleep(retryMs);
      attempt += 1;
    }
  }

  throw lastError instanceof Error ? lastError : new Error(`Failed request: ${label}`);
}

function getTelegramRetryAfterMs(error: any): number {
  const retryAfter = error?.response?.parameters?.retry_after;
  if (typeof retryAfter === 'number' && retryAfter > 0) {
    return retryAfter * 1000;
  }
  return DEFAULT_TELEGRAM_RETRY_DELAY_MS;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function markdownToTelegramHtml(text: string): string {
  const normalized = text.replace(/\r\n/g, '\n');
  const parts: string[] = [];
  const fenceRegex = /```([^\n`]*)\n?([\s\S]*?)```/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = fenceRegex.exec(normalized)) !== null) {
    parts.push(inlineMarkdownToTelegramHtml(normalized.slice(lastIndex, match.index)));
    const lang = (match[1] || '').trim();
    const code = match[2] || '';
    const label = lang ? `${escapeHtml(lang)}\n` : '';
    parts.push(`${label}<pre><code>${escapeHtml(code.replace(/\n$/, ''))}</code></pre>`);
    lastIndex = fenceRegex.lastIndex;
  }

  parts.push(inlineMarkdownToTelegramHtml(normalized.slice(lastIndex)));
  return parts.join('');
}

function inlineMarkdownToTelegramHtml(text: string): string {
  let html = escapeHtml(text);

  html = html.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+&quot;[^&]*&quot;)?\)/g, (_m, alt, url) => {
    const label = alt || url;
    return `<a href="${escapeHtml(String(url))}">${label}</a>`;
  });
  html = html.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+&quot;[^&]*&quot;)?\)/g, (_m, label, url) =>
    `<a href="${escapeHtml(String(url))}">${label}</a>`);
  html = html.replace(/`([^`\n]+)`/g, '<code>$1</code>');
  html = html.replace(/\*\*\*([^*\n][\s\S]*?[^*\n])\*\*\*/g, '<b><i>$1</i></b>');
  html = html.replace(/___([^_\n][\s\S]*?[^_\n])___/g, '<b><i>$1</i></b>');
  html = html.replace(/\*\*([^*\n][\s\S]*?[^*\n])\*\*/g, '<b>$1</b>');
  html = html.replace(/__([^_\n][\s\S]*?[^_\n])__/g, '<b>$1</b>');
  html = html.replace(/~~([^~\n][\s\S]*?[^~\n])~~/g, '<s>$1</s>');
  html = html.replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<i>$2</i>');
  html = html.replace(/(^|[\s(])_([^_\n]+)_/g, '$1<i>$2</i>');
  html = html.replace(/^#{1,6}\s+(.+)$/gm, '<b>$1</b>');
  html = html.replace(/^&gt;\s?(.+)$/gm, '<blockquote>$1</blockquote>');
  html = html.replace(/^(\s*)([-*+])\s+/gm, '$1• ');
  html = html.replace(/^(\s*)-{3,}\s*$/gm, '$1────────');

  return html;
}

function splitText(text: string, maxLength: number): string[] {
  if (text.length <= maxLength) return [text];

  const chunks: string[] = [];
  let index = 0;

  while (index < text.length) {
    let end = Math.min(index + maxLength, text.length);
    if (end < text.length) {
      const newline = text.lastIndexOf('\n', end);
      if (newline > index + Math.floor(maxLength * 0.6)) {
        end = newline;
      }
    }

    const chunk = text.slice(index, end);
    if (chunk) chunks.push(chunk);
    index = end;

    if (text[index] === '\n') {
      index += 1;
    }
  }

  return chunks.length > 0 ? chunks : [''];
}

async function sendTelegramTextChunks(bot: Telegraf, chatId: string, text: string, label = 'sendText'): Promise<void> {
  const chunks = splitText(text, TELEGRAM_TEXT_CHUNK_LIMIT);
  for (let i = 0; i < chunks.length; i++) {
    const prefix = chunks.length > 1 ? `${escapeHtml(`[part ${i + 1}/${chunks.length}]`)}\n` : '';
    await telegramCallWithRetry(label, () => bot.telegram.sendMessage(chatId, `${prefix}${markdownToTelegramHtml(chunks[i] || '')}`, {
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    }));
  }
}

async function telegramCallWithRetry<T>(label: string, fn: () => Promise<T>): Promise<T> {
  let lastError: unknown = null;

  for (let attempt = 1; attempt <= DEFAULT_TELEGRAM_RETRY_ATTEMPTS; attempt++) {
    try {
      return await fn();
    } catch (error: any) {
      lastError = error;
      if (error?.response?.error_code !== 429 || attempt >= DEFAULT_TELEGRAM_RETRY_ATTEMPTS) {
        throw error;
      }

      const retryMs = getTelegramRetryAfterMs(error);
      console.warn(`[Message] ${label} hit Telegram rate limit, retrying in ${retryMs}ms`);
      await sleep(retryMs);
    }
  }

  throw lastError instanceof Error ? lastError : new Error(`Telegram call failed: ${label}`);
}

// Transcription helper
async function transcribe(url: string): Promise<string> {
  const deepgram = createClient(DEEPGRAM_KEY);

  const { result, error } = await deepgram.listen.prerecorded.transcribeUrl(
    { url },
    {
      model: 'nova-2',
      smart_format: true,
    }
  );

  if (error) {
    throw new Error(`Deepgram error: ${error.message}`);
  }

  return result?.results?.channels[0]?.alternatives[0]?.transcript || '';
}

async function saveWaveFile(filename: string, pcmData: Buffer, channels = 1, rate = 24000, sampleWidth = 2): Promise<void> {
  return new Promise((resolve, reject) => {
    const writer = new wav.FileWriter(filename, {
      channels,
      sampleRate: rate,
      bitDepth: sampleWidth * 8,
    });
    writer.on('finish', resolve);
    writer.on('error', reject);
    writer.write(pcmData);
    writer.end();
  });
}

/**
 * Sends a voice message to the user using Gemini TTS.
 * @param text The text to convert to speech
 * @param voiceName The voice to use (default: 'Orus')
 */
export async function sendVoice(text: string, voiceName: string = 'Orus'): Promise<void> {
  console.log(`[Message] sendVoice called with text: "${text.substring(0, 30)}...", voice: ${voiceName}`);

  const key = process.env.GEMINI_KEY;
  console.log(`[Message] GEMINI_KEY check: ${key ? 'FOUND' : 'MISSING'}`);
  if (!key) {
    console.error('[Message] GEMINI_KEY not found. Cannot send voice.');
    return;
  }
  console.log('[Message] GEMINI_KEY found, proceeding...');

  const tmpDir = os.tmpdir();
  const wavPath = path.join(tmpDir, `voice_${Date.now()}.wav`);
  const oggPath = wavPath.replace('.wav', '.ogg');

  // Determine Chat ID (Try API env first, then owner file)
  const { explicitApiUrl, apiUrl, recipient } = getMessageApiContext();
  const routeId = recipient.routeId || recipient.chatId || getOwner();
  const agentName = process.env.TELOS_AGENT_NAME;
  const harnessRequest = process.env.TELOS_HARNESS_SERVICES === '1' ? getHarnessRequest() : undefined;

  console.log(`[Message-Debug] Route ID: ${routeId} (Env route: ${getBridgeRouteId()}, Chat: ${getBridgeChatId()}, Owner: ${getOwner()})`);
  console.log(`[Message-Debug] API URL: ${apiUrl}`);

  if (!routeId && !harnessRequest) {
    console.error('[Message] Cannot send voice: No owner and no Chat ID found.');
    return;
  }

  try {
    console.log('🎤 Generating voice...');
    const genAI = new GoogleGenerativeAI(key);
    const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash-preview-tts' });

    const result = await model.generateContent({
      contents: [{ parts: [{ text }] }],
      generationConfig: {
        responseModalities: ['AUDIO'],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: { voiceName }
          }
        }
      }
    });

    const response = await result.response;
    // Note: Gemini API structure for Audio might vary, ensuring we access correctly based on prompt snippet
    const data = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;

    if (!data) {
      // Fallback or error check if structure is different (e.g. binary blob)
      // But assuming prompt snippet is correct for the library version
      throw new Error('No audio data from Gemini TTS');
    }

    const audioBuffer = Buffer.from(data, 'base64');
    await saveWaveFile(wavPath, audioBuffer);

    // Verify file creation
    if (fs.existsSync(wavPath)) {
      const stats = fs.statSync(wavPath);
      console.log(`[Message-Debug] WAV File created: ${wavPath} (${stats.size} bytes)`);
    } else {
      throw new Error(`[Message-Debug] WAV File failed to create at ${wavPath}`);
    }

    // Convert to OGG Opus for Telegram voice
    await new Promise((resolve, reject) => {
      ffmpeg(wavPath)
        .audioCodec('libopus')
        .audioFrequency(24000)
        .audioChannels(1)
        .format('ogg')
        .on('end', resolve)
        .on('error', reject)
        .save(oggPath);
    });

    if (fs.existsSync(oggPath)) {
      const stats = fs.statSync(oggPath);
      console.log(`[Message-Debug] OGG File created: ${oggPath} (${stats.size} bytes)`);
    } else {
      throw new Error(`[Message-Debug] OGG File failed to create at ${oggPath}`);
    }

    if (harnessRequest) {
      await harnessRequest('voice.publish', {
        path: oggPath,
        name: `voice-${Date.now()}.ogg`,
        text,
        voiceName,
      });
      console.log('[Message] Voice attachment published.');
      return;
    }

    // Send via API if available
    let sentViaApi = false;

    if (apiUrl && (recipient.routeId || recipient.chatId)) {
      console.log(`[Message] Sending voice via API for route: ${routeId}`);
      try {
        await fetchJsonWithRetry(`${apiUrl}/api/sendVoice`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...recipient, file: oggPath, agentName })
        }, { label: 'sendVoice' });
        console.log('[Message-Debug] API Request Success');
        sentViaApi = true;
      } catch (apiErr) {
        if (!shouldFallbackToLegacyFromApi(apiErr, explicitApiUrl)) {
          console.error('[Message-Debug] Fetch Error:', apiErr);
          throw apiErr;
        }
        console.warn('[Message] Internal API voice send failed, falling back to direct Telegram send:', apiErr);
      }
    }

    if (!sentViaApi) {
      // Legacy: Send directly
      console.log('[Message-Debug] Sending via Legacy Mode (Telegraf directly)');
      const bot = new Telegraf(BOT_TOKEN);
      await telegramCallWithRetry('sendVoice', () => bot.telegram.sendVoice(routeId, { source: oggPath }));
    }


    console.log('✅ Voice message sent!');
  } catch (error) {
    console.error('❌ sendVoice error:', error);
    throw error;
  } finally {
    // Cleanup
    [wavPath, oggPath].forEach(async (f) => {
      try { await fs.unlink(f); } catch { }
    });
  }
}

/**
 * Sends a question to the user and waits for a response.
 * Supports running via TelegramService API (multi-user) or standalone (legacy).
 */
export interface AskChoiceGroup {
  id?: string;
  label?: string;
  question?: string;
  choices?: Array<string | { label?: string; value?: string; description?: string }>;
}

export interface AskChoice {
  /** Stable, machine-readable value returned when this button is pressed. */
  id: string;
  /** Human-readable Telegram button label. */
  label: string;
  description?: string;
}

export interface AskMenuOptions {
  /** Optional stable identifier for analytics, logs, and future UI clients. */
  id?: string;
  options: AskChoice[];
}

export interface AskInput {
  question: string;
  /** Legacy readable option groups, or a first-class button menu. */
  options?: Array<string | AskChoiceGroup> | AskMenuOptions;
}

function normalizeAskMenu(value: unknown): AskMenuOptions | undefined {
  if (!value || typeof value !== 'object' || !Array.isArray((value as AskMenuOptions).options)) return undefined;
  const id = typeof (value as AskMenuOptions).id === 'string' ? (value as AskMenuOptions).id.trim() : undefined;
  const options = (value as AskMenuOptions).options
    .map((option) => ({
      id: String(option?.id || '').trim(),
      label: String(option?.label || '').trim(),
      description: typeof option?.description === 'string' ? option.description.trim() || undefined : undefined,
    }))
    .filter((option) => option.id && option.label)
    .slice(0, 12);
  return options.length ? { ...(id ? { id } : {}), options } : undefined;
}

function normalizeAskRequest(input: string | AskInput, menuOptions?: AskMenuOptions): { question: string; menu?: AskMenuOptions; text: string } {
  if (typeof input === 'string') {
    const question = input.trim();
    if (!question) throw new Error('message.ask requires a non-empty question.');
    const menu = normalizeAskMenu(menuOptions);
    return { question, menu, text: menu ? `${question}\n\nChoose an option below, or reply in your own words.` : question };
  }

  const question = String(input?.question || '').trim();
  if (!question) throw new Error('message.ask requires a non-empty question.');
  const menu = normalizeAskMenu(menuOptions) || normalizeAskMenu(input.options);
  if (menu) return { question, menu, text: `${question}\n\nChoose an option below, or reply in your own words.` };
  const groups = Array.isArray(input.options) ? input.options : [];
  if (groups.length === 0) return { question, text: question };

  const lines = [question];
  groups.forEach((group, index) => {
    if (typeof group === 'string') {
      lines.push(`${index + 1}. ${group}`);
      return;
    }

    const label = String(group.label || group.question || group.id || `Choice ${index + 1}`).trim();
    lines.push('', `${index + 1}. ${label}`);
    for (const choice of group.choices || []) {
      if (typeof choice === 'string') {
        lines.push(`   - ${choice}`);
        continue;
      }
      const choiceLabel = String(choice.label || choice.value || '').trim();
      const description = String(choice.description || '').trim();
      if (choiceLabel) lines.push(`   - ${choiceLabel}${description ? ` — ${description}` : ''}`);
    }
  });

  return { question, text: lines.join('\n') };
}

export function formatAskInput(input: string | AskInput, menuOptions?: AskMenuOptions): string {
  return normalizeAskRequest(input, menuOptions).text;
}

export async function ask(input: string | AskInput, menuOptions?: AskMenuOptions): Promise<string> {
  const request = normalizeAskRequest(input, menuOptions);
  const { question, menu } = request;
  const questionForDelivery = menu ? question : request.text;
  const harnessRequest = getHarnessRequest();
  if (harnessRequest) {
    const timeoutMs = readOptionalTimeoutEnv('TELOS_MESSAGE_ASK_TIMEOUT_MS');
    const answer = await harnessRequest('interaction.create', {
      request: {
        questions: [
          {
            id: menu?.id || 'response',
            type: menu ? 'single-select' : 'free-text',
            question,
            ...(menu ? { options: menu.options } : {}),
          },
        ],
      },
      ...(timeoutMs ? { timeoutMs } : {}),
    });
    const answers = answer && typeof answer === 'object' ? answer as Record<string, unknown> : {};
    const response = answers.response ?? answers[menu?.id || 'response'];
    if (typeof response === 'string') return response;
    if (Array.isArray(response)) return response.map(String).join(', ');
    return JSON.stringify(answers);
  }
  // 1. Check if running in a managed context with API access
  const { explicitApiUrl, apiUrl, recipient } = getMessageApiContext();
  const agentName = process.env.TELOS_AGENT_NAME;

  if (apiUrl && (recipient.routeId || recipient.chatId)) {
    console.log(`[Message] Asking via API for recipient: route=${recipient.routeId || '-'} chat=${recipient.chatId || '-'}`);
    try {
      const askRequestTimeoutMs = readOptionalTimeoutEnv(
        'TELOS_MESSAGE_ASK_REQUEST_TIMEOUT_MS',
        readOptionalTimeoutEnv('TELOS_MESSAGE_API_TIMEOUT_MS'),
      );
      const askRequestRetries = readOptionalRetryCountEnv(
        'TELOS_MESSAGE_ASK_REQUEST_RETRIES',
        readOptionalRetryCountEnv('TELOS_MESSAGE_API_RETRIES'),
      );
      const askPollRequestTimeoutMs = readOptionalTimeoutEnv(
        'TELOS_MESSAGE_ASK_POLL_REQUEST_TIMEOUT_MS',
        readOptionalTimeoutEnv('TELOS_MESSAGE_API_TIMEOUT_MS'),
      );
      const askPollRequestRetries = readOptionalRetryCountEnv(
        'TELOS_MESSAGE_ASK_POLL_REQUEST_RETRIES',
        readOptionalRetryCountEnv('TELOS_MESSAGE_API_RETRIES'),
      );

      const payload = await fetchJsonWithRetry(`${apiUrl}/api/ask`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...recipient, question: questionForDelivery, options: menu, agentName })
      }, {
        label: 'ask',
        timeoutMs: askRequestTimeoutMs ?? Number.POSITIVE_INFINITY,
        maxRetries: askRequestRetries ?? Number.POSITIVE_INFINITY,
      }) as { status?: string; response?: string; questionId?: string; error?: string };

      if (payload.status === 'answered' && typeof payload.response === 'string') {
        console.log('[Message] User Response: ' + payload.response);
        return payload.response;
      }

      if (!payload.questionId) {
        throw new Error(payload.error || 'API ask response did not include a direct answer or questionId.');
      }

      const timeoutMs = readOptionalTimeoutEnv('TELOS_MESSAGE_ASK_TIMEOUT_MS');
      const pollIntervalMs = readPositiveIntEnv('TELOS_MESSAGE_ASK_POLL_INTERVAL_MS', DEFAULT_MESSAGE_ASK_POLL_INTERVAL_MS);
      const startedAt = Date.now();

      for (;;) {
        if (timeoutMs !== undefined && Date.now() - startedAt > timeoutMs) {
          throw new Error(`message.ask timed out after ${timeoutMs}ms waiting for question ${payload.questionId}`);
        }

        await sleep(pollIntervalMs);
        const poll = await fetchJsonWithRetry(
          `${apiUrl}/api/ask/poll?questionId=${encodeURIComponent(payload.questionId)}`,
          { method: 'GET' },
          {
            label: 'ask.poll',
            timeoutMs: askPollRequestTimeoutMs ?? Number.POSITIVE_INFINITY,
            maxRetries: askPollRequestRetries ?? Number.POSITIVE_INFINITY,
          },
        ) as { status?: string; response?: string; error?: string };

        if (poll.status === 'answered' && typeof poll.response === 'string') {
          console.log('[Message] User Response: ' + poll.response);
          return poll.response;
        }

        if (poll.status && poll.status !== 'waiting') {
          throw new Error(poll.error || `Unexpected ask poll status: ${poll.status}`);
        }
      }
    } catch (e: any) {
      console.error('[Message] API error:', e.message);
      if (!shouldFallbackToLegacyFromApi(e, explicitApiUrl)) {
        throw e;
      }
      console.warn('[Message] Falling back to legacy Telegram ask flow after internal API failure.');
    }
  }

  // 2. Fallback: Legacy Standalone Mode (Bot Owner)
  console.log('[Message] Initializing Telegram bot (Legacy Mode)...');
  const bot = new Telegraf(BOT_TOKEN);
  let ownerId = getOwner();
  const menuToken = menu ? Math.random().toString(36).slice(2, 12) : undefined;

  const sendLegacyQuestion = async (chatId: string): Promise<void> => {
    if (!menu || !menuToken) {
      await sendTelegramTextChunks(bot, chatId, `❓ Question: ${question}`, 'ask.sendQuestion');
      return;
    }
    const descriptions = menu.options
      .filter((option) => option.description)
      .map((option) => `• ${option.label} — ${option.description}`);
    await telegramCallWithRetry('ask.sendMenu', () => bot.telegram.sendMessage(chatId, markdownToTelegramHtml([
      `❓ ${question}`,
      ...descriptions,
      '',
      'Tap an option below, or reply in your own words.',
    ].join('\n')), {
      parse_mode: 'HTML',
      reply_markup: Markup.inlineKeyboard(menu.options.map((option, index) => [
        Markup.button.callback(option.label.slice(0, 64), `ask:${menuToken}:${index}`),
      ])).reply_markup,
    }));
  };

  // We wrap the logic in a promise to wait for the user's response
  return new Promise((resolve, reject) => {
    let resolved = false;

    // Cleanup function to stop the bot and resolve the promise
    const finish = (response: string) => {
      if (resolved) return;
      resolved = true;
      bot.stop('SIGINT');
      resolve(response);
    };

    // Handle /start command
    bot.command('start', async (ctx) => {
      if (ownerId) {
        if (ctx.chat.id.toString() === ownerId) {
          await ctx.reply('Welcome back, owner!');
        } else {
          await ctx.reply('This agent is already owned by someone else.');
        }
        return;
      }
      await ctx.reply(`Hello! I am your AI Agent. To claim me, please enter the password.`);
    });

    // Handle text messages
    bot.on(message('text'), async (ctx) => {
      const chatId = ctx.chat.id.toString();
      const text = ctx.message.text;

      // Registration flow
      if (!ownerId) {
        if (text === CLAIM_PASSWORD) {
          ownerId = chatId;
          saveOwner(ownerId);
          await ctx.reply('✅ Ownership verified! You are now connected.');
          await sendLegacyQuestion(ownerId);
        } else {
          await ctx.reply('❌ Incorrect password. Please try again.');
        }
        return;
      }

      // Verification (only owner can reply)
      if (chatId !== ownerId) {
        await ctx.reply('⛔ You are not the owner of this agent.');
        return;
      }

      // Valid response from owner
      finish(text);
    });

    bot.on('callback_query', async (ctx) => {
      const chatId = ctx.chat?.id.toString();
      const data = 'data' in ctx.callbackQuery ? ctx.callbackQuery.data : undefined;
      const match = typeof data === 'string' ? /^ask:([a-z0-9]+):(\d+)$/.exec(data) : null;
      const option = match?.[1] === menuToken ? menu?.options[Number(match[2])] : undefined;
      if (!chatId || chatId !== ownerId || !option) {
        await ctx.answerCbQuery('This question is no longer active.').catch(() => undefined);
        return;
      }
      await ctx.answerCbQuery(`Selected: ${option.label}`).catch(() => undefined);
      await ctx.editMessageReplyMarkup({ inline_keyboard: [] } as any).catch(() => undefined);
      finish(option.id);
    });

    // Handle voice messages
    bot.on(message('voice'), async (ctx) => {
      const chatId = ctx.chat.id.toString();

      if (!ownerId || chatId !== ownerId) {
        return;
      }

      await ctx.reply('🎙️ Processing voice message...');
      try {
        const link = await ctx.telegram.getFileLink(ctx.message.voice.file_id);
        const transcript = await transcribe(link.href);
        await ctx.reply(`📝 Transcript: "${transcript}"`);
        finish(transcript);
      } catch (error) {
        console.error('Transcription error:', error);
        await ctx.reply('❌ Error processing voice message.');
      }
    });

    // Start the bot
    bot.launch(() => console.log('[Message] Bot stopped'))
      .catch(err => {
        console.error('[Message] Bot launch error:', err);
        reject(err);
      });

    console.log('[Message] Bot polling started.');

    // If owner exists, send the question immediately
    if (ownerId) {
      sendLegacyQuestion(ownerId)
        .catch(err => {
          console.error('[Message] Failed to send message:', err);
        });
    } else {
      console.log(`[Message] No owner registered. Waiting for /start and password '${CLAIM_PASSWORD}' on the bot...`);
    }
  });
}

/**
 * Sends files to the user.
 */
export async function sendFiles(files: string[]): Promise<void> {
  const harnessRequest = process.env.TELOS_HARNESS_SERVICES === '1' ? getHarnessRequest() : undefined;
  if (harnessRequest) {
    const sandboxDir = getAgentSandbox()?.directory || process.cwd();
    await harnessRequest('attachment.publish', {
      paths: files.map((file) => path.resolve(sandboxDir, file)),
    });
    return;
  }
  const { explicitApiUrl, apiUrl, recipient } = getMessageApiContext();
  const agentName = process.env.TELOS_AGENT_NAME;

  if (apiUrl && (recipient.routeId || recipient.chatId)) {
    console.log(`[Message] Sending files via API for recipient: route=${recipient.routeId || '-'} chat=${recipient.chatId || '-'}`);
    try {
      const sandboxDir = getAgentSandbox()?.directory || process.cwd();
      const absoluteFiles = files.map(f => path.resolve(sandboxDir, f));

      await fetchJsonWithRetry(`${apiUrl}/api/sendFiles`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...recipient, files: absoluteFiles, agentName })
      }, { label: 'sendFiles' });
      return;
    } catch (e: any) {
      console.error('[Message] API error:', e.message);
      if (!shouldFallbackToLegacyFromApi(e, explicitApiUrl)) {
        throw e;
      }
      console.warn('[Message] Falling back to legacy Telegram file send after internal API failure.');
    }
  }

  // Fallback: Legacy (Not fully supported for sending arbitary files proactively in legacy mode,
  // but we can try if we have an owner)
  const ownerId = getOwner();
  if (!ownerId) {
    console.error('[Message] Cannot send files: No owner and no API context.');
    return;
  }

  const bot = new Telegraf(BOT_TOKEN);
  for (const file of files) {
    try {
      // We can't easily resolve relative paths here without context of where the tool is running vs where session is.
      // But assuming CWD is sandbox or similar.
      // Telegraf needs explicit upload logic.
      // This legacy path is brittle. API path is preferred.
      await telegramCallWithRetry('sendFiles', () => bot.telegram.sendDocument(ownerId, { source: file }));
    } catch (e) {
      console.error(`[Message] Failed to send file ${file}:`, e);
    }
  }
}

/**
 * Sends a simple text message to the user.
 */
export async function sendText(text: string): Promise<void> {
  appendAgentTextLog(process.env.TELOS_TEXT_LOG_PATH, 'sent_text', text);

  const harnessRequest = getHarnessRequest();
  if (harnessRequest) {
    await harnessRequest('message.publish', { text });
    return;
  }

  const { explicitApiUrl, apiUrl, recipient } = getMessageApiContext();
  const agentName = process.env.TELOS_AGENT_NAME;

  if (apiUrl && (recipient.routeId || recipient.chatId)) {
    console.log(`[Message] Sending text via API for recipient: route=${recipient.routeId || '-'} chat=${recipient.chatId || '-'}`);
    try {
      await fetchJsonWithRetry(`${apiUrl}/api/sendText`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...recipient, text, agentName })
      }, { label: 'sendText' });
      return;
    } catch (e: any) {
      console.error('[Message] API error:', e.message);
      if (!shouldFallbackToLegacyFromApi(e, explicitApiUrl)) {
        throw e;
      }
      console.warn('[Message] Falling back to legacy Telegram text send after internal API failure.');
    }
  }

  // Fallback: Legacy
  const ownerId = getOwner();
  if (!ownerId) {
    console.error('[Message] Cannot send text: No owner and no API context.');
    return;
  }

  const bot = new Telegraf(BOT_TOKEN);
  try {
    await sendTelegramTextChunks(bot, ownerId, text, 'sendText');
  } catch (e) {
    console.error(`[Message] Failed to send text:`, e);
  }
}

export const __internals = {
  fetchJsonWithRetry,
  readResponsePayload,
  extractErrorMessage,
  getDiscoveredInternalApiUrl,
  getBridgeRecipient,
  getMessageApiContext,
  shouldFallbackToLegacyFromApi,
};
