#!/usr/bin/env node

import http from 'node:http';
import https from 'node:https';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const baseUrl = (process.env.VLLM_BASE_URL || 'http://127.0.0.1:8001/v1').replace(/\/+$/, '');
const model = process.env.VLLM_MODEL_ID || 'diffusiongemma-26b-awq';
const outputLengths = (process.env.DIFFUSION_GEMMA_BENCH_LENGTHS || '256,512,1024')
  .split(',').map((value) => Number.parseInt(value.trim(), 10)).filter(Number.isFinite);
const resultsDir = path.resolve('scripts/diffusiongemma-windows/results');

function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

function requestJson(urlString, body) {
  const url = new URL(urlString);
  const data = Buffer.from(JSON.stringify(body));
  const transport = url.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const request = transport.request({
      protocol: url.protocol, hostname: url.hostname, port: url.port,
      path: `${url.pathname}${url.search}`, method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer EMPTY', 'content-length': data.length },
      timeout: 0,
    }, async (response) => {
      const chunks = [];
      for await (const chunk of response) chunks.push(Buffer.from(chunk));
      const text = Buffer.concat(chunks).toString('utf8');
      if ((response.statusCode || 0) < 200 || (response.statusCode || 0) >= 300) {
        reject(new Error(`HTTP ${response.statusCode}: ${text.slice(0, 4000)}`));
        return;
      }
      try { resolve(JSON.parse(text)); } catch { reject(new Error(`Invalid JSON: ${text.slice(0, 2000)}`)); }
    });
    request.on('error', reject);
    request.end(data);
  });
}

function streamChat({ label, prompt, maxTokens, forceLength = false, tools, enableThinking = false }) {
  const body = {
    model, messages: [{ role: 'user', content: prompt }], stream: true,
    stream_options: { include_usage: true }, max_tokens: maxTokens, temperature: 0,
    ...(forceLength ? { min_tokens: maxTokens, ignore_eos: true } : {}),
    ...(tools ? { tools, tool_choice: 'auto' } : {}),
    ...(enableThinking ? { chat_template_kwargs: { enable_thinking: true } } : {}),
  };
  const url = new URL(`${baseUrl}/chat/completions`);
  const data = Buffer.from(JSON.stringify(body));
  const transport = url.protocol === 'https:' ? https : http;

  return new Promise((resolve, reject) => {
    const started = performance.now();
    const request = transport.request({
      protocol: url.protocol, hostname: url.hostname, port: url.port,
      path: `${url.pathname}${url.search}`, method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer EMPTY', accept: 'text/event-stream', 'content-length': data.length },
      timeout: 0,
    }, async (response) => {
      if ((response.statusCode || 0) < 200 || (response.statusCode || 0) >= 300) {
        const chunks = [];
        for await (const chunk of response) chunks.push(Buffer.from(chunk));
        reject(new Error(`${label}: HTTP ${response.statusCode}: ${Buffer.concat(chunks).toString('utf8').slice(0, 4000)}`));
        return;
      }

      let buffer = '', content = '', reasoning = '';
      let firstAt = 0, lastAt = 0, usage = null;
      let toolCalls = [];
      const gaps = [];
      for await (const chunk of response) {
        buffer += chunk.toString('utf8');
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
            const piece = delta.content || delta.reasoning_content || delta.reasoning || '';
            if (piece || delta.tool_calls) {
              const now = performance.now();
              if (!firstAt) firstAt = now;
              else if (lastAt) gaps.push(now - lastAt);
              lastAt = now;
            }
            if (delta.content) content += delta.content;
            if (delta.reasoning_content || delta.reasoning) reasoning += delta.reasoning_content || delta.reasoning;
            if (delta.tool_calls) toolCalls = toolCalls.concat(delta.tool_calls);
          }
        }
      }

      const ended = performance.now();
      const completionTokens = usage?.completion_tokens ?? 0;
      const wallSeconds = (ended - started) / 1000;
      const generationSeconds = firstAt ? (ended - firstAt) / 1000 : wallSeconds;
      resolve({
        label, max_tokens: maxTokens, forced_length: forceLength,
        prompt_tokens: usage?.prompt_tokens ?? 0, completion_tokens: completionTokens,
        wall_s: Number(wallSeconds.toFixed(3)),
        ttft_s: Number(((firstAt ? firstAt - started : ended - started) / 1000).toFixed(3)),
        wall_tok_s: Number((completionTokens / wallSeconds).toFixed(1)),
        generation_tok_s: Number((completionTokens / generationSeconds).toFixed(1)),
        gap_p50_ms: Number(percentile(gaps, 50).toFixed(1)),
        gap_p95_ms: Number(percentile(gaps, 95).toFixed(1)),
        content, reasoning, tool_calls: toolCalls,
      });
    });
    request.on('error', reject);
    request.end(data);
  });
}

