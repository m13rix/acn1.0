import { spawn } from 'child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'fs/promises';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { createProvider } from '../../src/providers/factory.js';
import type { Message } from '../../src/types/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = process.env.PROJECT_ROOT
  ? resolve(process.env.PROJECT_ROOT)
  : resolve(__dirname, '..', '..');
const SYSTEM_PROMPT_PATH = join(__dirname, 'system.md');
const RUNS_ROOT = join(__dirname, '.runs');

const DEFAULT_PROVIDER = 'openai-codex';
const DEFAULT_MODEL = 'gpt-5.4-mini';
const DEFAULT_REASONING = 'low' as const;
const DEFAULT_MAX_TOKENS = 12000;
const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_TIMEOUT_MS = 20 * 60 * 1000;
const MAX_ERROR_CHARS = 12000;

export interface ScriptExecutionResult {
  success: boolean;
  output: string;
  errorText: string;
}

export interface RunConductTestDeps {
  systemPrompt: string;
  maxAttempts?: number;
  generate(messages: Message[]): Promise<string>;
  execute(script: string): Promise<ScriptExecutionResult>;
}

function normalizePrompt(prompt: string): string {
  if (typeof prompt !== 'string' || !prompt.trim()) {
    throw new Error('Prompt must be a non-empty string.');
  }

  return prompt.trim();
}

function toPositiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function trimTrailingWhitespace(text: string): string {
  return text.replace(/\s+$/g, '');
}

function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, maxChars)}\n...[truncated]`;
}

export function buildTestPrompt(prompt: string): string {
  return `Write a test (If it is a test for player abilities - then the player to test is not the bot but the player nicknamed M13RIX. Always use botname - Telos):  ${normalizePrompt(prompt)}`;
}

export function extractFirstCodeFence(content: string): string {
  const match = String(content || '').match(/```(?:[a-zA-Z0-9_-]+)?\s*\n([\s\S]*?)```/);
  if (!match?.[1]) {
    throw new Error('Model response did not contain a fenced code block.');
  }

  const code = trimTrailingWhitespace(match[1]);
  if (!code) {
    throw new Error('The first fenced code block was empty.');
  }

  return code;
}

function buildMissingCodeFeedback(): string {
  return [
    'Your previous response did not include a usable fenced code block.',
    'Return the FULL corrected script in a single ```javascript fenced block.',
    'Do not include explanations outside the code block.',
  ].join(' ');
}

function buildRepairFeedback(errorText: string): string {
  return [
    'The previous script failed when executed in the actual Minecraft environment.',
    'Fix the script and return the FULL corrected code in a single ```javascript fenced block.',
    'Do not return partial diffs or explanations.',
    '',
    'Execution error:',
    truncate(errorText, MAX_ERROR_CHARS),
  ].join('\n');
}

async function loadSystemPrompt(): Promise<string> {
  try {
    return await readFile(SYSTEM_PROMPT_PATH, 'utf8');
  } catch (error: any) {
    throw new Error(`Failed to read Minecraft tool system prompt at ${SYSTEM_PROMPT_PATH}: ${error?.message || String(error)}`);
  }
}

function buildExecutionError(reason: string, stdout: string, stderr: string): string {
  const parts = [reason.trim()];
  const cleanStdout = trimTrailingWhitespace(stdout);
  const cleanStderr = trimTrailingWhitespace(stderr);

  if (cleanStderr) {
    parts.push(`STDERR:\n${cleanStderr}`);
  }

  if (cleanStdout) {
    parts.push(`STDOUT:\n${cleanStdout}`);
  }

  return parts.join('\n\n');
}

