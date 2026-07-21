import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

import { InceptionProvider } from '../../src/providers/inception.js';
import { OpenAICodexProvider } from '../../src/providers/openai-codex/index.js';
import type { Message, ProviderConfig } from '../../src/types/index.js';

type SmartphoneAutomationDifficulty = 'low' | 'high';
type SmartphoneAutomationKind = 'task' | 'project';

export interface SmartphoneAutomationResult {
  requestId: string;
  kind: SmartphoneAutomationKind;
  difficulty: SmartphoneAutomationDifficulty;
  model: string;
  provider: string;
  xml: string;
  accepted: boolean;
}

interface ReadDataOptions {
  timeoutMs?: number;
}

interface MusicHistoryOptions {
  limit?: number;
  timeoutMs?: number;
}

export interface MusicStartResult {
  requestId: string;
  accepted: boolean;
}

interface TelosApiResponse {
  success?: boolean;
  error?: string;
  requestId?: string;
  kind?: SmartphoneAutomationKind;
  files?: Array<{ name?: string; path?: string; text?: string }>;
  combinedText?: string;
  accepted?: boolean;
  historyText?: string;
  response?: string;
  text?: string;
  formatted?: string;
  instructions?: { text?: string; updatedAt?: string };
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TASKER_SYSTEM_PROMPT_PATH = path.join(__dirname, 'smartphone', 'tasker_xml_system.md');
const LOW_PROVIDER = 'inception';
const LOW_MODEL = 'mercury-2';
const HIGH_PROVIDER = 'openai-codex';
const HIGH_MODEL = 'gpt-5.5';

function cleanText(value: unknown): string {
  return String(value ?? '').trim();
}

function getRealtimeAdvisorApiUrl(): string {
  const raw = (
    process.env.TELOS_REALTIME_ADVISOR_API_URL
    || process.env.TELOS_REALTIME_ADVISOR_URL
    || 'http://localhost:8787'
  ).trim();
  return raw.replace(/\/+$/, '');
}

function buildAutomationPrompt(prompt: string): string {
  return `Create a tasker task or a project (figure our yourself) to fulfil this purpose:
"""
${prompt}

"""
When a user says to "save" some data to be readable you have this rule: always save this in a llm-readable format in any files (you can create file with any name you want) .txt inside the directory Internal Storage/Telos/your_file.txt . For example, if the task to create a system that tracks app screentime, then it can save all the data into a Internal Storage/Telos/screentime.txt file, where formatted in markdown in will beautifully say how much time TODAY the user have spent with screen on (unlocked phone) - stating exactly in hours and minutes, then, a markdown on how much time have the user spend throughout this day in different apps. Then, a clean markdown summary of overall screentime this week. And that's it. Just clean llm-readable markdown`;
}

function extractTaskerXml(response: string): string {
  const match = response.match(/<TaskerData\b[\s\S]*?<\/TaskerData>/i);
  if (!match) {
    throw new Error('The model response did not contain a <TaskerData>...</TaskerData> XML block.');
  }
  return match[0].trim();
}

function classifyTaskerXml(xml: string): SmartphoneAutomationKind {
  return /<Project\b/i.test(xml) ? 'project' : 'task';
}

async function generateTaskerXml(prompt: string, difficulty: SmartphoneAutomationDifficulty): Promise<{
  xml: string;
  provider: string;
  model: string;
}> {
  const system = await readFile(TASKER_SYSTEM_PROMPT_PATH, 'utf8');
  const messages: Message[] = [
    { role: 'system', content: system },
    { role: 'user', content: buildAutomationPrompt(prompt) },
  ];
  const config: ProviderConfig = difficulty === 'high'
    ? { model: HIGH_MODEL, provider: HIGH_PROVIDER, reasoning: 'medium', maxTokens: 16000, stream: false }
    : { model: LOW_MODEL, provider: LOW_PROVIDER, reasoning: 'medium', maxTokens: 12000, stream: false };
  const provider = difficulty === 'high'
    ? new OpenAICodexProvider()
    : new InceptionProvider();
  const response = await provider.complete(messages, config);
  return {
    xml: extractTaskerXml(response.content || ''),
    provider: difficulty === 'high' ? HIGH_PROVIDER : LOW_PROVIDER,
    model: difficulty === 'high' ? HIGH_MODEL : LOW_MODEL,
  };
}

async function postTelosApi(pathname: string, payload: Record<string, unknown>, timeoutMs = 60_000): Promise<TelosApiResponse> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${getRealtimeAdvisorApiUrl()}${pathname}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const text = await response.text();
    const body = (text ? JSON.parse(text) : {}) as TelosApiResponse;
    if (!response.ok || body.success === false) {
      throw new Error(body.error || text || `Telos API returned HTTP ${response.status}.`);
    }
    return body;
  } finally {
    clearTimeout(timeout);
  }
}

