import test from 'node:test';
import assert from 'node:assert/strict';
import { applyDeterministicFixes } from '../deterministic.js';

test('injects require for missing built-in identifier', () => {
  const output = applyDeterministicFixes({
    code: "console.log(fs.readFileSync('foo.txt', 'utf-8'));",
    errorText: 'ReferenceError: fs is not defined',
    installedPackages: new Set<string>(),
  });

  assert.equal(output.didChange, true);
  assert.match(output.code, /const fs = require\('fs'\);/);
  assert.ok(output.notes.some((line) => line.includes('injected require')));
});

test('balances obvious unterminated string and delimiters', () => {
  const output = applyDeterministicFixes({
    code: 'console.log("hello',
    errorText: 'SyntaxError: Unterminated string literal',
    installedPackages: new Set<string>(),
  });

  assert.equal(output.didChange, true);
  assert.equal(output.code.trim(), 'console.log("hello")');
});

test('detects missing package for auto-install', () => {
  const output = applyDeterministicFixes({
    code: "const xlsx = require('xlsx');",
    errorText: "Error: Cannot find module 'xlsx'",
    installedPackages: new Set<string>(),
  });

  assert.equal(output.packageToInstall, 'xlsx');
  assert.ok(output.notes.some((line) => line.includes('missing package')));
});
