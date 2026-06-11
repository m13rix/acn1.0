import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { ToolLoader } from '../ToolLoader.js';

test('ToolLoader loads embedded tool skills from the tool directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'telos-tool-loader-'));
  try {
    const toolDir = join(root, 'demo-tool');
    const skillsDir = join(toolDir, 'skills');
    await mkdir(skillsDir, { recursive: true });

    await writeFile(join(toolDir, 'tool.yaml'), [
      'name: demo',
      'description: Demo tool.',
      'module: index.ts',
      'skills:',
      '  enabled: true',
      '  directory: skills',
      '',
    ].join('\n'));
    await writeFile(join(toolDir, 'index.ts'), 'export {};');
    await writeFile(join(skillsDir, 'entry.json'), JSON.stringify({
      title: 'Find a demo task',
      content: 'Use demo.lookup when the user needs demo data.',
      examples: ['Need demo data', 'Lookup a demo record'],
      scoreThreshold: 0.82,
    }, null, 2));

    const loader = new ToolLoader(root);
    const tools = await loader.loadAll();

    assert.equal(tools.length, 1);
    assert.equal(tools[0]?.skillEntries?.length, 1);
    assert.equal(tools[0]?.skillEntries?.[0]?.toolName, 'demo');
    assert.equal(tools[0]?.skillEntries?.[0]?.examples.length, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('ToolLoader accepts tools with intentionally empty descriptions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'telos-tool-loader-empty-desc-'));
  try {
    const toolDir = join(root, 'skill-only-tool');
    await mkdir(toolDir, { recursive: true });

    await writeFile(join(toolDir, 'tool.yaml'), [
      'name: skillOnly',
      'description: ""',
      'module: index.ts',
      '',
    ].join('\n'));
    await writeFile(join(toolDir, 'index.ts'), 'export {};');

    const loader = new ToolLoader(root);
    const tools = await loader.loadAll();

    assert.equal(tools.length, 1);
    assert.equal(tools[0]?.config.description, '');
    assert.match(loader.getToolDocumentation(tools), /### skillOnly/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
