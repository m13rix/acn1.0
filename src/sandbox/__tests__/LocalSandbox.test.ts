import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
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
  assert.match(output, /help\(\)/);
  assert.match(output, /const terminal = __telosLazyWaitableTool/);
  assert.match(output, /const code = __telosLazyWaitableTool/);
  assert.match(output, /TELOS_SANDBOX_EXIT_GRACE_MS/);
  assert.match(output, /TELOS_SANDBOX_ERROR_EXIT_GRACE_MS/);
  assert.match(output, /process\.exit\(process\.exitCode \?\? 0\)/);
  assert.match(output, /process\.exit\(process\.exitCode \?\? 1\)/);
  assert.match(output, /process\.exit\(1\)/);
});

test('every injected tool exposes help()', async () => {
  const tempRoot = await mkdtemp(join(process.cwd(), 'sandboxes', 'test-tool-help-'));
  const toolPath = join(tempRoot, 'helper.cjs');
  const sandbox = new LocalSandbox({ baseDir: tempRoot });

  await writeFile(toolPath, [
    'exports.answer = function answer() {',
    '  return "ok";',
    '};',
  ].join('\n'));

  try {
    await sandbox.initialize([{
      config: { name: 'helper', description: 'Helpful test tool docs.', module: toolPath },
      directory: tempRoot,
      absolutePath: toolPath,
    }]);

    const result = await sandbox.execute([
      'console.log(files.help().includes("files.read"));',
      'console.log(terminal.help().includes("terminal.run"));',
      'console.log(code.help().includes("code.outline"));',
      'console.log(helper.help().includes("Helpful test tool docs."));',
      'console.log(Object.keys(helper).includes("help"));',
    ].join('\n'));

    assert.equal(result.success, true, result.error);
    assert.match(result.output, /true\ntrue\ntrue\ntrue\ntrue/);
  } finally {
    await sandbox.cleanup();
    await rmBestEffort(tempRoot);
  }
});

