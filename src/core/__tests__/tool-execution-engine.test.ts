import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { ToolExecutionEngine } from '../ToolExecutionEngine.js';
import type { ExecutionResult } from '../../types/index.js';

class MockSandbox {
  constructor(
    public readonly directory: string,
    private readonly actionFn: (code: string) => Promise<ExecutionResult> = async () => ({ success: true, output: 'ok' }),
    private readonly cliFn: (command: string) => Promise<ExecutionResult> = async (command: string) => ({ success: true, output: command })
  ) { }

  parseSearchReplace(): Array<{ search: string; replace: string }> {
    return [];
  }

  async applySearchReplace(): Promise<ExecutionResult> {
    return { success: true, output: '' };
  }

  async execute(code: string): Promise<ExecutionResult> {
    return this.actionFn(code);
  }

  async executeCli(command: string): Promise<ExecutionResult> {
    return this.cliFn(command);
  }
}

async function withTempSandbox(
  run: (engine: ToolExecutionEngine, sandboxDir: string) => Promise<void>,
  actionFn?: (code: string) => Promise<ExecutionResult>,
): Promise<void> {
  const sandboxDir = await mkdtemp(join(tmpdir(), 'telos-tool-engine-'));
  try {
    const sandbox = new MockSandbox(sandboxDir, actionFn);
    const session = { id: 'test-session', sandbox } as any;
    const engine = new ToolExecutionEngine(session);
    await run(engine, sandboxDir);
  } finally {
    await rm(sandboxDir, { recursive: true, force: true });
  }
}

test('normalizes whitespace tool name for action', async () => {
  await withTempSandbox(
    async (engine) => {
      const result = await engine.executeProviderToolCall({
        id: 'tool_1',
        name: ' action',
        arguments: {
          text: 'console.log("hello")',
        },
      });
      assert.equal(result.observation, 'ran');
    },
    async () => ({ success: true, output: 'ran' })
  );
});

test('legacy provider-native file and cli tools are rejected', async () => {
  await withTempSandbox(async (engine) => {
    for (const name of ['cli', 'edit_file', 'file', 'view_file', 'read_file']) {
      const result = await engine.executeProviderToolCall({
        id: `tool_${name}`,
        name,
        arguments: { content: 'echo nope', filename: 'x.txt' },
      });

      assert.match(result.observation, /Unsupported provider tool/);
      assert.match(result.observation, /terminal, files, and code inside action/);
    }
  });
});

test('handles TASK_DONE pseudo-tool directly and keeps FINISH as alias for old continuations', async () => {
  await withTempSandbox(async (engine) => {
    const result = await engine.executeProviderToolCall({
      id: 'tool_2',
      name: 'TASK_DONE',
      arguments: { message: 'done successfully' },
    });

    assert.equal(result.finishMessage, 'done successfully');
    assert.match(result.observation, /TASK_DONE accepted/i);

    const legacy = await engine.executeProviderToolCall({
      id: 'tool_3',
      name: 'FINISH',
      arguments: { message: 'legacy still works' },
    });

    assert.equal(legacy.finishMessage, 'legacy still works');
  });
});

test('serializes parallel provider tool calls and returns each observation', async () => {
  const order: string[] = [];
  let releaseFirst: (() => void) | undefined;
  const firstGate = new Promise<void>(resolve => {
    releaseFirst = () => resolve();
  });

  await withTempSandbox(
    async (engine) => {
      const first = engine.executeProviderToolCall({
        id: 'tool_first',
        name: 'action',
        arguments: { content: 'first' },
      });

      const second = engine.executeProviderToolCall({
        id: 'tool_second',
        name: 'action',
        arguments: { content: 'second' },
      });

      await new Promise(resolve => setTimeout(resolve, 20));
      assert.deepEqual(order, ['first-start']);

      releaseFirst?.();

      const [firstResult, secondResult] = await Promise.all([first, second]);
      assert.equal(firstResult.observation, 'first-result');
      assert.equal(secondResult.observation, 'second-result');
    },
    async (code) => {
      order.push(`${code}-start`);
      if (code === 'first') {
        await firstGate;
      }
      order.push(`${code}-end`);
      return { success: true, output: `${code}-result` };
    }
  );

  assert.deepEqual(order, ['first-start', 'first-end', 'second-start', 'second-end']);
});

test('compacts oversized action observations while saving the full output', async () => {
  const previousLimit = process.env.TELOS_MAX_TOOL_OBSERVATION_CHARS;
  process.env.TELOS_MAX_TOOL_OBSERVATION_CHARS = '2000';
  const fullOutput = `HEAD\n${'x'.repeat(5000)}\nTAIL`;

  try {
    await withTempSandbox(
      async (engine, sandboxDir) => {
        const result = await engine.executeProviderToolCall({
          id: 'tool_large',
          name: 'action',
          arguments: { content: 'large-output' },
        });

        assert.ok(result.observation.length < fullOutput.length);
        assert.match(result.observation, /action observation truncated/);
        assert.match(result.observation, /HEAD/);
        assert.match(result.observation, /TAIL/);

        const savedPath = result.observation.match(/full output saved to ([^\]]+)/)?.[1];
        assert.ok(savedPath);
        const saved = await readFile(join(sandboxDir, savedPath), 'utf-8');
        assert.equal(saved, fullOutput);
      },
      async () => ({ success: true, output: fullOutput }),
    );
  } finally {
    if (previousLimit === undefined) {
      delete process.env.TELOS_MAX_TOOL_OBSERVATION_CHARS;
    } else {
      process.env.TELOS_MAX_TOOL_OBSERVATION_CHARS = previousLimit;
    }
  }
});
