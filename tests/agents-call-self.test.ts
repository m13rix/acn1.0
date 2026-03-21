import test from 'node:test';
import assert from 'node:assert/strict';
import { callSelf } from '../tools/agents/index.js';

test('agents.callSelf falls back to ACN_AGENT_NAME outside live agent context', async () => {
  const originalAgentName = process.env.ACN_AGENT_NAME;
  const originalSandboxDir = process.env.SANDBOX_DIR;

  try {
    process.env.ACN_AGENT_NAME = 'CORE';
    delete process.env.SANDBOX_DIR;

    const result = await callSelf('ping');
    assert.match(result, /No sandbox available/);
  } finally {
    if (originalAgentName === undefined) {
      delete process.env.ACN_AGENT_NAME;
    } else {
      process.env.ACN_AGENT_NAME = originalAgentName;
    }

    if (originalSandboxDir === undefined) {
      delete process.env.SANDBOX_DIR;
    } else {
      process.env.SANDBOX_DIR = originalSandboxDir;
    }
  }
});
