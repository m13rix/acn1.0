import crypto from 'node:crypto';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sendFiles, sendText } from '../message/index.ts';

type Primitive = string | number | boolean;

type RealtimeConfig = {
  serverBaseUrl?: string;
  launchTtlSeconds?: number;
  htmlDocumentTtlHours?: number;
  voice?: string;
  enableGoogleSearchGrounding?: boolean;
  systemPrompt?: string;
  launchParams?: Record<string, Primitive>;
  interactiveListening?: {
    ttsBaseUrl?: string;
    ttsSpeakerWav?: string;
    ttsLanguage?: string;
    launchParams?: Record<string, Primitive>;
  };
};

type ResolvedRealtimeConfig = {
  serverBaseUrl: string;
  launchTtlSeconds: number;
  htmlDocumentTtlHours: number;
  voice: string;
  enableGoogleSearchGrounding: boolean;
  systemPrompt: string;
  launchParams: Record<string, Primitive>;
  interactiveListening: {
    ttsBaseUrl: string;
    ttsSpeakerWav: string;
    ttsLanguage: string;
    launchParams: Record<string, Primitive>;
  };
};

type UploadResponse = {
  ok?: boolean;
  code?: string;
  message?: string;
  document?: {
    id?: string;
    viewUrl?: string;
    expiresAt?: number;
  };
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(__dirname, 'config.json');

const DEFAULT_CONFIG: ResolvedRealtimeConfig = {
  serverBaseUrl: 'http://localhost:1620',
  launchTtlSeconds: 300,
  htmlDocumentTtlHours: 24,
  voice: 'Kore',
  enableGoogleSearchGrounding: false,
  systemPrompt: '',
  launchParams: {},
  interactiveListening: {
    ttsBaseUrl: 'http://localhost:8021',
    ttsSpeakerWav: 'narrator1',
    ttsLanguage: 'ru',
    launchParams: {},
  },
};

function getSandboxDirectory(): string {
  return process.cwd();
}

function isPathInside(parentDir: string, childPath: string): boolean {
  const relativePath = path.relative(parentDir, childPath);
  return relativePath === '' || (!relativePath.startsWith('..') && !path.isAbsolute(relativePath));
}

async function loadConfig(): Promise<ResolvedRealtimeConfig> {
  if (!existsSync(CONFIG_PATH)) {
    return DEFAULT_CONFIG;
  }

  const raw = await fs.readFile(CONFIG_PATH, 'utf8');
  const parsed = JSON.parse(raw) as RealtimeConfig;

  return {
    serverBaseUrl: parsed.serverBaseUrl?.trim() || DEFAULT_CONFIG.serverBaseUrl,
    launchTtlSeconds: normalizePositiveInteger(parsed.launchTtlSeconds, DEFAULT_CONFIG.launchTtlSeconds, 'launchTtlSeconds'),
    htmlDocumentTtlHours: normalizePositiveInteger(parsed.htmlDocumentTtlHours, DEFAULT_CONFIG.htmlDocumentTtlHours, 'htmlDocumentTtlHours'),
    voice: parsed.voice?.trim() || DEFAULT_CONFIG.voice,
    enableGoogleSearchGrounding: parsed.enableGoogleSearchGrounding ?? DEFAULT_CONFIG.enableGoogleSearchGrounding,
    systemPrompt: parsed.systemPrompt?.trim() || '',
    launchParams: normalizeParams(parsed.launchParams),
    interactiveListening: {
      ttsBaseUrl: parsed.interactiveListening?.ttsBaseUrl?.trim() || DEFAULT_CONFIG.interactiveListening.ttsBaseUrl,
      ttsSpeakerWav: parsed.interactiveListening?.ttsSpeakerWav?.trim() || DEFAULT_CONFIG.interactiveListening.ttsSpeakerWav,
      ttsLanguage: parsed.interactiveListening?.ttsLanguage?.trim() || DEFAULT_CONFIG.interactiveListening.ttsLanguage,
      launchParams: normalizeParams(parsed.interactiveListening?.launchParams),
    },
  };
}

function normalizePositiveInteger(value: number | undefined, fallback: number, fieldName: string): number {
  if (value === undefined) {
    return fallback;
  }
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`realtime config field "${fieldName}" must be a positive number.`);
  }
  return Math.floor(value);
}

