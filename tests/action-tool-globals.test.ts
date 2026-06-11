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
      ['improvement','skills','memory','files','heartbeat','message','codex','advancedCLI','utils'].includes(k)
    );
    console.log(JSON.stringify(keys.sort()));
    console.log(typeof (globalThis as any).improvement?.getState);
    console.log(JSON.stringify((globalThis as any).utils.tools.list().filter((name: string) => ['files','memory','utils'].includes(name)).sort()));
    console.log((globalThis as any).utils.tools.doc('utils').includes('utils.tools.doc'));
  })();`);

  assert.equal(result.success, true);
  assert.match(result.output, /\["advancedCLI","codex","files","heartbeat","improvement","memory","message","utils"\]/);
  assert.match(result.output, /function/);
  assert.match(result.output, /\["files","memory","utils"\]/);
  assert.match(result.output, /true/);
});
