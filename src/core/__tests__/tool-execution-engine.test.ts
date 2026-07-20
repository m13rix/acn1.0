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
  sessionOverrides: Record<string, unknown> = {},
): Promise<void> {
  const sandboxDir = await mkdtemp(join(tmpdir(), 'telos-tool-engine-'));
  try {
    const sandbox = new MockSandbox(sandboxDir, actionFn);
    const session = { id: 'test-session', sandbox, ...sessionOverrides } as any;
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

test('strips duplicate injected tool requires before first action execution', async () => {
  let executedCode = '';

  await withTempSandbox(
    async (engine) => {
      const result = await engine.executeProviderToolCall({
        id: 'tool_duplicate_imports',
        name: 'action',
        arguments: {
          content: [
            "const files = require('files');",
            "const memory = require('memory');",
            "const { files } = require;",
            "const { memory: mem } = require;",
            "console.log(JSON.stringify(await files.list('.')));",
            "console.log(JSON.stringify(await mem.search('vision')));",
          ].join('\n'),
        },
      });

      assert.match(result.observation, /AUTO-FIX: pre-run removed duplicate import\(s\)/);
      assert.doesNotMatch(executedCode, /require\('files'\)/);
      assert.doesNotMatch(executedCode, /require\('memory'\)/);
      assert.doesNotMatch(executedCode, /const \{ files \} = require/);
      assert.doesNotMatch(executedCode, /const \{ memory: mem \} = require/);
      assert.match(executedCode, /files\.list/);
      assert.match(executedCode, /memory\.search/);
      assert.doesNotMatch(executedCode, /\bmem\.search/);
    },
    async (code) => {
      executedCode = code;
      return { success: true, output: 'ok' };
    },
    {
      tools: [{ config: { name: 'memory' } }],
    }
  );
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

test('treats an action TASK_DONE sentinel as internal control output', async () => {
  await withTempSandbox(
    async (engine) => {
      const result = await engine.executeProviderToolCall({
        id: 'tool_action_finish',
        name: 'action',
        arguments: { content: 'TASK_DONE("done")' },
      });

      assert.equal(result.finishMessage, 'done');
      assert.equal(result.observation, '');
      assert.doesNotMatch(result.observation, /TELOS_TASK_DONE|done/);
    },
    async () => ({
      success: true,
      output: '__TELOS_TASK_DONE_START__"done"__TELOS_TASK_DONE_END__',
    }),
  );
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

test('developer trace exposes raw model-authored action code', async () => {
  const sandboxDir = await mkdtemp(join(tmpdir(), 'telos-structured-trace-'));
  let surfacedAction = '';
  try {
    const sandbox = new MockSandbox(sandboxDir, async () => ({ success: true, output: 'MODE\nplanning' }));
    const session = {
      id: 'root-session',
      sandbox,
      tools: [],
      agent: { config: { actionToolPolicy: { builtins: [], allowImports: false } } },
    } as any;
    const engine = new ToolExecutionEngine(session, { onAction: (code) => { surfacedAction = code; } });
    const result = await engine.executeProviderToolCall({
      id: 'root_action',
      name: 'action',
      arguments: { content: 'console.log("MODE\\nplanning")' },
    });
    assert.equal(surfacedAction, 'console.log("MODE\\nplanning")');
    assert.match(result.observation, /MODE\nplanning/);
  } finally {
    await rm(sandboxDir, { recursive: true, force: true });
  }
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

test('does not truncate the terminal finalMessage of an agents.run result', async () => {
  const previousLimit = process.env.TELOS_MAX_TOOL_OBSERVATION_CHARS;
  process.env.TELOS_MAX_TOOL_OBSERVATION_CHARS = '2000';
  const finalMessage = `EXECUTOR_EVIDENCE\n${'evidence '.repeat(1000)}`;
  const output = `{\n  jobName: 'job-1',\n  finalMessage: ${JSON.stringify(finalMessage)}\n}`;

  try {
    await withTempSandbox(
      async (engine) => {
        const result = await engine.executeProviderToolCall({
          id: 'agent_result',
          name: 'action',
          arguments: { content: 'agent-result' },
        });

        assert.equal(result.observation, output);
        assert.doesNotMatch(result.observation, /observation truncated/);
      },
      async () => ({ success: true, output }),
    );
  } finally {
    if (previousLimit === undefined) delete process.env.TELOS_MAX_TOOL_OBSERVATION_CHARS;
    else process.env.TELOS_MAX_TOOL_OBSERVATION_CHARS = previousLimit;
  }
});