function normalizeParams(params: Record<string, Primitive> | undefined): Record<string, Primitive> {
  if (!params || typeof params !== 'object') {
    return {};
  }

  const normalized: Record<string, Primitive> = {};
  for (const [key, value] of Object.entries(params)) {
    if (!key.trim()) {
      continue;
    }
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      normalized[key] = value;
    }
  }
  return normalized;
}

function getSigningSecret(): string {
  const secret = process.env.LAUNCH_SIGNING_SECRET?.trim();
  if (!secret) {
    throw new Error('LAUNCH_SIGNING_SECRET is required to create realtime launch links.');
  }
  return secret;
}

function canonicalizeForSignature(params: URLSearchParams): string {
  const entries: Array<[string, string]> = [];
  for (const [key, value] of params.entries()) {
    if (key === 'sig') {
      continue;
    }
    entries.push([key, value]);
  }

  entries.sort((left, right) => {
    if (left[0] === right[0]) {
      return left[1].localeCompare(right[1]);
    }
    return left[0].localeCompare(right[0]);
  });

  return entries
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join('&');
}

function createSignedLaunchUrl(baseUrl: string, params: URLSearchParams, secret: string): string {
  const signature = crypto.createHmac('sha256', secret)
    .update(canonicalizeForSignature(params))
    .digest('hex');

  params.set('sig', signature);
  const signedUrl = new URL(baseUrl);
  signedUrl.search = params.toString();
  return signedUrl.toString();
}

function buildLaunchBase(serverBaseUrl: string, pathname: string): string {
  const url = new URL(serverBaseUrl);
  url.pathname = pathname;
  url.search = '';
  url.hash = '';
  return url.toString();
}

function applyCommonLaunchParams(
  params: URLSearchParams,
  config: ResolvedRealtimeConfig,
  optionalInstructions?: string,
): void {
  params.set('exp', `${Math.floor(Date.now() / 1000) + config.launchTtlSeconds}`);
  params.set('voice', config.voice);

  if (config.enableGoogleSearchGrounding) {
    params.set('enableGoogleSearchGrounding', 'true');
  }

  const mergedPrompt = mergePrompt(config.systemPrompt, optionalInstructions);
  if (mergedPrompt) {
    params.set('systemPrompt', mergedPrompt);
  }

  appendParams(params, config.launchParams);
}

function appendParams(params: URLSearchParams, extraParams: Record<string, Primitive>): void {
  for (const [key, value] of Object.entries(extraParams)) {
    if (!params.has(key)) {
      params.set(key, String(value));
    }
  }
}

function mergePrompt(basePrompt: string, optionalInstructions?: string): string | undefined {
  const trimmedBase = basePrompt.trim();
  const trimmedInstructions = optionalInstructions?.trim() || '';

  if (!trimmedBase && !trimmedInstructions) {
    return undefined;
  }
  if (!trimmedBase) {
    return trimmedInstructions;
  }
  if (!trimmedInstructions) {
    return trimmedBase;
  }

  return `${trimmedBase}\n\nAdditional instructions for this session:\n${trimmedInstructions}`;
}

function ensureHttpsWebsite(rawUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`Invalid URL: ${rawUrl}`);
  }

  if (parsed.protocol !== 'https:') {
    throw new Error('Realtime web sessions require an HTTPS URL.');
  }

  return parsed.toString();
}

function resolveSandboxPath(inputPath: string): string {
  const sandboxDir = getSandboxDirectory();
  const resolvedPath = path.resolve(sandboxDir, inputPath);

  if (!isPathInside(sandboxDir, resolvedPath)) {
    throw new Error('Realtime HTML uploads only support files inside the current agent sandbox.');
  }

  return resolvedPath;
}

