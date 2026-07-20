import assert from 'node:assert/strict';
import test from 'node:test';
import { disposeHotkeyListener } from '../src/interfaces/local-voice.ts';

test('hotkey cleanup never throws when the optional Windows helper failed before initialization', () => {
  let removeAttempted = false;
  let killAttempted = false;
  assert.doesNotThrow(() => disposeHotkeyListener({
    addListener() {},
    removeAllListeners() {
      removeAttempted = true;
      throw new Error('listener state was never initialized');
    },
    kill() {
      killAttempted = true;
      throw new TypeError("Cannot read properties of undefined (reading 'stdout')");
    },
  }));
  assert.equal(removeAttempted, true);
  assert.equal(killAttempted, true);
});
