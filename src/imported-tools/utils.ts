import { createHash } from 'crypto';
import { access, mkdir, readFile, rm, stat, writeFile } from 'fs/promises';
import { constants } from 'fs';
import { dirname, resolve } from 'path';

export function safeJsonStringify(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

export function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

export function isoNow(): string {
  return new Date().toISOString();
}

export async function ensureDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
}

export async function writeJson(path: string, value: unknown): Promise<void> {
  await ensureDir(dirname(path));
  await writeFile(path, `${safeJsonStringify(value)}\n`, 'utf8');
}

export async function readJson<T>(path: string): Promise<T> {
  const content = await readFile(path, 'utf8');
  return JSON.parse(content) as T;
}

export async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export async function pathIsDirectory(path: string): Promise<boolean> {
  try {
    const info = await stat(path);
    return info.isDirectory();
  } catch {
    return false;
  }
}

export async function emptyDir(path: string): Promise<void> {
  await removeDir(path);
  await ensureDir(path);
}

export async function removeDir(path: string): Promise<void> {
  await rm(path, {
    recursive: true,
    force: true,
    maxRetries: 8,
    retryDelay: 200,
  });
}

export function clampText(text: string, maxLength = 8000): string {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}\n\n...[truncated]`;
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function resolveWithin(base: string, target: string): string {
  const baseResolved = resolve(base);
  const resolved = resolve(baseResolved, target);
  if (!resolved.startsWith(baseResolved)) {
    throw new Error(`Path "${target}" resolves outside "${base}".`);
  }
  return resolved;
}
