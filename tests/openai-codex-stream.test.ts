import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCodexRequest, mapCodexSseEvent, createCodexStreamAccumulator } from '../src/providers/openai-codex/invoke.js';
import { SseCodexTransport } from '../src/providers/openai-codex/transport.js';

test('mapCodexSseEvent translates text, reasoning, tool, and done events', () => {
  const state = createCodexStreamAccumulator();
  const textDelta = mapCodexSseEvent('response.output_text.delta', { delta: 'Hel' }, state);
  const reasoningDelta = mapCodexSseEvent('response.reasoning_summary.delta', { delta: 'Thinking' }, state);
  const toolDelta = mapCodexSseEvent('response.function_call_arguments.delta', { item_id: 'call_1', name: 'action', delta: '{"x":' }, state);
  const toolDone = mapCodexSseEvent('response.output_item.done', {
    item: { type: 'function_call', call_id: 'call_1', name: 'action', arguments: '{"x":1}' }
  }, state);
  const done = mapCodexSseEvent('response.completed', {}, state);

  assert.deepEqual(textDelta, [{ type: 'text.delta', delta: 'Hel' }]);
  assert.deepEqual(reasoningDelta, [{ type: 'reasoning.delta', delta: 'Thinking' }]);
  assert.equal(toolDelta[0]?.type, 'tool_call.delta');
  assert.equal(toolDone[0]?.type, 'tool_call.done');
  assert.deepEqual((toolDone[0] as any)?.toolCall?.arguments, { x: 1 });
  assert.equal(done[0]?.type, 'text.done');
  assert.equal(done[1]?.type, 'done');
});

test('SseCodexTransport parses SSE response stream', async () => {
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode('event: response.output_text.delta\ndata: {"delta":"Hello"}\n\n'));
      controller.enqueue(encoder.encode('event: response.completed\ndata: {}\n\n'));
      controller.close();
    }
  });

  const transport = new SseCodexTransport(async () => {
    return new Response(body, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    });
  });

  const events: string[] = [];
  for await (const event of transport.stream({
    endpoint: 'https://example.com',
    headers: { authorization: 'Bearer token' },
    body: {},
  })) {
    events.push(event.type + (event.delta ? `:${event.delta}` : ''));
  }

  assert.deepEqual(events, ['text.delta:Hello', 'text.done', 'done']);
});

test('buildCodexRequest disables storage for chatgpt codex backend', () => {
  const request = buildCodexRequest(
    [{ role: 'user', content: 'Reply with OK only.' }],
    { model: 'openai-codex/gpt-5-codex', stream: false }
  );

  assert.equal(request.store, false);
  assert.equal(request.stream, false);
  assert.equal(request.parallel_tool_calls, true);
  assert.deepEqual(request.include, ['reasoning.encrypted_content']);
  assert.equal('max_output_tokens' in request, false);
});

test('buildCodexRequest omits unsupported prompt cache retention', () => {
  const request = buildCodexRequest(
    [{ role: 'user', content: 'Hello' }],
    {
      model: 'openai-codex/gpt-5-codex',
      stream: true,
      providerOptions: {
        openai: {
          promptCacheKey: 'session-cache-key',
          promptCacheRetention: '24h',
        },
      },
    }
  );

  assert.equal(request.prompt_cache_key, 'session-cache-key');
  assert.equal('prompt_cache_retention' in request, false);
});

test('buildCodexRequest normalizes minimal reasoning to low', () => {
  const request = buildCodexRequest(
    [{ role: 'user', content: 'Hello' }],
    { model: 'openai-codex/gpt-5-codex', stream: true, reasoning: 'off' }
  );
  assert.equal(request.reasoning?.effort, 'low');
});

test('buildCodexRequest encodes tool history as function_call and function_call_output items', () => {
  const request = buildCodexRequest(
    [
      { role: 'user', content: 'Run tool' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'call_1', name: 'action', arguments: { content: 'FINISH("ok")' } }],
      },
      { role: 'tool', toolCallId: 'call_1', toolName: 'action', content: '{"ok":true}' },
    ],
    { model: 'openai-codex/gpt-5-codex', stream: true }
  );

  const input = request.input as Array<Record<string, unknown>>;
  assert.equal(input.length, 3);
  assert.equal(input[0]?.role, 'user');
  assert.equal(input[1]?.type, 'function_call');
  assert.equal(input[1]?.call_id, 'call_1');
  assert.equal(input[2]?.type, 'function_call_output');
  assert.equal(input[2]?.call_id, 'call_1');
});