async function sendLaunchLink(title: string, url: string): Promise<void> {
  await sendText(`${title}\n${url}`);
}

function createListeningFileName(): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  return `realtime-listening-${timestamp}.txt`;
}

export async function startCall(optionalInstructions: string = ''): Promise<void> {
  const config = await loadConfig();
  const params = new URLSearchParams({
    sessionMode: 'voice',
  });

  applyCommonLaunchParams(params, config, optionalInstructions);

  const url = createSignedLaunchUrl(
    buildLaunchBase(config.serverBaseUrl, '/voice'),
    params,
    getSigningSecret(),
  );

  await sendLaunchLink('Realtime voice call is ready:', url);
}

export async function startInteractiveListening(
  listeningText: string,
  optionalInstructions: string = '',
): Promise<void> {
  const normalizedText = listeningText.trim();
  if (!normalizedText) {
    throw new Error('Interactive listening text must not be empty.');
  }

  const config = await loadConfig();
  const filePath = path.join(getSandboxDirectory(), createListeningFileName());
  await fs.writeFile(filePath, normalizedText, 'utf8');

  const params = new URLSearchParams({
    sessionMode: 'interactive_listening',
    ttsBaseUrl: config.interactiveListening.ttsBaseUrl,
    ttsSpeakerWav: config.interactiveListening.ttsSpeakerWav,
    ttsLanguage: config.interactiveListening.ttsLanguage,
  });

  applyCommonLaunchParams(params, config, optionalInstructions);
  appendParams(params, config.interactiveListening.launchParams);

  const url = createSignedLaunchUrl(
    buildLaunchBase(config.serverBaseUrl, '/interactive-listening'),
    params,
    getSigningSecret(),
  );

  await sendLaunchLink('Realtime interactive listening session is ready:', url);
  await sendFiles([filePath]);
}

export async function startUrlCall(url: string, optionalInstructions: string = ''): Promise<void> {
  const config = await loadConfig();
  const params = new URLSearchParams({
    website: ensureHttpsWebsite(url),
  });

  applyCommonLaunchParams(params, config, optionalInstructions);

  const launchUrl = createSignedLaunchUrl(
    buildLaunchBase(config.serverBaseUrl, '/'),
    params,
    getSigningSecret(),
  );

  await sendLaunchLink('Realtime webpage session is ready:', launchUrl);
}

export async function startHtmlCall(filePath: string, optionalInstructions: string = ''): Promise<void> {
  if (!filePath?.trim()) {
    throw new Error('HTML file path is required.');
  }

  const resolvedFilePath = resolveSandboxPath(filePath);
  if (path.extname(resolvedFilePath).toLowerCase() !== '.html') {
    throw new Error('Realtime HTML uploads only support .html files.');
  }

  const html = await fs.readFile(resolvedFilePath, 'utf8');
  if (!html.trim()) {
    throw new Error(`HTML file is empty: ${resolvedFilePath}`);
  }

  const config = await loadConfig();
  const uploadUrl = new URL('/documents/html', config.serverBaseUrl).toString();

  let response: Response;
  try {
    response = await fetch(uploadUrl, {
      method: 'POST',
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'x-document-name': path.basename(resolvedFilePath),
        'x-document-ttl-hours': String(config.htmlDocumentTtlHours),
      },
      body: html,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to reach realtime server at ${config.serverBaseUrl}: ${message}`);
  }

  const payload = await response.json().catch(() => null) as UploadResponse | null;
  if (!response.ok || !payload?.ok || !payload.document?.id) {
    const errorMessage = payload?.message || `Upload failed with status ${response.status}.`;
    throw new Error(errorMessage);
  }

  const params = new URLSearchParams({
    documentId: payload.document.id,
  });

  applyCommonLaunchParams(params, config, optionalInstructions);

  const launchUrl = createSignedLaunchUrl(
    buildLaunchBase(config.serverBaseUrl, '/'),
    params,
    getSigningSecret(),
  );

  await sendLaunchLink(`Realtime HTML session is ready for ${path.basename(resolvedFilePath)}:`, launchUrl);
}