async function executeGeneratedScript(script: string): Promise<ScriptExecutionResult> {
  await mkdir(RUNS_ROOT, { recursive: true });

  const tempDir = await mkdtemp(join(RUNS_ROOT, 'run-'));
  const scriptPath = join(tempDir, 'generated-test.cjs');

  try {
    await writeFile(scriptPath, script, 'utf8');

    const timeoutMs = toPositiveInteger(process.env.MINECRAFT_TEST_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);

    return await new Promise<ScriptExecutionResult>((resolve) => {
      const stdoutChunks: string[] = [];
      const stderrChunks: string[] = [];
      let timedOut = false;
      let settled = false;

      const finish = (result: ScriptExecutionResult) => {
        if (settled) {
          return;
        }
        settled = true;
        resolve(result);
      };

      const proc = spawn(process.execPath, [scriptPath], {
        cwd: PROJECT_ROOT,
        env: {
          ...process.env,
          PROJECT_ROOT,
        },
        shell: false,
      });

      const timeout = setTimeout(() => {
        timedOut = true;
        proc.kill();
      }, timeoutMs);

      proc.stdout.on('data', (chunk) => {
        stdoutChunks.push(chunk.toString());
      });

      proc.stderr.on('data', (chunk) => {
        stderrChunks.push(chunk.toString());
      });

      proc.on('error', (error) => {
        clearTimeout(timeout);
        const stdout = stdoutChunks.join('');
        const stderr = stderrChunks.join('');
        finish({
          success: false,
          output: '',
          errorText: buildExecutionError(`Failed to start generated script: ${error.message}`, stdout, stderr),
        });
      });

      proc.on('close', (code) => {
        clearTimeout(timeout);

        const stdout = stdoutChunks.join('');
        const stderr = stderrChunks.join('');

        if (timedOut) {
          finish({
            success: false,
            output: '',
            errorText: buildExecutionError(`Generated script timed out after ${timeoutMs}ms.`, stdout, stderr),
          });
          return;
        }

        if (code === 0) {
          finish({
            success: true,
            output: trimTrailingWhitespace(stdout),
            errorText: '',
          });
          return;
        }

        finish({
          success: false,
          output: '',
          errorText: buildExecutionError(`Generated script exited with code ${code}.`, stdout, stderr),
        });
      });
    });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

export async function runConductTest(prompt: string, deps: RunConductTestDeps): Promise<string> {
  const normalizedPrompt = normalizePrompt(prompt);
  const maxAttempts = Number.isInteger(deps.maxAttempts) && (deps.maxAttempts || 0) > 0
    ? deps.maxAttempts as number
    : DEFAULT_MAX_ATTEMPTS;

  const messages: Message[] = [];
  if (deps.systemPrompt.trim()) {
    messages.push({ role: 'system', content: deps.systemPrompt.trim() });
  }
  messages.push({ role: 'user', content: buildTestPrompt(normalizedPrompt) });

  let lastError = 'Unknown error';

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const rawResponse = await deps.generate(messages);
    const assistantContent = String(rawResponse || '').trim();
    messages.push({ role: 'assistant', content: assistantContent });

    let script: string;
    try {
      script = extractFirstCodeFence(assistantContent);
    } catch (error: any) {
      lastError = error?.message || String(error);
      if (attempt < maxAttempts) {
        messages.push({ role: 'user', content: buildMissingCodeFeedback() });
        continue;
      }
      break;
    }

    const execution = await deps.execute(script);
    if (execution.success) {
      return execution.output;
    }

    lastError = execution.errorText || 'Generated script failed with an unknown error.';
    if (attempt < maxAttempts) {
      messages.push({ role: 'user', content: buildRepairFeedback(lastError) });
    }
  }

  throw new Error(`minecraft.conductTest failed after ${maxAttempts} attempts: ${lastError}`);
}

export async function conductTest(prompt: string): Promise<string> {
  const systemPrompt = await loadSystemPrompt();
  const provider = createProvider(process.env.MINECRAFT_TEST_PROVIDER || DEFAULT_PROVIDER);

  return runConductTest(prompt, {
    systemPrompt,
    maxAttempts: toPositiveInteger(process.env.MINECRAFT_TEST_MAX_ATTEMPTS, DEFAULT_MAX_ATTEMPTS),
    generate: async (messages) => {
      const response = await provider.complete(messages, {
        model: process.env.MINECRAFT_TEST_MODEL || DEFAULT_MODEL,
        temperature: 0.2,
        maxTokens: DEFAULT_MAX_TOKENS,
        stream: false,
        reasoning: DEFAULT_REASONING,
      });

      return response.content || '';
    },
    execute: executeGeneratedScript,
  });
}

export const __internals = {
  buildExecutionError,
  buildTestPrompt,
  extractFirstCodeFence,
  runConductTest,
  trimTrailingWhitespace,
};
