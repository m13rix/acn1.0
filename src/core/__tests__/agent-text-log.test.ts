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

test('buildAgentCallTextResult stacks logged text messages in order and keeps TASK_DONE fallback', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'telos-agent-text-log-'));
  const logPath = join(dir, 'call.jsonl');

  try {
    appendAgentTextLog(logPath, 'assistant_text', 'First visible message');
    appendAgentTextLog(logPath, 'sent_text', 'Tool-delivered text');

    const entries = await readAgentTextLog(logPath);
    assert.deepEqual(
      entries.map((entry) => entry.text),
      ['First visible message', 'Tool-delivered text']
    );

    const combined = buildAgentCallTextResult(entries, 'Final TASK_DONE');
    assert.equal(
      combined,
      'First visible message\n\nTool-delivered text\n\nFinal TASK_DONE'
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('buildAgentCallTextResult avoids duplicating identical final response when already logged', () => {
  const combined = buildAgentCallTextResult(
    [{ source: 'response', text: 'Final TASK_DONE' }],
    'Final TASK_DONE'
  );

  assert.equal(combined, 'Final TASK_DONE');
});
