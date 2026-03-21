import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { spawn } from 'child_process';
import { readFile } from 'fs/promises';
import { resolve } from 'path';
import { fileURLToPath } from 'url';
import type { ImportedIntegrationManifest, NormalizedMethodSpec } from '../types/index.js';
import { IMPORTED_TOOLS_MCP_CALL_TIMEOUT_MS } from './constants.js';
import { validateSchema } from './jsonSchema.js';
import { isPlainObject } from './utils.js';

const manifestCache = new Map<string, ImportedIntegrationManifest>();
const clientCache = new Map<string, Promise<{ client: Client; transport: StdioClientTransport }>>();
const stderrCache = new Map<string, string[]>();
const idleCleanupTimers = new Map<string, NodeJS.Timeout>();
const IMPORTED_RUNTIME_IDLE_DISPOSE_MS = 250;

async function loadManifest(manifestPath: string | URL): Promise<ImportedIntegrationManifest> {
  const absolutePath = manifestPath instanceof URL
    ? fileURLToPath(manifestPath)
    : resolve(manifestPath);
  if (manifestCache.has(absolutePath)) {
    return manifestCache.get(absolutePath)!;
  }
  const manifest = JSON.parse(await readFile(absolutePath, 'utf8')) as ImportedIntegrationManifest;
  manifestCache.set(absolutePath, manifest);
  return manifest;
}

function getMethod(manifest: ImportedIntegrationManifest, methodName: string): NormalizedMethodSpec {
  const method = manifest.methods.find((entry) => entry.methodName === methodName);
  if (!method) {
    throw new Error(`Imported method "${methodName}" was not found in ${manifest.namespace}.`);
  }
  return method;
}

async function getClient(manifest: ImportedIntegrationManifest): Promise<{ client: Client; transport: StdioClientTransport }> {
  const existingTimer = idleCleanupTimers.get(manifest.id);
  if (existingTimer) {
    clearTimeout(existingTimer);
    idleCleanupTimers.delete(manifest.id);
  }

  if (!clientCache.has(manifest.id)) {
    clientCache.set(manifest.id, (async () => {
      const transport = new StdioClientTransport({
        command: manifest.runtime.command,
        args: manifest.runtime.args,
        cwd: manifest.runtime.cwd || manifest.runtime.runtimeDir,
        env: manifest.runtime.env,
        stderr: 'pipe',
      });
      const stderrLines: string[] = [];
      transport.stderr?.on('data', (chunk) => {
        const text = String(chunk.toString());
        stderrLines.push(text);
        while (stderrLines.length > 30) {
          stderrLines.shift();
        }
      });
      stderrCache.set(manifest.id, stderrLines);
      const client = new Client({ name: 'acn-imported-runtime', version: '1.0.0' }, { capabilities: {} });
      await withTimeout(
        client.connect(transport),
        IMPORTED_TOOLS_MCP_CALL_TIMEOUT_MS,
        `MCP connect ${manifest.namespace}`
      );
      return { client, transport };
    })());
  }
  return clientCache.get(manifest.id)!;
}

function getRecentStderr(manifestId: string): string {
  return (stderrCache.get(manifestId) || []).join('').trim();
}

