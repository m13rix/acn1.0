import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { writeGeneratedTool } from '../generator.js';

test('writeGeneratedTool emits embedded skills files and tool.yaml skills config', async () => {
  const root = await mkdtemp(join(tmpdir(), 'telos-imported-generator-'));
  try {
    const toolDir = join(root, 'demo');
    await writeGeneratedTool({
      id: 'mcp:demo',
      kind: 'mcp',
      name: 'demo',
      slug: 'demo',
      namespace: 'demo',
      displayName: 'Demo',
      knowledgeMode: 'both',
      description: 'Demo imported tool.',
      directory: toolDir,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      status: 'active',
      source: {
        type: 'package',
        value: 'demo-mcp-server',
        command: process.platform === 'win32' ? 'npx.cmd' : 'npx',
        args: ['-y', 'demo-mcp-server'],
      },
      runtime: {
        command: process.execPath,
        args: ['demo.js'],
        runtimeDir: root,
        sourceDigest: 'digest',
        installCommand: [],
        version: 'digest',
        installedAt: new Date().toISOString(),
      },
      methods: [{
        originalName: 'demo_lookup',
        methodName: 'lookup',
        description: 'Look up a demo value.',
        inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
        outputSchema: { type: 'object' },
        parameters: [{ name: 'id', required: true, location: 'object', schema: { type: 'string' } }],
        orderedParameters: ['id'],
        positionalOverload: true,
        invocation: { kind: 'mcp', toolName: 'demo_lookup' },
      }],
      risk: { warnings: [], blockers: [], inferred: [] },
      docs: {
        toolDescription: 'Demo imported namespace.',
        usageMarkdown: '# Demo',
        methodDocs: { lookup: 'Look up a demo value.' },
        sources: [],
        generatedWith: 'test',
      },
      skills: {
        generatedWith: 'test',
        sourceSummary: 'Generated from tool inspection.',
        entries: [{
          title: 'Find a demo value',
          content: 'Use demo.lookup when the user needs a demo value.',
          examples: ['Find a demo value'],
          scoreThreshold: 0.83,
        }],
      },
      original: {},
      smokeTest: { passed: true, ranAt: new Date().toISOString() },
    }, toolDir);

    const toolYaml = await readFile(join(toolDir, 'tool.yaml'), 'utf8');
    const skillFiles = await readdir(join(toolDir, 'skills'));

    assert.match(toolYaml, /skills:\s+enabled: true\s+directory: skills/s);
    assert.equal(skillFiles.length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
