import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

const TEST_ROOT = join(tmpdir(), 'acn-imported-tools-tests');
process.env.ACN_IMPORTED_TOOLS_ROOT = TEST_ROOT;
process.env.IMPORTED_TOOLS_DOCS_MODE = 'test';
process.env.IMPORTED_TOOLS_SKIP_GEMINI = '1';

async function withTempSkill(run: (dir: string) => Promise<void>, skillContent: string): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'acn-clawhub-'));
  try {
    await mkdir(join(root, 'bin'), { recursive: true });
    await writeFile(join(root, 'package.json'), JSON.stringify({
      name: 'gog-demo',
      version: '1.0.0',
      bin: {
        gog: './bin/gog.js',
      },
    }, null, 2));
    await writeFile(join(root, 'bin', 'gog.js'), [
      '#!/usr/bin/env node',
      'const args = process.argv.slice(2);',
      'if (args[0] === "contacts" && args[1] === "list") {',
      '  console.log(JSON.stringify({ ok: true, args }));',
      '} else {',
      '  console.log("help");',
      '}',
    ].join('\n'));
    await writeFile(join(root, 'SKILL.md'), skillContent);
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('extracts deterministic command wrappers from executable skill examples', async () => {
  const { inspectClawhubImport } = await import('../clawhub.js');
  await withTempSkill(async (root) => {
    const draft = await inspectClawhubImport({
      source: {
        type: 'localPath',
        value: root,
        displayName: 'Gog',
      },
      existingToolNames: [],
    });

    assert.equal(draft.namespace, 'gog');
    assert.equal(draft.methods.length, 1);
    assert.equal(draft.methods[0]?.methodName, 'contactsList');
    assert.equal(draft.risk.blockers.length, 0);
  }, [
    '---',
    'description: Google Workspace helper',
    'requires:',
    '  bins:',
    '    - gog',
    '---',
    '',
    '```bash',
    'gog contacts list --max 20',
    '```',
  ].join('\n'));
});

test('rejects unsafe shell examples', async () => {
  const { inspectClawhubImport } = await import('../clawhub.js');
  await withTempSkill(async (root) => {
    const draft = await inspectClawhubImport({
      source: {
        type: 'localPath',
        value: root,
        displayName: 'UnsafeGog',
      },
      existingToolNames: [],
    });
    assert.ok(draft.risk.blockers.length > 0);
  }, [
    '---',
    'requires:',
    '  bins:',
    '    - gog',
    '---',
    '',
    '```bash',
    'gog contacts list | jq .',
    '```',
  ].join('\n'));
});
