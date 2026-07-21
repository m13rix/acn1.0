import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AgentLoader } from '../src/loaders/AgentLoader.js';
import { ToolLoader } from '../src/loaders/ToolLoader.js';
import { loadAgentTools } from '../src/core/SessionFactory.js';
import { LocalSandbox } from '../src/sandbox/LocalSandbox.js';

test('root action capability scope survives Executor reuse of the shared sandbox', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'telos-root-policy-'));
  const previousWorker = process.env.TELOS_SANDBOX_PERSISTENT_ACTION_WORKER;
  process.env.TELOS_SANDBOX_PERSISTENT_ACTION_WORKER = 'false';
  const sandbox = new LocalSandbox({ baseDir: directory });

  try {
    const agentLoader = new AgentLoader(path.join(process.cwd(), 'agents'));
    const toolLoader = new ToolLoader(path.join(process.cwd(), 'tools'));
    const root = await agentLoader.loadByName('Telos');
    const executor = await agentLoader.loadByName('Executor');
    assert.ok(root);
    assert.ok(executor);

    const rootTools = await loadAgentTools(root, toolLoader, ['message']);
    assert.deepEqual(rootTools.map((tool) => tool.config.name).sort(), ['agents', 'decision']);

    await sandbox.initialize(rootTools, root.config.memory);

    // A delegated Executor session historically replaced LocalSandbox.tools,
    // leaking its memory/files/world powers into root's next action.
    const executorTools = await loadAgentTools(executor, toolLoader);
    await sandbox.initialize(executorTools, executor.config.memory);

    const policy = {
      tools: rootTools,
      builtins: root.config.actionToolPolicy?.builtins,
      allowImports: root.config.actionToolPolicy?.allowImports,
    };
    const visibility = await sandbox.execute(
      'console.log(typeof agents, typeof decision, typeof memory, typeof files, typeof terminal, typeof computer, typeof process);',
      undefined,
      undefined,
      undefined,
      policy,
    );
    assert.equal(visibility.success, true, visibility.error);
    assert.match(visibility.output, /function function undefined undefined undefined undefined undefined/);

    const importAttempt = await sandbox.execute(
      'const fs = require("node:fs"); console.log(Boolean(fs));',
      undefined,
      undefined,
      undefined,
      policy,
    );
    assert.equal(importAttempt.success, false);
    assert.match(importAttempt.error || '', /capability policy denied require/i);
  } finally {
    if (previousWorker === undefined) delete process.env.TELOS_SANDBOX_PERSISTENT_ACTION_WORKER;
    else process.env.TELOS_SANDBOX_PERSISTENT_ACTION_WORKER = previousWorker;
    await sandbox.cleanup().catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }
});