async function getTelosApi(pathname: string, timeoutMs = 30_000): Promise<TelosApiResponse> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${getRealtimeAdvisorApiUrl()}${pathname}`, {
      method: 'GET',
      signal: controller.signal,
    });
    const text = await response.text();
    const body = (text ? JSON.parse(text) : {}) as TelosApiResponse;
    if (!response.ok || body.success === false) {
      throw new Error(body.error || text || `Telos API returned HTTP ${response.status}.`);
    }
    return body;
  } finally {
    clearTimeout(timeout);
  }
}

async function automation(prompt: string, difficulty: SmartphoneAutomationDifficulty = 'low'): Promise<SmartphoneAutomationResult> {
  const normalizedPrompt = cleanText(prompt);
  if (!normalizedPrompt) {
    throw new Error('telos.smartphone.automation(prompt): prompt must be a non-empty string.');
  }
  if (difficulty !== 'low' && difficulty !== 'high') {
    throw new Error('telos.smartphone.automation difficulty must be "low" or "high".');
  }

  const generated = await generateTaskerXml(normalizedPrompt, difficulty);
  const kind = classifyTaskerXml(generated.xml);
  const requestId = `automation_${randomUUID()}`;
  await postTelosApi('/v1/telos/smartphone/automation', {
    requestId,
    kind,
    xml: generated.xml,
  }, 15_000);

  return {
    requestId,
    kind,
    difficulty,
    provider: generated.provider,
    model: generated.model,
    xml: generated.xml,
    accepted: true,
  };
}

async function readData(options: ReadDataOptions = {}): Promise<string> {
  const requestId = `read_${randomUUID()}`;
  const timeoutMs = Math.max(1_000, Math.min(120_000, Number(options.timeoutMs) || 120_000));
  const body = await postTelosApi('/v1/telos/smartphone/read-data', { requestId, timeoutMs }, timeoutMs + 5_000);
  if (typeof body.combinedText === 'string') {
    return body.combinedText;
  }
  const files = Array.isArray(body.files) ? body.files : [];
  if (files.length === 0) {
    return 'No .txt files found in Internal Storage/Telos.';
  }
  return files.map((file) => {
    const name = cleanText(file.name || file.path || 'unknown.txt');
    return `# ${name}\n\n${String(file.text || '').trim()}`;
  }).join('\n\n---\n\n');
}

async function start(moodInstruction: string): Promise<MusicStartResult> {
  const normalizedMood = cleanText(moodInstruction);
  if (!normalizedMood) {
    throw new Error('telos.music.start(moodInstruction): moodInstruction must be a non-empty string.');
  }
  const requestId = `music_start_${randomUUID()}`;
  const body = await postTelosApi('/v1/telos/music/start', {
    requestId,
    moodInstruction: normalizedMood,
  }, 15_000);
  return {
    requestId: String(body.requestId || requestId),
    accepted: body.accepted !== false,
  };
}

async function history(options: MusicHistoryOptions = {}): Promise<string> {
  const requestId = `music_history_${randomUUID()}`;
  const timeoutMs = Math.max(1_000, Math.min(120_000, Number(options.timeoutMs) || 30_000));
  const limit = Math.max(1, Math.min(200, Number(options.limit) || 25));
  const body = await postTelosApi('/v1/telos/music/history', {
    requestId,
    timeoutMs,
    limit,
  }, timeoutMs + 5_000);
  return typeof body.historyText === 'string'
    ? body.historyText
    : 'No Telos Music history returned.';
}

async function getAdvisorInstructions(): Promise<string> {
  const body = await getTelosApi('/v1/context/instructions');
  return typeof body.text === 'string'
    ? body.text
    : String(body.instructions?.text || '');
}

async function setAdvisorInstructions(text: string): Promise<string> {
  const body = await postTelosApi('/v1/context/instructions', {
    text: String(text || ''),
  }, 15_000);
  return typeof body.text === 'string'
    ? body.text
    : String(body.instructions?.text || '');
}

async function callAdvisor(instruction: string): Promise<string> {
  const normalized = cleanText(instruction);
  if (!normalized) {
    throw new Error('telos.advisor.call(instruction): instruction must be a non-empty string.');
  }
  const body = await postTelosApi('/v1/telos/advisor/call', {
    instruction: normalized,
  }, 120_000);
  return typeof body.response === 'string'
    ? body.response
    : '';
}

export const smartphone = {
  automation,
  readData,
};

export const music = {
  start,
  history,
};

const advisorInstructions = {
  get: getAdvisorInstructions,
  set: setAdvisorInstructions,
};

export const advisor = {
  instructions: advisorInstructions,
  instuctions: advisorInstructions,
  call: callAdvisor,
};
