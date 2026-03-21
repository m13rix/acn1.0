import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildPowerShellCommand,
  normalizeCliCommand,
  shouldFallbackToCmd,
} from '../windows-shell.js';

test('normalizes multiline command for win32 with semicolons and mkdir -p fix', () => {
  const command = [
    'mkdir -p documentation',
    'Get-Content .\\file.txt',
  ].join('\n');

  const normalized = normalizeCliCommand(command, 'win32');
  assert.equal(normalized, 'mkdir documentation; Get-Content .\\file.txt');
});

test('normalizes multiline command for non-windows with &&', () => {
  const command = [
    'echo one',
    'echo two',
  ].join('\n');

  const normalized = normalizeCliCommand(command, 'linux');
  assert.equal(normalized, 'echo one && echo two');
});

test('builds powershell wrapper with strict error preference', () => {
  const wrapped = buildPowerShellCommand('Get-Content ./x.txt');
  assert.match(wrapped, /^\$ErrorActionPreference = 'Stop'; /);
  assert.match(wrapped, /Get-Content \.\/x\.txt/);
});

test('detects parser/cmdlet failures for cmd fallback', () => {
  const parserError = 'ParserError: Unexpected token';
  const cmdletError = "The term 'cat' is not recognized as the name of a cmdlet";
  assert.equal(shouldFallbackToCmd(parserError), true);
  assert.equal(shouldFallbackToCmd(cmdletError), true);
});

test('does not fallback for regular command runtime failures', () => {
  const runtimeError = 'npm ERR! code ERESOLVE';
  assert.equal(shouldFallbackToCmd(runtimeError), false);
});
