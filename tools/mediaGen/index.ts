import { mkdir, writeFile } from 'fs/promises';
import path from 'path';
import { randomUUID } from 'crypto';

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const LYRIA_3_CLIP_MODEL = 'google/lyria-3-clip-preview';
const DEFAULT_IMAGE_MODEL = 'google/gemini-3.1-flash-image';
const IMAGE_MODEL_PRESETS = {
  cheap: 'google/gemini-3.1-flash-image',
  balanced: 'google/gemini-3.1-flash-image',
  pro: 'google/gemini-3-pro-image',
  legacyCheap: 'google/gemini-2.5-flash-image',
} as const;

export interface GenerateMusicOptions {
  /** Text prompt describing the music to generate. */
  prompt: string;
  /** Where to save the generated audio. Relative paths resolve inside the current action sandbox/workspace. */
  outputPath?: string;
  /** Optional temperature forwarded to OpenRouter. */
  temperature?: number;
  /** Optional seed forwarded to OpenRouter when supported. */
  seed?: number;
}

export interface GenerateMusicResult {
  path: string;
  model: string;
  provider: 'openrouter';
  prompt: string;
  mimeType: string;
  format: string;
  estimatedCostUsd: number;
  metadataPath: string;
  text?: string;
  rawResponseShape: string;
}

export interface GenerateImageOptions {
  /** Text prompt describing the image to generate or edit. */
  prompt: string;
  /** Where to save the generated image. Relative paths resolve inside the current action sandbox/workspace. */
  outputPath?: string;
  /** OpenRouter image model or preset. Defaults to cheap/balanced Nano Banana 2: google/gemini-3.1-flash-image. */
  model?: string | keyof typeof IMAGE_MODEL_PRESETS;
  /** Optional aspect ratio forwarded as image_config.aspect_ratio, e.g. '1:1', '16:9', '9:16'. */
  aspectRatio?: string;
  /** Optional image size forwarded as image_config.image_size, e.g. '0.5K', '1K', '2K', '4K'. */
  imageSize?: string;
  /** Optional temperature forwarded to OpenRouter. */
  temperature?: number;
  /** Optional seed forwarded to OpenRouter when supported. */
  seed?: number;
  /** Optional reference/input images for image editing. Values may be paths, URLs, data URLs, or raw base64. */
  inputImages?: string[];
  /** Optional extra image_config fields for provider/model-specific controls. */
  imageConfig?: Record<string, unknown>;
}

export interface GenerateImageResult {
  path: string;
  paths: string[];
  model: string;
  provider: 'openrouter';
  prompt: string;
  mimeType: string;
  format: string;
  estimatedCostUsd: number | null;
  metadataPath: string;
  text?: string;
  rawResponseShape: string;
}

type MediaCandidate = {
  data?: string;
  url?: string;
  mimeType?: string;
  format?: string;
};

type AudioCandidate = MediaCandidate;
type ImageCandidate = MediaCandidate;
type OpenRouterImageResponse = {
  response: Response;
  json: unknown;
  rawText: string;
  outputModalities: string[];
};

function getSandboxRoot(): string {
  return path.resolve(process.env.SANDBOX_DIR || process.cwd());
}

function resolveOutputPath(requestedPath: string | undefined, formatHint: string, mediaKind = 'music'): string {
  const fallbackName = `.media-gen/${mediaKind}-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}.${formatHint || (mediaKind === 'image' ? 'png' : 'mp3')}`;
  const rawPath = (requestedPath && requestedPath.trim()) || fallbackName;
  const absolutePath = path.isAbsolute(rawPath)
    ? path.resolve(rawPath)
    : path.resolve(getSandboxRoot(), rawPath);

  if (!path.isAbsolute(rawPath)) {
    const relative = path.relative(getSandboxRoot(), absolutePath);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error('outputPath resolves outside the sandbox/workspace.');
    }
  }

  return absolutePath;
}