const qualityCases = [
  { label: 'quality-arithmetic', prompt: 'Return only the integer result, with no explanation: (37 * 41) - (19 * 23)', maxTokens: 64, check: (text) => text.trim() === '1080' },
  { label: 'quality-arithmetic-thinking', prompt: 'Calculate (37 * 41) - (19 * 23). Return the final integer.', maxTokens: 1024, enableThinking: true, check: (text) => /(?:^|\D)1080(?:\D|$)/.test(text.trim()) },
  { label: 'quality-instruction', prompt: 'Output exactly this text and nothing else: DIFFUSION_GEMMA_READY_7391', maxTokens: 64, check: (text) => text.trim() === 'DIFFUSION_GEMMA_READY_7391' },
  { label: 'quality-code', prompt: 'Write only a JavaScript function named binarySearch(sorted, target). It must return the matching index or -1. No markdown and no prose.', maxTokens: 256, check: (text) => /function\s+binarySearch/.test(text) && /return\s+-1/.test(text) },
];

console.log(JSON.stringify({ baseUrl, model, outputLengths }, null, 2));
await requestJson(`${baseUrl}/chat/completions`, {
  model, messages: [{ role: 'user', content: 'Reply with warm.' }], max_tokens: 32, temperature: 0,
});

const results = [];
for (const length of outputLengths) {
  const result = await streamChat({
    label: `throughput-${length}`,
    prompt: 'Write a dense technical design document for a lock-free job scheduler. Continue with concrete implementation details, invariants, pseudocode, and failure analysis until the token budget is exhausted.',
    maxTokens: length, forceLength: true,
  });
  results.push(result);
  console.log(JSON.stringify({ ...result, content: result.content.slice(0, 160), reasoning: undefined }));
}

for (const test of qualityCases) {
  const result = await streamChat(test);
  result.quality_pass = test.check(result.content);
  results.push(result);
  console.log(JSON.stringify({ ...result, reasoning: result.reasoning.slice(0, 160) }));
}

const toolResult = await streamChat({
  label: 'quality-tool-call',
  prompt: 'Call the report_speed tool with tokens_per_second set to 500. Do not answer in prose.',
  maxTokens: 256,
  tools: [{ type: 'function', function: {
    name: 'report_speed', description: 'Report a measured generation speed.',
    parameters: { type: 'object', properties: { tokens_per_second: { type: 'number' } }, required: ['tokens_per_second'], additionalProperties: false },
  }}],
});
toolResult.quality_pass = toolResult.tool_calls.length > 0 || /report_speed/.test(toolResult.content);
results.push(toolResult);
console.log(JSON.stringify({ ...toolResult, content: toolResult.content.slice(0, 300), reasoning: toolResult.reasoning.slice(0, 160) }));

const summary = {
  timestamp: new Date().toISOString(), baseUrl, model,
  throughput: results.filter((item) => item.label.startsWith('throughput-')).map(({ label, completion_tokens, wall_s, ttft_s, wall_tok_s, generation_tok_s }) => ({ label, completion_tokens, wall_s, ttft_s, wall_tok_s, generation_tok_s })),
  quality: results.filter((item) => item.label.startsWith('quality-')).map(({ label, quality_pass, content, tool_calls }) => ({ label, quality_pass, content: content.slice(0, 600), tool_calls })),
};
await mkdir(resultsDir, { recursive: true });
const outputPath = path.join(resultsDir, `bench-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
await writeFile(outputPath, JSON.stringify({ summary, results }, null, 2));
console.log(JSON.stringify({ summary, outputPath }, null, 2));
