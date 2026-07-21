import { createReadStream } from 'fs';
import path from 'path';
import type {
  AssemblyAiDiarizationOutput,
  AssemblyAiJob,
} from './types.js';

export interface AssemblyAiClientOptions {
  apiKey?: string;
  apiBaseUrl: string;
  mock?: boolean;
}

const DEFAULT_JOB_TIMEOUT_MS = 180_000;
const DEFAULT_POLL_INTERVAL_MS = 1800;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeBaseUrl(value: string): string {
  return value.replace(/\/+$/, '');
}

function normalizeJob(payload: Record<string, unknown>): AssemblyAiJob<AssemblyAiDiarizationOutput> {
  return {
    jobId: String(payload['id'] || '').trim(),
    status: String(payload['status'] || 'queued') as AssemblyAiJob['status'],
    createdAt: typeof payload['created'] === 'string' ? payload['created'] : undefined,
    updatedAt: typeof payload['completed'] === 'string' ? payload['completed'] : undefined,
    output: normalizeOutput(payload),
    warning: typeof payload['warning'] === 'string' ? payload['warning'] : undefined,
    error: typeof payload['error'] === 'string' ? payload['error'] : undefined,
  };
}

function normalizeOutput(payload: Record<string, unknown>): AssemblyAiDiarizationOutput {
  const utterances = Array.isArray(payload['utterances'])
    ? payload['utterances']
      .filter((item): item is Record<string, unknown> => !!item && typeof item === 'object' && !Array.isArray(item))
      .map((item) => ({
        speaker: String(item['speaker'] || '[...]'),
        start: Math.max(0, Number(item['start']) || 0) / 1000,
        end: Math.max(0, Number(item['end']) || Number(item['start']) || 0) / 1000,
        text: String(item['text'] || '').trim(),
        confidence: typeof item['confidence'] === 'number' ? item['confidence'] : undefined,
      }))
    : [];

  return {
    text: typeof payload['text'] === 'string' ? payload['text'] : undefined,
    utterances,
    warning: typeof payload['warning'] === 'string' ? payload['warning'] : undefined,
    error: typeof payload['error'] === 'string' ? payload['error'] : undefined,
  };
}

export class AssemblyAiClient {
  private readonly apiKey?: string;
  private readonly apiBaseUrl: string;
  private readonly mock: boolean;

  constructor(options: AssemblyAiClientOptions) {
    this.apiKey = options.apiKey?.trim();
    this.apiBaseUrl = normalizeBaseUrl(options.apiBaseUrl || 'https://api.assemblyai.com');
    this.mock = options.mock === true;
  }

  isEnabled(): boolean {
    return this.mock || !!this.apiKey;
  }

  isMock(): boolean {
    return this.mock || !this.apiKey;
  }

  async uploadMedia(filePath: string): Promise<string> {
    if (this.isMock()) {
      return `mock://assemblyai/${path.basename(filePath)}`;
    }

    const response = await fetch(`${this.apiBaseUrl}/v2/upload`, {
      method: 'POST',
      headers: {
        Authorization: this.requireApiKey(),
        'Content-Type': 'application/octet-stream',
      },
      body: createReadStream(filePath) as unknown,
      duplex: 'half',
    } as RequestInit & { duplex: 'half' });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`AssemblyAI upload failed: HTTP ${response.status} ${text}`);
    }
    const payload = text ? JSON.parse(text) as Record<string, unknown> : {};
    const uploadUrl = payload['upload_url'];
    if (typeof uploadUrl !== 'string' || !uploadUrl.trim()) {
      throw new Error(`AssemblyAI upload response missing upload_url: ${JSON.stringify(payload)}`);
    }
    return uploadUrl.trim();
  }

  async transcribe(uploadUrl: string): Promise<AssemblyAiJob<AssemblyAiDiarizationOutput>> {
    if (this.isMock()) {
      return {
        jobId: `mock_assemblyai_${Date.now()}`,
        status: 'completed',
        output: {
          utterances: [],
        },
      };
    }

    const response = await this.request<Record<string, unknown>>('/v2/transcript', {
      method: 'POST',
      body: JSON.stringify({
        audio_url: uploadUrl,
        language_code: 'ru',
        format_text: true,
        punctuate: true,
        speech_models: ['universal-3-5-pro'],
        speaker_labels: true,
      }),
    });
    const job = normalizeJob(response);
    if (!job.jobId) {
      throw new Error(`AssemblyAI transcript response missing id: ${JSON.stringify(response)}`);
    }
    return job;
  }

  async waitForJob(
    job: AssemblyAiJob<AssemblyAiDiarizationOutput>,
    options: { timeoutMs?: number; pollIntervalMs?: number } = {},
  ): Promise<AssemblyAiJob<AssemblyAiDiarizationOutput>> {
    if (job.status === 'completed' || job.status === 'error') {
      return job;
    }
    if (this.isMock()) {
      return { ...job, status: 'completed' };
    }

    const timeoutMs = options.timeoutMs ?? DEFAULT_JOB_TIMEOUT_MS;
    const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    const startedAt = Date.now();

    while (Date.now() - startedAt <= timeoutMs) {
      await sleep(pollIntervalMs);
      const latest = await this.getJob(job.jobId);
      if (latest.status === 'completed' || latest.status === 'error') {
        return latest;
      }
    }

    throw new Error(`Timed out waiting for AssemblyAI transcript ${job.jobId}`);
  }

  async getJob(jobId: string): Promise<AssemblyAiJob<AssemblyAiDiarizationOutput>> {
    if (this.isMock()) {
      return {
        jobId,
        status: 'completed',
      };
    }
    const response = await this.request<Record<string, unknown>>(`/v2/transcript/${encodeURIComponent(jobId)}`, {
      method: 'GET',
    });
    return normalizeJob(response);
  }

  private async request<T>(endpoint: string, init: RequestInit): Promise<T> {
    const response = await fetch(`${this.apiBaseUrl}${endpoint}`, {
      ...init,
      headers: {
        Authorization: this.requireApiKey(),
        'Content-Type': 'application/json',
        ...(init.headers || {}),
      },
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`AssemblyAI ${endpoint} failed: HTTP ${response.status} ${text}`);
    }
    if (!text.trim()) {
      return {} as T;
    }
    return JSON.parse(text) as T;
  }

  private requireApiKey(): string {
    if (!this.apiKey) {
      throw new Error('ASSEMBLYAI_API_KEY is not configured.');
    }
    return this.apiKey;
  }
}
