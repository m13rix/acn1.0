import assert from 'node:assert/strict';
import test from 'node:test';
import { __internals } from './index.js';

test('normalizeScript removes tsx name helpers from callback bodies', () => {
  const script = __internals.normalizeScript(() => {
    function jf(value: number) {
      return value;
    }

    console.log(jf(1.5));
  });

  assert.doesNotMatch(script, /__name/);
  assert.match(script, /function jf\(value\)/);
  assert.match(script, /console\.log\(jf\(1\.5\)\)/);
});

test('stripTranspilerNameHelpers leaves ordinary code intact', () => {
  const script = __internals.stripTranspilerNameHelpers(`
    const value = 1;
    console.log(value);
  `);

  assert.equal(script, 'const value = 1;\n    console.log(value);');
});
