import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

import {
  appendAgentTextLog,
  buildAgentCallTextResult,
  readAgentTextLog,
} from '../agentTextLog.js';

test('buildAgentCallTextResult returns only the terminal response, never intermediate text', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'telos-agent-text-log-'));
  const logPath = join(dir, 'call.jsonl');

  try {
    appendAgentTextLog(logPath, 'assistant_text', 'First visible message');
    appendAgentTextLog(logPath, 'assistant_text', 'Intermediate progress after a tool call');
    appendAgentTextLog(logPath, 'response', 'Final evidence report');

    const entries = await readAgentTextLog(logPath);
    assert.deepEqual(
      entries.map((entry) => entry.text),
      ['First visible message', 'Intermediate progress after a tool call', 'Final evidence report']
    );

    const combined = buildAgentCallTextResult(entries, 'Final TASK_DONE');
    assert.equal(combined, 'Final evidence report');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('buildAgentCallTextResult falls back to a direct terminal result, then a delivered message', () => {
  const combined = buildAgentCallTextResult(
    [{ source: 'assistant_text', text: 'Intermediate text' }],
    'Final TASK_DONE'
  );

  assert.equal(combined, 'Final TASK_DONE');
  assert.equal(
    buildAgentCallTextResult([
      { source: 'assistant_text', text: 'Intermediate text' },
      { source: 'sent_text', text: 'Delivered final message' },
    ], ''),
    'Delivered final message',
  );
});
