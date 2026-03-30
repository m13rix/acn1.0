import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { AgentLoader } from '../AgentLoader.js';

async function withTempDir(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'acn-agent-config-'));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('AgentLoader applies backward-compatible modality and interface defaults', async () => {
  await withTempDir(async (root) => {
    const agentDir = join(root, 'agents', 'demo');
    await mkdir(join(agentDir, 'prompts'), { recursive: true });
    await writeFile(join(agentDir, 'agent.yaml'), [
      'name: demo',
      'model: test-model',
      'systemPrompt: prompts/system.md',
      'tools: []',
      'loop: provider-tools',
      'syntax: markdown',
    ].join('\n'));
    await writeFile(join(agentDir, 'prompts', 'system.md'), 'system');

    const loader = new AgentLoader(join(root, 'agents'));
    const loaded = await loader.loadByName('demo');

    assert.ok(loaded);
    assert.equal(loaded?.config.modality, 'text');
    assert.equal(loaded?.config.interface, 'telegram');
  });
});

test('AgentLoader skips invalid launchDefault values', async () => {
  await withTempDir(async (root) => {
    const agentDir = join(root, 'agents', 'voice-demo');
    await mkdir(join(agentDir, 'prompts'), { recursive: true });
    await writeFile(join(agentDir, 'agent.yaml'), [
      'name: voice-demo',
      'model: gemini-3.1-flash-live-preview',
      'provider: gemini-voice',
      'modality: voice',
      'interface: local-voice',
      'systemPrompt: prompts/system.md',
      'tools: []',
      'loop: provider-tools',
      'syntax: markdown',
      'interfaceOptions:',
      '  launchDefault: maybe',
    ].join('\n'));
    await writeFile(join(agentDir, 'prompts', 'system.md'), 'system');

    const loader = new AgentLoader(join(root, 'agents'));
    const agents = await loader.loadAll();

    assert.equal(agents.length, 0);
  });
});
