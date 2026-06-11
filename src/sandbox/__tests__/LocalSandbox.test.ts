import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { LocalSandbox } from '../LocalSandbox.js';

async function rmBestEffort(path: string): Promise<void> {
  try {
    await rm(path, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  } catch {
    // Windows can briefly keep npx/tsx-created files locked after process exit.
  }
}

test('rewrites aliased require for already injected tools to the canonical tool name', () => {
  const sandbox = new LocalSandbox() as any;
  const input = [
    "const hw = require('homework');",
    'const tasks = [];',
    'for (const num of [591, 593, 597]) {',
    '  tasks.push(hw.ask("algebra", `номер ${num} б`));',
    '}',
  ].join('\n');

  const output = sandbox.stripDuplicateToolImports(input, new Set(['homework']));

  assert.doesNotMatch(output, /const hw = require\('homework'\)/);
  assert.match(output, /removed aliased require for already-injected tool: hw -> homework/);
  assert.match(output, /tasks\.push\(homework\.ask/);
  assert.doesNotMatch(output, /\bhw\.ask/);
});

test('rewrites aliased import for already injected tools to the canonical tool name', () => {
  const sandbox = new LocalSandbox() as any;
  const input = [
    "import hw from 'homework';",
    'await hw.ask("algebra", "номер 591 б");',
  ].join('\n');

  const output = sandbox.stripDuplicateToolImports(input, new Set(['homework']));

  assert.doesNotMatch(output, /import hw from 'homework'/);
  assert.match(output, /removed aliased import for already-injected tool: hw -> homework/);
  assert.match(output, /await homework\.ask/);
});

test('generated action wrapper exits explicitly after tracked async tasks finish', () => {
  const sandbox = new LocalSandbox() as any;
  sandbox.tools = [];

  const output = sandbox.generateExecutionFile('console.log("ok");');

  assert.match(output, /__telosWaitForTrackedAsyncTasks/);
  assert.match(output, /__telosLazyWaitableTool\(\(\) => require/);
  assert.match(output, /TELOS_SANDBOX_EXIT_GRACE_MS/);
  assert.match(output, /TELOS_SANDBOX_ERROR_EXIT_GRACE_MS/);
  assert.match(output, /process\.exit\(process\.exitCode \?\? 0\)/);
  assert.match(output, /process\.exit\(process\.exitCode \?\? 1\)/);
  assert.match(output, /process\.exit\(1\)/);
});

test('removes destructured require for already-injected tools', () => {
  const sandbox = new LocalSandbox() as any;
  const input = [
    "const { googleCalendar } = require('./tool_modules');",
    "const today = '2026-05-15';",
    'const events = await googleCalendar.events.list("primary", { timeMin: new Date(today + "T00:00:00") });',
  ].join('\n');

  const output = sandbox.stripDuplicateToolImports(input, new Set(['googleCalendar']));

  assert.doesNotMatch(output, new RegExp("const \\{ googleCalendar \\} = require\\('\\.\\/tool_modules'\\)"));
  assert.match(output, /removed duplicate destructured require for already-injected tool\(s\): googleCalendar/);
  assert.match(output, /await googleCalendar\.events\.list/);
});

test('removes named import for already-injected tools', () => {
  const sandbox = new LocalSandbox() as any;
  const input = [
    "import { googleCalendar } from './tool_modules';",
    "const today = '2026-05-15';",
    'const events = await googleCalendar.events.list("primary", { timeMin: new Date(today + "T00:00:00") });',
  ].join('\n');

  const output = sandbox.stripDuplicateToolImports(input, new Set(['googleCalendar']));

  assert.doesNotMatch(output, new RegExp("import \\{ googleCalendar \\} from '\\.\\/tool_modules'"));
  assert.match(output, /removed duplicate named import for already-injected tool\(s\): googleCalendar/);
  assert.match(output, /await googleCalendar\.events\.list/);
});

test('waits for unawaited ask tool promise chains before exiting', async () => {
  const tempRoot = await mkdtemp(join(process.cwd(), 'sandboxes', 'test-waitable-'));
  const toolPath = join(tempRoot, 'waiter.cjs');
  const sandbox = new LocalSandbox({ baseDir: tempRoot });

  await writeFile(toolPath, [
    'exports.ask = async function ask(question) {',
    '  await new Promise(resolve => setTimeout(resolve, 80));',
    '  console.log("answered " + question);',
    '  return "ok";',
    '};',
  ].join('\n'));

  try {
    await sandbox.initialize([{
      config: { name: 'waiter', description: 'test waitable ask tool', module: toolPath },
      directory: tempRoot,
      absolutePath: toolPath,
    }]);

    const result = await sandbox.execute([
      'async function run() {',
      '  const first = await waiter.ask("q1");',
      '  console.log("got first " + first);',
      '  const second = await waiter.ask("q2");',
      '  console.log("got second " + second);',
      '}',
      'run().then(() => console.log("chain done"));',
    ].join('\n'));

    assert.equal(result.success, true, result.error);
    assert.match(result.output, /answered q1/);
    assert.match(result.output, /got first ok/);
    assert.match(result.output, /answered q2/);
    assert.match(result.output, /got second ok/);
    assert.match(result.output, /chain done/);
  } finally {
    await sandbox.cleanup();
    await rmBestEffort(tempRoot);
  }
});

test('waits for unawaited agents.call chains before exiting', async () => {
  const tempRoot = await mkdtemp(join(process.cwd(), 'sandboxes', 'test-agent-call-'));
  const toolPath = join(tempRoot, 'agents.cjs');
  const sandbox = new LocalSandbox({ baseDir: tempRoot });

  await writeFile(toolPath, [
    'exports.call = async function call(name, request) {',
    '  await new Promise(resolve => setTimeout(resolve, 80));',
    '  console.log("called " + name + ": " + request);',
    '  return "agent done";',
    '};',
  ].join('\n'));

  try {
    await sandbox.initialize([{
      config: { name: 'agents', description: 'test waitable agents tool', module: toolPath },
      directory: tempRoot,
      absolutePath: toolPath,
    }]);

    const result = await sandbox.execute([
      'async function main() {',
      '  const result = await agents.call("worker", "prompt");',
      '  console.log("result " + result);',
      '}',
      'main().catch(console.error);',
    ].join('\n'));

    assert.equal(result.success, true, result.error);
    assert.match(result.output, /called worker: prompt/);
    assert.match(result.output, /result agent done/);
  } finally {
    await sandbox.cleanup();
    await rmBestEffort(tempRoot);
  }
});

test('waits for unawaited generic async tool methods before exiting', async () => {
  const tempRoot = await mkdtemp(join(process.cwd(), 'sandboxes', 'test-generic-async-'));
  const toolPath = join(tempRoot, 'search.cjs');
  const sandbox = new LocalSandbox({ baseDir: tempRoot });

  await writeFile(toolPath, [
    'exports.answer = async function answer(query) {',
    '  await new Promise(resolve => setTimeout(resolve, 80));',
    '  console.log("searched " + query);',
    '  return "search result";',
    '};',
  ].join('\n'));

  try {
    await sandbox.initialize([{
      config: { name: 'search', description: 'test search tool', module: toolPath },
      directory: tempRoot,
      absolutePath: toolPath,
    }]);

    // Simulate agent pattern: define async helper and invoke without top-level await
    const result = await sandbox.execute([
      'async function doResearch() {',
      '  const r1 = await search.answer("minecraft");',
      '  console.log("got " + r1);',
      '}',
      'doResearch();',
    ].join('\n'));

    assert.equal(result.success, true, result.error);
    assert.match(result.output, /searched minecraft/);
    assert.match(result.output, /got search result/);
  } finally {
    await sandbox.cleanup();
    await rmBestEffort(tempRoot);
  }
});
