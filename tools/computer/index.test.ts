import assert from 'node:assert/strict';
import test from 'node:test';

import * as computer from './index.ts';

test('computer help documents semantic snapshots and safe input policy', () => {
  const help = computer.help();
  assert.match(help, /rawView/);
  assert.match(help, /stable element IDs/i);
  assert.match(help, /computer\.key/);
  assert.match(help, /computer\.clickAt/);
  assert.match(help, /computer\.focusWindow/);
  assert.match(help, /computer\.type/);
  assert.match(help, /visualFallback/);
  assert.match(help, /formatted strings, not JSON\/UI-node objects/i);
  assert.match(help, /tree\.children/);
  assert.match(help, /no supported independent second cursor/i);
  assert.match(help, /allowForegroundFallback=true/);
});

test('computer rejects invalid calls before starting native work', async () => {
  await assert.rejects(computer.open('   '), /must not be empty/);
  await assert.rejects(computer.open(0), /positive PID/);
  await assert.rejects(computer.snapshot(-1), /positive integer/);
  await assert.rejects(computer.snapshot('not-a-handle'), /hexadecimal HWND/);
  await assert.rejects(computer.focusWindow('13052E'), /hexadecimal HWND/);
  await assert.rejects(computer.focusWindow('0x13052E', { activate: true }), /also requires allowForegroundFallback/);
  await assert.rejects(computer.click(''), /elementId/);
  await assert.rejects(computer.clickAt(Number.NaN, 1), /finite screen coordinates/);
  await assert.rejects(computer.clickAt(1, 1, { clicks: 4 }), /integer from 1 to 3/);
  await assert.rejects(computer.key(''), /non-empty key name or chord/);
  await assert.rejects(computer.key('Enter', { pid: 0 }), /positive integer/);
  await assert.rejects(computer.type(12 as unknown as string), /text must be a string/);
  await assert.rejects(computer.scroll('btn-test', 'sideways' as 'up'), /direction/);
  await assert.rejects(computer.scroll('btn-test', 'down', 0), /positive integer/);
});

test('computer native worker lists real Windows top-level windows', { skip: process.platform !== 'win32' }, async () => {
  const windows = await computer.windows({ includeHidden: true, maxResults: 10 });
  assert.ok(windows.length > 0);
  assert.ok(windows.every(window => Number.isInteger(window.pid) && window.pid > 0));
  assert.ok(windows.every(window => typeof window.handle === 'string' && window.handle.startsWith('0x')));
  assert.ok(windows.every(window => Number.isInteger(window.zOrder) && typeof window.foreground === 'boolean'));
  assert.ok(windows.every(window => Number.isFinite(window.bounds.x) && Number.isFinite(window.bounds.width)));
});
