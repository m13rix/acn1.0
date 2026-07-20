import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { AgentLoader } from '../src/loaders/AgentLoader.js';
import { ToolLoader } from '../src/loaders/ToolLoader.js';

test('Telos loads as the pinned constitutional root with delegated communication', async () => {
  const agent = await new AgentLoader(join(process.cwd(), 'agents')).loadByName('Telos');

  assert.ok(agent, 'Telos should be loadable');
  assert.equal(agent.config.model, 'kimi-k3');
  assert.equal(agent.config.provider, 'opencode');
  assert.deepEqual(agent.config.tools, ['agents', 'decision']);
  assert.deepEqual(agent.config.actionToolPolicy, {
    allowImplicitTools: false,
    builtins: [],
    allowImports: false,
  });
  assert.equal(agent.config.requireFinish, true);
  assert.equal(agent.config.requireFinishHeartbeat, true);
  assert.equal(agent.config.preserveSession, true);
  assert.equal(agent.config.suppressFinalOutput, true);
  assert.match(agent.systemPromptContent, /permanent prompt is a bootloader/i);
  assert.match(agent.systemPromptContent, /highest useful outcome/i);
  assert.match(agent.systemPromptContent, /generate atomic/i);
  assert.match(agent.systemPromptContent, /agents\.run\("Executor"/);
  assert.match(agent.systemPromptContent, /agents\.run\("user-facing"/);
  assert.match(agent.systemPromptContent, /agents\.run\("Executor", prompt\)/);
  assert.match(agent.systemPromptContent, /decision\.requests\.userFacing/);
  assert.match(agent.systemPromptContent, /\{ userMessage, systemMessage \}/);
  assert.match(agent.systemPromptContent, /Do not send arrays of talking points/);
  assert.match(agent.systemPromptContent, /Positive and negative examples both prime imitation/);
  assert.match(agent.systemPromptContent, /Orient before consequential judgment/i);
  assert.match(agent.systemPromptContent, /who Subject 13 \/ Maxim is/i);
  assert.match(agent.systemPromptContent, /psychological evidence, studies, statistics/i);
  assert.match(agent.systemPromptContent, /harness exposes reasoning, action code, observations, and results/i);
  assert.doesNotMatch(agent.systemPromptContent, /memory\.(?:context|search|add)\s*\(/);
  assert.match(agent.systemPromptContent, /beautiful obsolescence/i);
});

test('decision tool is discoverable by the harness', async () => {
  const tool = await new ToolLoader(join(process.cwd(), 'tools')).loadByName('decision');

  assert.ok(tool, 'decision tool should be loadable');
  assert.equal(tool.config.module, 'index.ts');
  assert.match(tool.config.description, /flexible notepad/i);
  assert.match(tool.config.description, /decision\.nodes\.addOptions/);
  assert.match(tool.config.description, /agents\.run\("Executor", prompt\)/);
  assert.match(tool.config.description, /decision\.trace/);
  assert.match(tool.config.description, /userMessage, systemMessage/);
  assert.match(tool.config.description, /older structured fields remain accepted/i);
});

test('the user-facing delivery agent also suppresses its duplicate provider completion', async () => {
  const agent = await new AgentLoader(join(process.cwd(), 'agents')).loadByName('user-facing');

  assert.ok(agent, 'user-facing should be loadable');
  assert.equal(agent.config.suppressFinalOutput, true);
  assert.match(agent.systemPromptContent, /await message\.sendText\(\)/);
});

test('Executor retains Maxim\'s pre-root-redesign outcome-owner prompt', async () => {
  const agent = await new AgentLoader(join(process.cwd(), 'agents')).loadByName('Executor');

  assert.ok(agent, 'Executor should be loadable');
  assert.ok(agent.config.tools.includes('message'));
  assert.match(agent.systemPromptContent, /^# Telos Executor/m);
  assert.match(agent.systemPromptContent, /general-purpose action and orchestration agent/i);
  assert.match(agent.systemPromptContent, /highest achievable quality/i);
  assert.match(agent.systemPromptContent, /agents\.newSubAgent/);
  assert.match(agent.systemPromptContent, /claim-to-source evidence matrix/);
});
