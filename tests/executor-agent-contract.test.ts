import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { AgentLoader } from '../src/loaders/AgentLoader.js';

test('Executor loads its dedicated main and sub-agent contracts', async () => {
  const loader = new AgentLoader(join(process.cwd(), 'agents'));
  const executor = await loader.loadByName('Executor');

  assert.ok(executor, 'Executor should be loadable');
  assert.equal(executor.config.subagentPrompt, 'prompts/subagent.md');
  assert.match(executor.systemPromptContent, /highest achievable quality/i);
  assert.match(executor.systemPromptContent, /agents\.newSubAgent/);
  assert.match(executor.systemPromptContent, /agentExclusive: true/);
  assert.match(executor.systemPromptContent, /browser-operator/);
  assert.match(executor.systemPromptContent, /computer-operator/);
  assert.match(executor.systemPromptContent, /Telos-Code/);
  assert.match(executor.systemPromptContent, /Do not call `search\.\*` from the paid main Executor/);
  assert.match(executor.systemPromptContent, /claim-to-source evidence matrix/);
  assert.match(executor.subagentPromptContent || '', /SUBAGENT_RESULT/);
});

test('Local-Core exposes execution, verification, and escalation contracts', async () => {
  const loader = new AgentLoader(join(process.cwd(), 'agents'));
  const localCore = await loader.loadByName('Local-Core');

  assert.ok(localCore, 'Local-Core should be loadable');
  assert.match(localCore.systemPromptContent, /Perform the work, not merely a plan/i);
  assert.match(localCore.systemPromptContent, /BLOCKED_FOR_ORCHESTRATOR/);
  assert.match(localCore.systemPromptContent, /EXECUTION_SUMMARY/);
  assert.match(localCore.systemPromptContent, /agentExclusive: true/);
  assert.match(localCore.systemPromptContent, /console\.log\(search\.help\(\)\)/);
  assert.match(localCore.systemPromptContent, /NEEDS_BROWSER_OPERATOR/);
});
