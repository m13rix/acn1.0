import { readFile } from 'fs/promises';
import path from 'path';
import type {
  PyannoteDiarizationOutput,
  PyannoteJob,
} from './types.js';

export interface PyannoteClientOptions {
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

function getJobId(payload: Record<string, unknown>): string {
  const value = payload['jobId'] ?? payload['job_id'] ?? payload['id'];
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`pyannote response did not contain a job id: ${JSON.stringify(payload)}`);
  }
  return value.trim();
}

function normalizeJob<TOutput>(payload: Record<string, unknown>): PyannoteJob<TOutput> {
  return {
    jobId: getJobId(payload),
    status: String(payload['status'] || 'pending') as PyannoteJob<TOutput>['status'],
    createdAt: typeof payload['createdAt'] === 'string' ? payload['createdAt'] : undefined,
    updatedAt: typeof payload['updatedAt'] === 'string' ? payload['updatedAt'] : undefined,
    output: payload['output'] as TOutput | undefined,
    warning: typeof payload['warning'] === 'string' ? payload['warning'] : undefined,
    error: typeof payload['error'] === 'string' ? payload['error'] : undefined,
  };
}

export class PyannoteClient {
  private readonly apiKey?: string;
  private readonly apiBaseUrl: string;
  private readonly mock: boolean;

  constructor(options: PyannoteClientOptions) {
    this.apiKey = options.apiKey?.trim();
    this.apiBaseUrl = normalizeBaseUrl(options.apiBaseUrl || 'https://api.pyannote.ai');
    this.mock = options.mock === true;
  }

  isEnabled(): boolean {
    return this.mock || !!this.apiKey;
  }

  isMock(): boolean {
    return this.mock || !this.apiKey;
  }

  async uploadMedia(filePath: string, objectName?: string): Promise<string> {
    if (this.isMock()) {
      return `media://mock/${path.basename(filePath)}`;
    }

    const objectKey = objectName || `telos/realtime/${Date.now()}-${path.basename(filePath)}`;
    const mediaUrl = `media://${objectKey.replace(/^\/+/, '')}`;
    const uploadRequest = await this.request<Record<string, unknown>>('/v1/media/input', {
      method: 'POST',
      body: JSON.stringify({ url: mediaUrl }),
    });
    const presignedUrl = uploadRequest['url'];
    if (typeof presignedUrl !== 'string' || !presignedUrl) {
      throw new Error(`pyannote upload response missing presigned URL: ${JSON.stringify(uploadRequest)}`);
    }

    const audio = await readFile(filePath);
    const uploadResponse = await fetch(presignedUrl, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/octet-stream',
      },
      body: audio,
    });
    if (!uploadResponse.ok) {
      throw new Error(`pyannote media upload failed: HTTP ${uploadResponse.status} ${await uploadResponse.text()}`);
    }

    return mediaUrl;
  }

  async diarize(mediaUrl: string): Promise<PyannoteJob<PyannoteDiarizationOutput>> {
    if (this.isMock()) {
      return {
        jobId: `mock_diarize_${Date.now()}`,
        status: 'succeeded',
        output: {
          diarization: [],
          turnLevelTranscription: [],
        },
      };
    }

    const response = await this.request<Record<string, unknown>>('/v1/diarize', {
      method: 'POST',
      body: JSON.stringify({
        url: mediaUrl,
        model: 'precision-2',
        confidence: true,
        turnLevelConfidence: true,
        exclusive: true,
        transcription: true,
        transcriptionConfig: {
          model: 'parakeet-tdt-0.6b-v3',
        },
      }),
    });
    return normalizeJob<PyannoteDiarizationOutput>(response);
  }

  async waitForJob<TOutput>(
    job: PyannoteJob<TOutput>,
    options: { timeoutMs?: number; pollIntervalMs?: number } = {},
  ): Promise<PyannoteJob<TOutput>> {
    if (job.status === 'succeeded' || job.status === 'failed' || job.status === 'canceled') {
      return job;
    }
    if (this.isMock()) {
      return { ...job, status: 'succeeded' };
    }

    const timeoutMs = options.timeoutMs ?? DEFAULT_JOB_TIMEOUT_MS;
    const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    const startedAt = Date.now();

    while (Date.now() - startedAt <= timeoutMs) {
      await sleep(pollIntervalMs);
      const latest = await this.getJob<TOutput>(job.jobId);
      if (latest.status === 'succeeded' || latest.status === 'failed' || latest.status === 'canceled') {
        return latest;
      }
    }

    throw new Error(`Timed out waiting for pyannote job ${job.jobId}`);
  }

  async getJob<TOutput>(jobId: string): Promise<PyannoteJob<TOutput>> {
    if (this.isMock()) {
      return {
        jobId,
        status: 'succeeded',
      };
    }
    const response = await this.request<Record<string, unknown>>(`/v1/jobs/${encodeURIComponent(jobId)}`, {
      method: 'GET',
    });
    return normalizeJob<TOutput>(response);
  }

  private async request<T>(endpoint: string, init: RequestInit): Promise<T> {
    if (!this.apiKey) {
      throw new Error('PYANNOTE_API_KEY is not configured.');
    }

    const response = await fetch(`${this.apiBaseUrl}${endpoint}`, {
      ...init,
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
        ...(init.headers || {}),
      },
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`pyannote ${endpoint} failed: HTTP ${response.status} ${text}`);
    }
    if (!text.trim()) {
      return {} as T;
    }
    return JSON.parse(text) as T;
  }
}