test('action exposes files read/write/edit/search/list and code outline packages', async () => {
  const tempRoot = await mkdtemp(join(process.cwd(), 'sandboxes', 'test-system-packages-'));
  const sandbox = new LocalSandbox({ baseDir: tempRoot });

  try {
    await sandbox.initialize([]);
    const result = await sandbox.execute([
      'await files.write("src/example.ts", "export class Example {\\n  run() {\\n    return 1;\\n  }\\n}\\n");',
      'console.log(await files.read("src/example.ts", { startLine: 1, endLine: 3 }));',
      'console.log(await files.edit("src/example.ts", [{ old: "return 1;", new: "return 2;" }]));',
      'console.log(JSON.stringify(await files.search("return 2", { glob: "**/*.ts", maxResults: 5 })));',
      'console.log(JSON.stringify(await files.search("return 2", { path: "src", recursive: true, maxResults: 5 })));',
      'console.log(await files.list("src", { depth: 2 }));',
      'console.log(await code.outline("src/example.ts"));',
    ].join('\n'));

    assert.equal(result.success, true, result.error);
    assert.match(result.output, /1 \| export class Example/);
    assert.match(result.output, /Applied 1 edit to src\/example\.ts/);
    assert.match(result.output, /"path":"src\/example\.ts"/);
    assert.match(result.output, /"preview":"return 2;"/);
    assert.match(result.output, /src\//);
    assert.match(result.output, /class Example lines 1-5/);
    assert.match(result.output, /run lines 2-4/);
  } finally {
    await sandbox.cleanup();
    await rmBestEffort(tempRoot);
  }
});

test('files search and raw read work with repo-style action snippets', async () => {
  const tempRoot = await mkdtemp(join(process.cwd(), 'sandboxes', 'test-files-runtime-'));
  const sandbox = new LocalSandbox({ baseDir: tempRoot });

  try {
    await sandbox.initialize([]);
    const result = await sandbox.execute([
      'await files.write("src/LocalSandbox.ts", "EVERY tool is AUTOMATICALLY IMPORTED.\\nconst marker = 1;\\n");',
      'const raw = await files.read("src/LocalSandbox.ts");',
      'console.log("rawIncludes", raw.includes("EVERY tool is AUTOMATICALLY IMPORTED.\\n"));',
      'console.log("rawHasLinePrefix", raw.includes("1 |"));',
      'console.log(await files.read("src/LocalSandbox.ts", { startLine: 1, endLine: 1 }));',
      'console.log(JSON.stringify(await files.search("automatically imported", { dir: process.cwd(), recursive: true, maxResults: 5 })));',
    ].join('\n'));

    assert.equal(result.success, true, result.error);
    assert.match(result.output, /rawIncludes true/);
    assert.match(result.output, /rawHasLinePrefix false/);
    assert.match(result.output, /1 \| EVERY tool is AUTOMATICALLY IMPORTED\./);
    assert.match(result.output, /"path":"src\/LocalSandbox\.ts"/);
    assert.match(result.output, /"preview":"EVERY tool is AUTOMATICALLY IMPORTED\."/);
  } finally {
    await sandbox.cleanup();
    await rmBestEffort(tempRoot);
  }
});

test('action import extraction ignores import text inside template literals', async () => {
  const tempRoot = await mkdtemp(join(process.cwd(), 'sandboxes', 'test-template-import-text-'));
  const sandbox = new LocalSandbox({ baseDir: tempRoot });

  try {
    await sandbox.initialize([]);
    const result = await sandbox.execute([
      "await files.write('src/generated.test.ts', `import test from 'node:test';",
      "import assert from 'node:assert/strict';",
      '',
      "import { Something } from '../Something.js';",
      '',
      "test('generated content stays intact', () => {",
      '  assert.match("TASK_DONE(\\"done\\");", /TASK_DONE\\(\\"done\\"\\);/);',
      '});',
      "`);",
      "console.log(await files.read('src/generated.test.ts'));",
    ].join('\n'));

    assert.equal(result.success, true, result.error);
    assert.match(result.output, /import test from 'node:test';/);
    assert.match(result.output, /import \{ Something \} from '\.\.\/Something\.js';/);
    assert.match(result.output, /TASK_DONE/);
  } finally {
    await sandbox.cleanup();
    await rmBestEffort(tempRoot);
  }
});

test('files search skips runtime directories by default and compacts previews', async () => {
  const tempRoot = await mkdtemp(join(process.cwd(), 'sandboxes', 'test-files-search-cost-'));
  const sandbox = new LocalSandbox({ baseDir: tempRoot });

  try {
    await sandbox.initialize([]);
    const result = await sandbox.execute([
      'await files.write("src/real.ts", "const value = \\"" + "needle " + "x".repeat(500) + "\\";\\n");',
      'await files.write("log.txt", "needle from runtime log\\n");',
      'await files.write("data/adaptive-step-context/noisy.json", "{\\"observation\\":\\"" + "hidden-needle " + "y".repeat(500) + "\\"}\\n");',
      'console.log("default", JSON.stringify(await files.search("needle", { maxResults: 10 })));',
      'console.log("explicit", JSON.stringify(await files.search("hidden-needle", { path: "data", includeIgnored: true, maxResults: 10 })));',
    ].join('\n'));

    assert.equal(result.success, true, result.error);
    assert.match(result.output, /default .*"path":"src\/real\.ts"/);
    assert.doesNotMatch(result.output, /default .*adaptive-step-context/);
    assert.doesNotMatch(result.output, /default .*log\.txt/);
    assert.match(result.output, /truncated \d+ chars; use files\.read around this line/);
    assert.match(result.output, /explicit .*"path":"data\/adaptive-step-context\/noisy\.json"/);
  } finally {
    await sandbox.cleanup();
    await rmBestEffort(tempRoot);
  }
});

test('files and terminal can intentionally access external directories', async () => {
  const tempRoot = await mkdtemp(join(process.cwd(), 'sandboxes', 'test-external-access-sandbox-'));
  const externalRoot = await mkdtemp(join(tmpdir(), 'telos-external-access-'));
  const sandbox = new LocalSandbox({ baseDir: tempRoot });
  const externalFile = join(externalRoot, 'outside.txt');
  const externalPathLiteral = JSON.stringify(externalRoot.split('\\').join('/'));
  const externalFileLiteral = JSON.stringify(externalFile.split('\\').join('/'));

  try {
    await writeFile(externalFile, 'external needle\n', 'utf-8');
    await sandbox.initialize([]);
    const result = await sandbox.execute([
      `console.log('blocked', await files.list(${externalPathLiteral}, { maxEntries: 5 }).catch(error => error.message.includes('allowExternal: true')));`,
      `console.log('list', (await files.list(${externalPathLiteral}, { maxEntries: 5, allowExternal: true })).includes('outside.txt'));`,
      `console.log('read', (await files.read(${externalFileLiteral}, { allowExternal: true })).trim());`,
      `console.log('search', JSON.stringify(await files.search('external needle', { path: ${externalPathLiteral}, allowExternal: true, maxResults: 5 })));`,
      `console.log('edit', await files.edit(${externalFileLiteral}, [{ old: 'external needle', new: 'changed needle' }], { allowExternal: true }));`,
      `await files.write(${externalFileLiteral}, 'written outside\\n', { allowExternal: true });`,
      `console.log('written', (await files.read(${externalFileLiteral}, { allowExternal: true })).trim());`,
      `const cwd = await terminal.run('node -e "console.log(process.cwd())"', { cwd: ${externalPathLiteral}, allowExternal: true, timeoutMs: 30000 });`,
      `console.log('cwd', cwd.output.replace(/\\\\/g, '/').includes(${externalPathLiteral}));`,
    ].join('\n'));

    assert.equal(result.success, true, result.error);
    assert.match(result.output, /blocked true/);
    assert.match(result.output, /list true/);
    assert.match(result.output, /read external needle/);
    assert.match(result.output, /"path":/);
    assert.match(result.output, /edit Applied 1 edit/);
    assert.match(result.output, /written written outside/);
    assert.match(result.output, /cwd true/);
  } finally {
    await sandbox.cleanup();
    await rmBestEffort(tempRoot);
    await rmBestEffort(externalRoot);
  }
});

test('terminal.run executes a finite shell command', async () => {
  const tempRoot = await mkdtemp(join(process.cwd(), 'sandboxes', 'test-terminal-run-'));
  const sandbox = new LocalSandbox({ baseDir: tempRoot });

  try {
    await sandbox.initialize([]);
    const result = await sandbox.execute([
      'const r = await terminal.run("node -e \\"console.log(42)\\"", { timeoutMs: 30000 });',
      'console.log(r.output);',
    ].join('\n'));

    assert.equal(result.success, true, result.error);
    assert.match(result.output, /42/);
  } finally {
    await sandbox.cleanup();
    await rmBestEffort(tempRoot);
  }
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