function looksLikeBase64(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.length > 200 && /^[A-Za-z0-9+/=\r\n]+$/.test(trimmed);
}

function parseDataUrl(value: string): MediaCandidate | null {
  const match = value.match(/^data:([^;,]+)?(?:;[^,]*)?;base64,(.+)$/s);
  if (!match) return null;
  return {
    mimeType: match[1] || undefined,
    data: match[2],
  };
}

function inferFormat(mimeType?: string, explicitFormat?: string): string {
  const format = explicitFormat?.replace(/^\./, '').toLowerCase();
  if (format) return format;
  const mime = (mimeType || '').toLowerCase();
  if (mime.includes('wav')) return 'wav';
  if (mime.includes('mpeg') || mime.includes('mp3')) return 'mp3';
  if (mime.includes('ogg')) return 'ogg';
  if (mime.includes('flac')) return 'flac';
  if (mime.includes('webm')) return 'webm';
  return 'mp3';
}

function inferMimeType(format: string, provided?: string): string {
  if (provided) return provided;
  switch (format) {
    case 'wav': return 'audio/wav';
    case 'ogg': return 'audio/ogg';
    case 'flac': return 'audio/flac';
    case 'webm': return 'audio/webm';
    default: return 'audio/mpeg';
  }
}

function inferImageFormat(mimeType?: string, explicitFormat?: string): string {
  const format = explicitFormat?.replace(/^\./, '').toLowerCase();
  if (format) return format;
  const mime = (mimeType || '').toLowerCase();
  if (mime.includes('jpeg') || mime.includes('jpg')) return 'jpg';
  if (mime.includes('webp')) return 'webp';
  if (mime.includes('gif')) return 'gif';
  if (mime.includes('svg')) return 'svg';
  return 'png';
}

function inferImageMimeType(format: string, provided?: string): string {
  if (provided) return provided;
  switch (format) {
    case 'jpg':
    case 'jpeg': return 'image/jpeg';
    case 'webp': return 'image/webp';
    case 'gif': return 'image/gif';
    case 'svg': return 'image/svg+xml';
    default: return 'image/png';
  }
}