function scheduleIdleCleanup(manifestId: string): void {
  const existingTimer = idleCleanupTimers.get(manifestId);
  if (existingTimer) {
    clearTimeout(existingTimer);
  }

  const timer = setTimeout(() => {
    idleCleanupTimers.delete(manifestId);
    disposeImportedRuntime(manifestId).catch(() => {});
  }, IMPORTED_RUNTIME_IDLE_DISPOSE_MS);
  timer.unref?.();
  idleCleanupTimers.set(manifestId, timer);
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms.`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function applyMcpDefaults(method: NormalizedMethodSpec, input: Record<string, unknown>): Record<string, unknown> {
  if (!isPlainObject(method.inputSchema?.properties)) {
    return input;
  }

  const properties = method.inputSchema.properties as Record<string, Record<string, unknown>>;
  if ('response_format' in input || !properties.response_format) {
    return input;
  }

  const responseSchema = properties.response_format;
  const enumValues = Array.isArray(responseSchema.enum) ? responseSchema.enum.map(String) : [];
  if (enumValues.includes('json')) {
    return {
      ...input,
      response_format: 'json',
    };
  }

  return input;
}

function normalizeMcpOutput(result: unknown): unknown {
  if (!isPlainObject(result)) {
    return result;
  }
  if ('structuredContent' in result) {
    return result.structuredContent;
  }
  if ('toolResult' in result) {
    return result.toolResult;
  }
  const content = Array.isArray(result.content) ? result.content : [];
  const textBlocks = content
    .filter((entry) => isPlainObject(entry) && entry.type === 'text' && typeof entry.text === 'string')
    .map((entry) => String(entry.text));
  if (textBlocks.length === 1) return textBlocks[0];
  if (textBlocks.length > 1) return textBlocks.join('\n\n');
  return result;
}

async function invokeMcp(manifest: ImportedIntegrationManifest, method: NormalizedMethodSpec, input: Record<string, unknown>): Promise<unknown> {
  const normalizedInput = applyMcpDefaults(method, input);
  const validation = validateSchema(method.inputSchema, normalizedInput);
  if (!validation.ok) {
    throw new Error(`Invalid input for ${manifest.namespace}.${method.methodName}: ${validation.errors.join('; ')}`);
  }
  try {
    const { client } = await getClient(manifest);
    const result = await withTimeout(client.callTool({
      name: method.invocation.kind === 'mcp' ? method.invocation.toolName : method.originalName,
      arguments: normalizedInput,
    }), IMPORTED_TOOLS_MCP_CALL_TIMEOUT_MS, `MCP call ${manifest.namespace}.${method.methodName}`);
    if ('isError' in result && result.isError) {
      throw new Error(String(normalizeMcpOutput(result)));
    }
    return normalizeMcpOutput(result);
  } catch (error) {
    const recentStderr = getRecentStderr(manifest.id);
    await disposeImportedRuntime(manifest.id);
    const suffix = recentStderr ? `\nRecent MCP stderr:\n${recentStderr}` : '';
    throw new Error(`${error instanceof Error ? error.message : String(error)}${suffix}`);
  } finally {
    scheduleIdleCleanup(manifest.id);
  }
}

function buildClawhubArgs(method: NormalizedMethodSpec, input: Record<string, unknown>): string[] {
  if (method.invocation.kind !== 'clawhub') {
    throw new Error('ClawHub invocation expected.');
  }
  const args = [...method.invocation.segments];
  for (const option of method.invocation.options) {
    const value = input[option.name];
    if (option.kind === 'flag') {
      if (value) args.push(option.token);
      continue;
    }
    if (option.kind === 'option') {
      if (value !== undefined && value !== null && value !== '') {
        args.push(option.token, String(value));
      }
      continue;
    }
    if (value === undefined || value === null || value === '') {
      if (option.required) {
        throw new Error(`Missing required positional argument "${option.name}".`);
      }
      continue;
    }
    args.push(String(value));
  }
  return args;
}

async function invokeClawhub(manifest: ImportedIntegrationManifest, method: NormalizedMethodSpec, input: Record<string, unknown>): Promise<string> {
  const invocation = method.invocation;
  if (invocation.kind !== 'clawhub') {
    throw new Error('ClawHub invocation expected.');
  }
  const validation = validateSchema(method.inputSchema, input);
  if (!validation.ok) {
    throw new Error(`Invalid input for ${manifest.namespace}.${method.methodName}: ${validation.errors.join('; ')}`);
  }
  const args = buildClawhubArgs(method, input);
  return new Promise((resolvePromise, reject) => {
    const proc = spawn(invocation.binary, args, {
      cwd: manifest.runtime.cwd || manifest.runtime.runtimeDir,
      env: { ...process.env, ...(manifest.runtime.env || {}) },
      shell: false,
    });
    const stdout: string[] = [];
    const stderr: string[] = [];
    proc.stdout.on('data', (chunk) => stdout.push(chunk.toString()));
    proc.stderr.on('data', (chunk) => stderr.push(chunk.toString()));
    proc.on('error', reject);
    proc.on('close', (code) => {
      const output = stdout.join('').trim();
      const error = stderr.join('').trim();
      if (code !== 0) {
        reject(new Error(error || output || `Command exited with code ${code}.`));
        return;
      }
      resolvePromise(output);
    });
  });
}

process.once('exit', () => {
  for (const pending of clientCache.values()) {
    pending.then(({ transport }) => transport.close()).catch(() => {});
  }
});

export async function disposeImportedRuntime(manifestId?: string): Promise<void> {
  const entries = manifestId
    ? Array.from(clientCache.entries()).filter(([id]) => id === manifestId)
    : Array.from(clientCache.entries());

  await Promise.all(entries.map(async ([id, pending]) => {
    try {
      const { transport } = await pending;
      await transport.close();
    } catch {
      // Best-effort cleanup only.
    } finally {
      clientCache.delete(id);
      stderrCache.delete(id);
      const timer = idleCleanupTimers.get(id);
      if (timer) {
        clearTimeout(timer);
        idleCleanupTimers.delete(id);
      }
    }
  }));
}

export function isImportedInputObject(value: unknown): value is Record<string, unknown> {
  return isPlainObject(value);
}

export async function invokeImportedMethod(
  manifestPath: string | URL,
  methodName: string,
  input: Record<string, unknown>
): Promise<unknown> {
  const manifest = await loadManifest(manifestPath);
  const method = getMethod(manifest, methodName);
  if (method.invocation.kind === 'mcp') {
    return invokeMcp(manifest, method, input);
  }
  return invokeClawhub(manifest, method, input);
}
