import test from 'node:test';
import assert from 'node:assert/strict';
import { ActionAutoFixEngine } from '../../ActionAutoFixEngine.js';
import type { ExecutionResult } from '../../../types/index.js';

class MockSandbox {
  public executions: string[] = [];
  public cliCommands: string[] = [];

  constructor(private readonly executeFn: (code: string) => ExecutionResult) { }

  async execute(code: string): Promise<ExecutionResult> {
    this.executions.push(code);
    return this.executeFn(code);
  }

  async executeCli(command: string): Promise<ExecutionResult> {
    this.cliCommands.push(command);
    return { success: true, output: 'installed' };
  }
}

test('falls back to model repair only after deterministic attempt fails', async () => {
  const sandbox = new MockSandbox((code) => {
    if (code.includes('fixed')) {
      return { success: true, output: 'ok' };
    }
    return { success: false, output: '', error: 'SyntaxError: Unexpected token' };
  });

  let modelCalls = 0;
  const session = {
    agent: {
      config: {
        sandbox: 'local',
        actionAutoFix: {
          enabled: true,
          maxAttempts: 2,
          deterministic: { enabled: true, autoInstallMissingPackages: true },
          modelRepair: { enabled: true, provider: 'openrouter', model: 'openai/gpt-oss-20b' },
        },
      },
    },
    sandbox,
  } as any;

  const engine = new ActionAutoFixEngine(session, {
    repairWithModel: async () => {
      modelCalls++;
      return {
        repairedCode: "console.log('fixed');",
        note: 'model repair generated updated code (openrouter/openai/gpt-oss-20b)',
      };
    },
  });

  const result = await engine.repairAndRetry({
    originalCode: 'if (true) {',
    initialResult: { success: false, output: '', error: 'SyntaxError: Unexpected end of input' },
    env: {},
  });

  assert.equal(modelCalls, 1);
  assert.equal(result.result.success, true);
  assert.ok(result.summaryLines.some((line) => line.includes('attempt 2/2 model-repair')));
});

test('attempts model repair for missing runtime identifiers (was previously skipped)', async () => {
  const sandbox = new MockSandbox((code) => {
    if (code.includes('fixed')) {
      return { success: true, output: 'ok' };
    }
    return { success: false, output: '', error: 'still broken' };
  });

  let modelCalls = 0;
  const session = {
    agent: {
      config: {
        sandbox: 'local',
        actionAutoFix: {
          enabled: true,
          maxAttempts: 2,
          deterministic: { enabled: true, autoInstallMissingPackages: true },
          modelRepair: { enabled: true, provider: 'openrouter', model: 'openai/gpt-oss-20b' },
        },
      },
    },
    sandbox,
  } as any;

  const engine = new ActionAutoFixEngine(session, {
    repairWithModel: async () => {
      modelCalls++;
      return {
        repairedCode: "console.log('fixed');",
        note: 'model repair generated updated code (openrouter/openai/gpt-oss-20b)',
      };
    },
  });

  const result = await engine.repairAndRetry({
    originalCode: 'task557',
    initialResult: { success: false, output: '', error: 'ReferenceError: task557 is not defined' },
    env: {},
  });

  assert.equal(modelCalls, 1);
  assert.equal(result.result.success, true);
  assert.ok(result.summaryLines.some((line) => line.includes('model-repair')));
});

test('respects maxAttempts and does not call model when limit is 1', async () => {
  const sandbox = new MockSandbox(() => ({ success: false, output: '', error: 'still broken' }));

  let modelCalls = 0;
  const session = {
    agent: {
      config: {
        sandbox: 'local',
        actionAutoFix: {
          enabled: true,
          maxAttempts: 1,
          deterministic: { enabled: true, autoInstallMissingPackages: true },
          modelRepair: { enabled: true, provider: 'openrouter', model: 'openai/gpt-oss-20b' },
        },
      },
    },
    sandbox,
  } as any;

  const engine = new ActionAutoFixEngine(session, {
    repairWithModel: async () => {
      modelCalls++;
      return { repairedCode: "console.log('fixed');", note: 'should not run' };
    },
  });

  const result = await engine.repairAndRetry({
    originalCode: 'broken()',
    initialResult: { success: false, output: '', error: 'Error: broken' },
    env: {},
  });

  assert.equal(modelCalls, 0);
  assert.equal(result.result.success, false);
  assert.ok(result.summaryLines.some((line) => line.includes('failed after 1 attempts')));
});
