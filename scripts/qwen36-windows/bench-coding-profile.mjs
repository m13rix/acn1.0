#!/usr/bin/env node

import http from 'node:http';
import https from 'node:https';

const baseUrl = (process.env.VLLM_BASE_URL || 'http://127.0.0.1:5001/v1').replace(/\/+$/, '');
const model = process.env.VLLM_MODEL_ID || 'qwen3.6-27b-autoround';
const sizes = (process.env.QWEN36_BENCH_SIZES || '2048,8192,24576,45000')
  .split(',')
  .map((value) => Number.parseInt(value.trim(), 10))
  .filter(Number.isFinite);
const maxTokens = Number.parseInt(process.env.QWEN36_BENCH_MAX_TOKENS || '192', 10);

function buildCodeishPrompt(targetWords) {
  const chunk = `
// file: src/example/worker.ts
export async function processBatch(items: WorkItem[], state: RuntimeState) {
  const results = [];
  for (const item of items) {
    if (item.cancelled) continue;
    const previous = state.cache.get(item.id);
    const normalized = normalizeInput(item.payload, previous?.schema);
    const output = await executeStep(normalized, { retry: true, timeoutMs: 30000 });
    results.push({ id: item.id, output, changed: previous?.hash !== output.hash });
  }
  return results;
}

// file: src/example/session.ts
export class SessionCoordinator {
  constructor(private readonly store: Store, private readonly runner: Runner) {}
  async run(goal: string) {
    const snapshot = await this.store.loadLatest();
    const plan = await this.runner.plan(goal, snapshot);
    for (const step of plan.steps) {
      await this.runner.execute(step);
      await this.store.saveCheckpoint(step.id);
    }
    return this.store.summarize();
  }
}
`;
  const wordsPerChunk = chunk.trim().split(/\s+/).length;
  const repeats = Math.ceil(targetWords / wordsPerChunk);
  return `${chunk.repeat(repeats)}

Task: inspect the architecture above and give a concise implementation risk summary.
Mention the highest-risk function names and propose two concrete fixes.`;
}

function percentile(values, p) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[index];
}

async function streamRequest(promptWords, label) {
  const body = {
    model,
    messages: [{ role: 'user', content: buildCodeishPrompt(promptWords) }],
    stream: true,
    stream_options: { include_usage: true },
    max_tokens: maxTokens,
  };

  const started = performance.now();
  const response = await postStream(`${baseUrl}/chat/completions`, body);

  if ((response.statusCode || 0) < 200 || (response.statusCode || 0) >= 300) {
    const text = await readWholeResponse(response);
    throw new Error(`${label}: HTTP ${response.statusCode}: ${text.slice(0, 2000)}`);
  }

  const decoder = new TextDecoder();
  let buffer = '';
  let firstTokenAt = 0;
  let lastTokenAt = 0;
  let textChars = 0;
  let chunks = 0;
  let usage = null;
  const gaps = [];

  for await (const value of response) {
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || '';

    for (const line of lines) {
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      const event = JSON.parse(payload);
      if (event.usage) usage = event.usage;
      for (const choice of event.choices || []) {
        const delta = choice.delta || {};
        const piece = delta.content || delta.reasoning || delta.reasoning_content || '';
        if (!piece) continue;
        const now = performance.now();
        if (!firstTokenAt) {
          firstTokenAt = now;
        } else {
          gaps.push(now - lastTokenAt);
        }
        lastTokenAt = now;
        chunks += 1;
        textChars += piece.length;
      }
    }
  }

  const ended = performance.now();
  const ttft = firstTokenAt ? firstTokenAt - started : ended - started;
  const decodeWindow = firstTokenAt ? ended - firstTokenAt : 0;
  const completionTokens = usage?.completion_tokens ?? 0;
  const promptTokens = usage?.prompt_tokens ?? 0;

  return {
    label,
    promptWords,
    promptTokens,
    completionTokens,
    chunks,
    textChars,
    wall_s: Number(((ended - started) / 1000).toFixed(2)),
    ttft_s: Number((ttft / 1000).toFixed(2)),
    decode_tok_s: decodeWindow > 0 ? Number((completionTokens / (decodeWindow / 1000)).toFixed(2)) : 0,
    wall_tok_s: Number((completionTokens / ((ended - started) / 1000)).toFixed(2)),
    gap_p50_ms: Number(percentile(gaps, 50).toFixed(1)),
    gap_p95_ms: Number(percentile(gaps, 95).toFixed(1)),
    gap_max_ms: Number((gaps.length ? Math.max(...gaps) : 0).toFixed(1)),
  };
}

function postStream(urlString, body) {
  const url = new URL(urlString);
  const data = Buffer.from(JSON.stringify(body), 'utf8');
  const transport = url.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const request = transport.request({
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port,
      path: `${url.pathname}${url.search}`,
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer EMPTY',
        accept: 'text/event-stream',
        'content-length': data.length,
      },
      timeout: 0,
    }, resolve);
    request.on('error', reject);
    request.end(data);
  });
}

async function readWholeResponse(response) {
  const chunks = [];
  for await (const chunk of response) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

console.log(JSON.stringify({ baseUrl, model, sizes, maxTokens }, null, 2));
for (const size of sizes) {
  const result = await streamRequest(size, `words-${size}`);
  console.log(JSON.stringify(result));
}
