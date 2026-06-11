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

test('routes cmd-style dir switches through cmd.exe on win32', () => {
  const normalized = normalizeCliCommand('dir /s /b', 'win32');
  assert.equal(normalized, 'cmd.exe /d /s /c "dir /s /b"');
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

test('detects cmd-style dir switch path failures for cmd fallback', () => {
  const pathError = [
    "dir : Cannot find path 'G:\\s' because it does not exist.",
    "FullyQualifiedErrorId : PathNotFound,Microsoft.PowerShell.Commands.GetChildItemCommand",
  ].join('\n');

  assert.equal(shouldFallbackToCmd(pathError), true);
});

test('does not fallback for regular command runtime failures', () => {
  const runtimeError = 'npm ERR! code ERESOLVE';
  assert.equal(shouldFallbackToCmd(runtimeError), false);
});
