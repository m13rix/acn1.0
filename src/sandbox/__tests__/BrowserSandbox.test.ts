import test from 'node:test';
import assert from 'node:assert/strict';

import { BrowserSandbox } from '../BrowserSandbox.js';
import { COMPLETION_SIGNAL_END, COMPLETION_SIGNAL_START } from '../../core/completion.js';

test('browser action wrapper injects TASK_DONE and FINISH completion helpers', () => {
    const sandbox = new BrowserSandbox() as any;
    const code = sandbox.buildEvaluationCode('TASK_DONE("done");');

    assert.match(code, /const TASK_DONE = __telosCompleteTask/);
    assert.match(code, /const FINISH = __telosCompleteTask/);
    assert.match(code, new RegExp(COMPLETION_SIGNAL_START));
    assert.match(code, new RegExp(COMPLETION_SIGNAL_END));
    assert.match(code, /throw __telosCompletionSignal/);
    assert.match(code, /if \(error !== __telosCompletionSignal\)/);
    assert.match(code, /TASK_DONE\("done"\);/);
});
