import assert from 'node:assert/strict';
import test from 'node:test';
import { ToolLoader } from '../src/loaders/ToolLoader.ts';
import { LocalSandbox } from '../src/sandbox/LocalSandbox.ts';

test('sandbox action exposes injected tools on globalThis', async () => {
  const loader = new ToolLoader();
  const tools = await loader.loadByNames([
    'improvement',
    'heartbeat',
    'message',
    'codex',
    'advancedCLI',
    'memory',
    'utils',
  ]);

  const sandbox = new LocalSandbox({ existingPath: process.cwd() });
  await sandbox.initialize(tools, 'self_improver', { enabled: true });

  const result = await sandbox.execute(`(async () => {
    const keys = Object.keys(globalThis).filter(k =>
      ['improvement','skills','memory','files','terminal','code','heartbeat','message','codex','advancedCLI','utils'].includes(k)
    );
    console.log(JSON.stringify(keys.sort()));
    console.log(typeof (globalThis as any).improvement?.getState);
    console.log(typeof (globalThis as any).terminal?.run);
    console.log(typeof (globalThis as any).code?.outline);
  })();`);

  assert.equal(result.success, true);
  assert.match(result.output, /\["advancedCLI","code","codex","files","heartbeat","improvement","memory","message","terminal","utils"\]/);
  assert.match(result.output, /function/);
  assert.match(result.output, /function\nfunction/);
});
