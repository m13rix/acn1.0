import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { AgentLoader } from '../AgentLoader.js';
import { ToolLoader } from '../ToolLoader.js';

async function withTempDir(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'telos-loader-'));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('AgentLoader finds nested agents even when parent directory also contains an agent config', async () => {
  await withTempDir(async (root) => {
    const agentsDir = join(root, 'agents');
    const parentDir = join(agentsDir, 'school');
    const childDir = join(parentDir, 'agent1');

    await mkdir(join(parentDir, 'prompts'), { recursive: true });
    await mkdir(join(childDir, 'prompts'), { recursive: true });

    await writeFile(join(parentDir, 'agent.yaml'), [
      'name: school-parent',
      'model: test-model',
      'systemPrompt: prompts/system.md',
      'tools: []',
      'loop: accumulator',
      'syntax: xml-tags',
    ].join('\n'));
    await writeFile(join(parentDir, 'prompts', 'system.md'), 'parent prompt');

    await writeFile(join(childDir, 'agent.yaml'), [
      'name: school-child',
      'model: test-model',
      'systemPrompt: prompts/system.md',
      'tools: []',
      'loop: accumulator',
      'syntax: xml-tags',
    ].join('\n'));
    await writeFile(join(childDir, 'prompts', 'system.md'), 'child prompt');

    const loader = new AgentLoader(agentsDir);
    const agents = await loader.loadAll();
    const names = agents.map(agent => agent.config.name).sort();

    assert.deepEqual(names, ['school-child', 'school-parent']);
  });
});

test('ToolLoader finds nested tools even when parent directory also contains a tool config', async () => {
  await withTempDir(async (root) => {
    const toolsDir = join(root, 'tools');
    const parentDir = join(toolsDir, 'suite');
    const childDir = join(parentDir, 'tool-a');

    await mkdir(parentDir, { recursive: true });
    await mkdir(childDir, { recursive: true });

    await writeFile(join(parentDir, 'tool.yaml'), [
      'name: suite-parent',
      'description: parent tool',
      'module: index.ts',
    ].join('\n'));
    await writeFile(join(parentDir, 'index.ts'), 'export {};');

    await writeFile(join(childDir, 'tool.yaml'), [
      'name: suite-child',
      'description: child tool',
      'module: index.ts',
    ].join('\n'));
    await writeFile(join(childDir, 'index.ts'), 'export {};');

    const loader = new ToolLoader(toolsDir);
    const tools = await loader.loadAll();
    const names = tools.map(tool => tool.config.name).sort();

    assert.deepEqual(names, ['suite-child', 'suite-parent']);
  });
});
