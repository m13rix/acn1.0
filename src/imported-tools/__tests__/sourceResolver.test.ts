import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { resolveImportedSource } from '../sourceResolver.js';

test('resolveImportedSource runs shebang node bins through node on Windows-friendly paths', async () => {
  const root = await mkdtemp(join(tmpdir(), 'telos-source-resolver-'));
  try {
    const binDir = join(root, 'bin');
    await mkdir(binDir, { recursive: true });
    await writeFile(join(root, 'package.json'), JSON.stringify({
      name: 'demo-mcp-server',
      version: '1.0.0',
      bin: 'bin/server',
    }, null, 2));
    await writeFile(join(binDir, 'server'), '#!/usr/bin/env node\nconsole.log("ok");\n');

    const resolved = await resolveImportedSource({
      type: 'localPath',
      value: root,
    });

    assert.equal(resolved.runtime.command, process.execPath);
    assert.deepEqual(resolved.runtime.args, [join(binDir, 'server')]);

    await resolved.cleanup();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('resolveImportedSource keeps command-based package MCP configs as live command runtimes', async () => {
  const resolved = await resolveImportedSource({
    type: 'package',
    value: 'sdamgia-mcp-server',
    displayName: 'SdamGIA',
    command: process.platform === 'win32' ? 'npx.cmd' : 'npx',
    args: ['-y', 'sdamgia-mcp-server'],
  });

  try {
    assert.equal(resolved.runtime.command, process.platform === 'win32'
      ? (process.env.ComSpec || process.env.COMSPEC || 'cmd.exe')
      : 'npx');
    assert.ok(resolved.runtime.args.length > 0);
    assert.equal(resolved.runtime.installCommand.length, 0);
  } finally {
    await resolved.cleanup();
  }
});
