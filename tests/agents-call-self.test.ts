import test from 'node:test';
import assert from 'node:assert/strict';
import { inspect } from 'node:util';
import { callSelf, run } from '../tools/agents/index.js';

test('agents.callSelf falls back to TELOS_AGENT_NAME outside live agent context', async () => {
  const originalAgentName = process.env.TELOS_AGENT_NAME;
  const originalSandboxDir = process.env.SANDBOX_DIR;

  try {
    process.env.TELOS_AGENT_NAME = 'CORE';
    delete process.env.SANDBOX_DIR;

    const result = await callSelf('ping');
    assert.match(result, /No sandbox available/);
  } finally {
    if (originalAgentName === undefined) {
      delete process.env.TELOS_AGENT_NAME;
    } else {
      process.env.TELOS_AGENT_NAME = originalAgentName;
    }

    if (originalSandboxDir === undefined) {
      delete process.env.SANDBOX_DIR;
    } else {
      process.env.SANDBOX_DIR = originalSandboxDir;
    }
  }
});

test('agents.run result inspection preserves an arbitrarily long finalMessage', async () => {
  const originalSandboxDir = process.env.SANDBOX_DIR;
  const sentinel = 'FULL_FINAL_MESSAGE_TAIL_SENTINEL';

  try {
    delete process.env.SANDBOX_DIR;
    const result = await run(`${'agent-name-'.repeat(2500)}${sentinel}`, 'ping');
    const rendered = inspect(result);

    assert.ok(result.finalMessage.length > 20_000);
    assert.match(rendered, new RegExp(sentinel));
    assert.doesNotMatch(rendered, /more characters/);
  } finally {
    if (originalSandboxDir === undefined) delete process.env.SANDBOX_DIR;
    else process.env.SANDBOX_DIR = originalSandboxDir;
  }
});