function findAudioCandidate(value: unknown, depth = 0): AudioCandidate | null {
  if (depth > 8 || value == null) return null;

  if (typeof value === 'string') {
    const dataUrl = parseDataUrl(value);
    if (dataUrl) return dataUrl;
    if (/^https?:\/\//i.test(value) && /\.(mp3|wav|ogg|flac|webm)(\?|$)/i.test(value)) {
      return { url: value };
    }
    if (looksLikeBase64(value)) {
      return { data: value };
    }
    return null;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findAudioCandidate(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;

  const directData = record['data'] ?? record['base64'] ?? record['audio_data'] ?? record['audioData'];
  const directUrl = record['url'] ?? record['audio_url'] ?? record['audioUrl'];
  const mimeType = typeof record['mime_type'] === 'string'
    ? record['mime_type']
    : typeof record['mimeType'] === 'string'
      ? record['mimeType']
      : undefined;
  const format = typeof record['format'] === 'string' ? record['format'] : undefined;

  if (typeof directData === 'string') {
    const dataUrl = parseDataUrl(directData);
    return dataUrl ? { ...dataUrl, mimeType: dataUrl.mimeType || mimeType, format } : { data: directData, mimeType, format };
  }
  if (typeof directUrl === 'string' && /^https?:\/\//i.test(directUrl)) {
    return { url: directUrl, mimeType, format };
  }

  const preferredKeys = ['audio', 'inline_data', 'inlineData', 'fileData', 'content', 'parts', 'message', 'choices'];
  for (const key of preferredKeys) {
    if (key in record) {
      const found = findAudioCandidate(record[key], depth + 1);
      if (found) return { ...found, mimeType: found.mimeType || mimeType, format: found.format || format };
    }
  }

  for (const item of Object.values(record)) {
    const found = findAudioCandidate(item, depth + 1);
    if (found) return found;
  }

  return null;
}


function findImageCandidate(value: unknown, depth = 0): ImageCandidate | null {
  if (depth > 8 || value == null) return null;

  if (typeof value === 'string') {
    const dataUrl = parseDataUrl(value);
    if (dataUrl && (dataUrl.mimeType || '').toLowerCase().startsWith('image/')) return dataUrl;
    if (/^https?:\/\//i.test(value) && /\.(png|jpe?g|webp|gif|svg)(\?|$)/i.test(value)) {
      return { url: value };
    }
    return null;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findImageCandidate(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;

  const imageUrlValue = record['image_url'] ?? record['imageUrl'];
  if (typeof imageUrlValue === 'string') {
    const dataUrl = parseDataUrl(imageUrlValue);
    return dataUrl || { url: imageUrlValue };
  }
  if (imageUrlValue && typeof imageUrlValue === 'object') {
    const nested = imageUrlValue as Record<string, unknown>;
    const nestedUrl = nested['url'];
    if (typeof nestedUrl === 'string') {
      const dataUrl = parseDataUrl(nestedUrl);
      return dataUrl || { url: nestedUrl };
    }
  }

  const directData = record['data'] ?? record['base64'] ?? record['b64_json'] ?? record['image_data'] ?? record['imageData'];
  const directUrl = record['url'] ?? record['image_url'] ?? record['imageUrl'];
  const mimeType = typeof record['mime_type'] === 'string'
    ? record['mime_type']
    : typeof record['mimeType'] === 'string'
      ? record['mimeType']
      : undefined;
  const format = typeof record['format'] === 'string' ? record['format'] : undefined;

  if (typeof directData === 'string') {
    const dataUrl = parseDataUrl(directData);
    return dataUrl ? { ...dataUrl, mimeType: dataUrl.mimeType || mimeType, format } : { data: directData, mimeType, format };
  }
  if (typeof directUrl === 'string' && /^https?:\/\//i.test(directUrl)) {
    return { url: directUrl, mimeType, format };
  }

  const preferredKeys = ['images', 'image', 'inline_data', 'inlineData', 'fileData', 'content', 'parts', 'message', 'choices', 'output'];
  for (const key of preferredKeys) {
    if (key in record) {
      const found = findImageCandidate(record[key], depth + 1);
      if (found) return { ...found, mimeType: found.mimeType || mimeType, format: found.format || format };
    }
  }

  for (const item of Object.values(record)) {
    const found = findImageCandidate(item, depth + 1);
    if (found) return found;
  }

  return null;
}

function findImageCandidates(value: unknown): ImageCandidate[] {
  const candidates: ImageCandidate[] = [];
  function visit(node: unknown, depth = 0): void {
    if (depth > 8 || node == null) return;
    const found = findImageCandidate(node, depth);
    if (found) {
      const key = found.data || found.url || '';
      if (key && !candidates.some(candidate => (candidate.data || candidate.url) === key)) candidates.push(found);
    }
    if (Array.isArray(node)) {
      for (const item of node) visit(item, depth + 1);
    } else if (typeof node === 'object') {
      for (const item of Object.values(node as Record<string, unknown>)) visit(item, depth + 1);
    }
  }
  visit(value);
  return candidates;
}

async function fileToDataUrl(value: string): Promise<string> {
  if (/^data:/i.test(value) || /^https?:\/\//i.test(value)) return value;
  if (looksLikeBase64(value)) return `data:image/png;base64,${value.replace(/\s/g, '')}`;
  const fs = await import('fs/promises');
  const absolutePath = path.isAbsolute(value) ? value : path.resolve(getSandboxRoot(), value);
  const buffer = await fs.readFile(absolutePath);
  const extension = path.extname(absolutePath).replace(/^\./, '').toLowerCase();
  const mimeType = inferImageMimeType(extension || 'png');
  return `data:${mimeType};base64,${buffer.toString('base64')}`;
}

async function downloadMediaUrl(url: string, label: string): Promise<{ buffer: Buffer; mimeType?: string }> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download generated ${label}: ${response.status} ${response.statusText}`);
  }
  const arrayBuffer = await response.arrayBuffer();
  return {
    buffer: Buffer.from(arrayBuffer),
    mimeType: response.headers.get('content-type') || undefined,
  };
}

function resolveImageModel(model?: string): string {
  if (!model) return DEFAULT_IMAGE_MODEL;
  return IMAGE_MODEL_PRESETS[model as keyof typeof IMAGE_MODEL_PRESETS] || model;
}

function estimateImageCostUsd(model: string): number | null {
  if (model === 'google/gemini-2.5-flash-image') return 0.039;
  if (model === 'google/gemini-3.1-flash-image' || model === 'google/gemini-3.1-flash-image-preview') return 0.04;
  if (model === 'google/gemini-3-pro-image' || model === 'google/gemini-3-pro-image-preview') return 0.24;
  if (model === 'openai/gpt-5-image-mini') return 0.08;
  return null;
}

function extractText(value: unknown): string | undefined {
  const chunks: string[] = [];
  function visit(node: unknown, depth = 0): void {
    if (depth > 6 || node == null) return;
    if (typeof node === 'string') {
      if (!parseDataUrl(node) && !looksLikeBase64(node) && node.length < 4000) chunks.push(node);
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) visit(item, depth + 1);
      return;
    }
    if (typeof node === 'object') {
      const record = node as Record<string, unknown>;
      for (const key of ['text', 'lyrics', 'structure']) {
        if (typeof record[key] === 'string') visit(record[key], depth + 1);
      }
    }
  }
  visit(value);
  const text = Array.from(new Set(chunks.map(chunk => chunk.trim()).filter(Boolean))).join('\n\n').trim();
  return text || undefined;
}

function responseShape(value: unknown): string {
  return JSON.stringify(value, (_key, val) => {
    if (typeof val === 'string' && val.length > 240) return `[string:${val.length}]`;
    return val;
  }, 2).slice(0, 3000);
}

async function downloadUrl(url: string): Promise<{ buffer: Buffer; mimeType?: string }> {
  return downloadMediaUrl(url, 'audio');
}

function isOutputModalityRoutingError(response: Response, json: unknown): boolean {
  if (response.status !== 404) return false;
  const text = typeof json === 'string' ? json : responseShape(json);
  return /no endpoints found/i.test(text) && /output modalities/i.test(text);
}

async function postOpenRouterImageRequest(
  apiKey: string,
  baseRequestBody: Record<string, unknown>,
  outputModalities: string[]
): Promise<OpenRouterImageResponse> {
  const requestBody = {
    ...baseRequestBody,
    modalities: outputModalities,
  };

  const response = await fetch(OPENROUTER_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': process.env.OPENROUTER_HTTP_REFERER || 'https://telos.local',
      'X-Title': process.env.OPENROUTER_APP_TITLE || 'Telos mediaGen',
    },
    body: JSON.stringify(requestBody),
  });

  const rawText = await response.text();
  let json: unknown;
  try {
    json = rawText ? JSON.parse(rawText) : null;
  } catch {
    json = rawText;
  }

  return { response, json, rawText, outputModalities };
}

/**
 * Generate a 30-second music clip with OpenRouter's Google Lyria 3 Clip Preview model.
 */
export async function generateMusic(options: GenerateMusicOptions | string): Promise<GenerateMusicResult> {
  const normalized = typeof options === 'string' ? { prompt: options } : options;
  const prompt = normalized?.prompt?.trim();
  if (!prompt) {
    throw new Error('mediaGen.generateMusic requires a non-empty prompt.');
  }

  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error('OPENROUTER_API_KEY is required for mediaGen.generateMusic.');
  }

  const requestBody: Record<string, unknown> = {
    model: LYRIA_3_CLIP_MODEL,
    messages: [{ role: 'user', content: prompt }],
  };

  if (typeof normalized.temperature === 'number') requestBody.temperature = normalized.temperature;
  if (typeof normalized.seed === 'number') requestBody.seed = normalized.seed;

  const response = await fetch(OPENROUTER_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': process.env.OPENROUTER_HTTP_REFERER || 'https://telos.local',
      'X-Title': process.env.OPENROUTER_APP_TITLE || 'Telos mediaGen',
    },
    body: JSON.stringify(requestBody),
  });

  const rawText = await response.text();
  let json: unknown;
  try {
    json = rawText ? JSON.parse(rawText) : null;
  } catch {
    json = rawText;
  }

  if (!response.ok) {
    throw new Error(`OpenRouter Lyria request failed: ${response.status} ${response.statusText}\n${typeof json === 'string' ? json : responseShape(json)}`);
  }

  const candidate = findAudioCandidate(json);
  if (!candidate) {
    throw new Error(`OpenRouter response did not contain recognizable audio data or URL. Response shape:\n${responseShape(json)}`);
  }

  let buffer: Buffer;
  let mimeType = candidate.mimeType;
  if (candidate.data) {
    const cleanBase64 = candidate.data.replace(/\s/g, '');
    buffer = Buffer.from(cleanBase64, 'base64');
  } else if (candidate.url) {
    const downloaded = await downloadUrl(candidate.url);
    buffer = downloaded.buffer;
    mimeType = mimeType || downloaded.mimeType;
  } else {
    throw new Error('Internal error: audio candidate had neither data nor URL.');
  }

  if (buffer.length === 0) {
    throw new Error('Generated audio was empty.');
  }

  const format = inferFormat(mimeType, candidate.format);
  mimeType = inferMimeType(format, mimeType);
  const absolutePath = resolveOutputPath(normalized.outputPath, format);
  const finalPath = path.extname(absolutePath) ? absolutePath : `${absolutePath}.${format}`;
  await mkdir(path.dirname(finalPath), { recursive: true });
  await writeFile(finalPath, buffer);

  const metadataPath = `${finalPath}.json`;
  const text = extractText(json);
  const result: GenerateMusicResult = {
    path: finalPath,
    model: LYRIA_3_CLIP_MODEL,
    provider: 'openrouter',
    prompt,
    mimeType,
    format,
    estimatedCostUsd: 0.04,
    metadataPath,
    text,
    rawResponseShape: responseShape(json),
  };

  await writeFile(metadataPath, JSON.stringify({
    ...result,
    createdAt: new Date().toISOString(),
    note: 'Generated with OpenRouter Google Lyria 3 Clip Preview. Pricing observed during implementation: about $0.04 per 30-second clip; verify OpenRouter account billing for exact cost.',
  }, null, 2) + '\n', 'utf8');

  return result;
}


/**
 * Generate or edit images through OpenRouter image-output models.
 * Defaults to Google Nano Banana 2 (Gemini 3.1 Flash Image), chosen for cheap, high-quality production-usable output.
 */
export async function generateImage(options: GenerateImageOptions | string): Promise<GenerateImageResult> {
  const normalized = typeof options === 'string' ? { prompt: options } : options;
  const prompt = normalized?.prompt?.trim();
  if (!prompt) {
    throw new Error('mediaGen.generateImage requires a non-empty prompt.');
  }

  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error('OPENROUTER_API_KEY is required for mediaGen.generateImage.');
  }

  const model = resolveImageModel(normalized.model);
  const content: unknown = normalized.inputImages?.length
    ? [
        { type: 'text', text: prompt },
        ...(await Promise.all(normalized.inputImages.map(async image => ({
          type: 'image_url',
          image_url: { url: await fileToDataUrl(image) },
        })))),
      ]
    : prompt;

  const imageConfig: Record<string, unknown> = { ...(normalized.imageConfig || {}) };
  if (normalized.aspectRatio) imageConfig.aspect_ratio = normalized.aspectRatio;
  if (normalized.imageSize) imageConfig.image_size = normalized.imageSize;

  const requestBody: Record<string, unknown> = {
    model,
    messages: [{ role: 'user', content }],
  };

  if (Object.keys(imageConfig).length > 0) requestBody.image_config = imageConfig;
  if (typeof normalized.temperature === 'number') requestBody.temperature = normalized.temperature;
  if (typeof normalized.seed === 'number') requestBody.seed = normalized.seed;

  let openRouterResult = await postOpenRouterImageRequest(apiKey, requestBody, ['image', 'text']);
  if (isOutputModalityRoutingError(openRouterResult.response, openRouterResult.json)) {
    openRouterResult = await postOpenRouterImageRequest(apiKey, requestBody, ['image']);
  }

  const { response, json, outputModalities } = openRouterResult;
  if (!response.ok) {
    throw new Error(`OpenRouter image request failed: ${response.status} ${response.statusText}
${typeof json === 'string' ? json : responseShape(json)}`);
  }

  const candidates = findImageCandidates(json);
  if (candidates.length === 0) {
    throw new Error(`OpenRouter response did not contain recognizable image data or URL. Response shape:
${responseShape(json)}`);
  }

  const paths: string[] = [];
  let firstMimeType = 'image/png';
  let firstFormat = 'png';
  const basePath = resolveOutputPath(normalized.outputPath, 'png', 'image');

  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index];
    let buffer: Buffer;
    let mimeType = candidate.mimeType;
    if (candidate.data) {
      const cleanBase64 = candidate.data.replace(/\s/g, '');
      buffer = Buffer.from(cleanBase64, 'base64');
    } else if (candidate.url) {
      const downloaded = await downloadMediaUrl(candidate.url, 'image');
      buffer = downloaded.buffer;
      mimeType = mimeType || downloaded.mimeType;
    } else {
      continue;
    }

    if (buffer.length === 0) continue;

    const format = inferImageFormat(mimeType, candidate.format);
    mimeType = inferImageMimeType(format, mimeType);
    const pathWithoutWrongExt = path.extname(basePath) ? basePath.slice(0, -path.extname(basePath).length) : basePath;
    const finalPath = candidates.length === 1
      ? (path.extname(basePath) ? basePath : `${basePath}.${format}`)
      : `${pathWithoutWrongExt}-${index + 1}.${format}`;
    await mkdir(path.dirname(finalPath), { recursive: true });
    await writeFile(finalPath, buffer);
    paths.push(finalPath);

    if (index === 0) {
      firstMimeType = mimeType;
      firstFormat = format;
    }
  }

  if (paths.length === 0) {
    throw new Error('Generated image data was empty.');
  }

  const metadataPath = `${paths[0]}.json`;
  const text = extractText(json);
  const result: GenerateImageResult = {
    path: paths[0],
    paths,
    model,
    provider: 'openrouter',
    prompt,
    mimeType: firstMimeType,
    format: firstFormat,
    estimatedCostUsd: estimateImageCostUsd(model),
    metadataPath,
    text,
    rawResponseShape: responseShape(json),
  };

  await writeFile(metadataPath, JSON.stringify({
    ...result,
    createdAt: new Date().toISOString(),
    imageConfig: Object.keys(imageConfig).length > 0 ? imageConfig : undefined,
    outputModalities,
    note: 'Generated with OpenRouter image generation. Default model is google/gemini-3.1-flash-image (Nano Banana 2), selected as a cheap/high-quality default. Verify OpenRouter billing for exact costs.',
  }, null, 2) + '\n', 'utf8');

  return result;
}
