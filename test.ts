import files from "./tools/files";

await files.write('src/sandbox/__tests__/BrowserSandbox.test.ts', `import test from 'node:test';
import assert from 'node:assert/strict';

import { BrowserSandbox } from '../BrowserSandbox.js';

test('browser action wrapper injects TASK_DONE completion signal', () => {
  const sandbox = new BrowserSandbox() as any;

  const output = sandbox.buildEvaluationCode('TASK_DONE("done");');

  assert.match(output, /const TASK_DONE = __telosCompleteTask/);
  assert.match(output, /const FINISH = __telosCompleteTask/);
  assert.match(output, /__TELOS_TASK_DONE_START__/);
  assert.match(output, /JSON\.stringify/);
  assert.match(output, /TASK_DONE\("done"\);/);
});
`);
console.log('wrote test');
