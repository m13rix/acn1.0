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
    private readonly parseFn: (content: string) => Array<{ search: string; replace: string }>,
    private readonly applyFn: (
      filename: string,
      edits: Array<{ search: string; replace: string }>
    ) => Promise<ExecutionResult>,
    private readonly actionFn: (code: string) => Promise<ExecutionResult> = async () => ({ success: true, output: 'ok' }),
    private readonly cliFn: (command: string) => Promise<ExecutionResult> = async (command: string) => ({ success: true, output: command })
  ) { }

  parseSearchReplace(content: string): Array<{ search: string; replace: string }> {
    return this.parseFn(content);
  }

  async applySearchReplace(
    filename: string,
    edits: Array<{ search: string; replace: string }>
  ): Promise<ExecutionResult> {
    return this.applyFn(filename, edits);
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
  parseFn: (content: string) => Array<{ search: string; replace: string }> = () => [],
  applyFn: (
    filename: string,
    edits: Array<{ search: string; replace: string }>
  ) => Promise<ExecutionResult> = async () => ({ success: true, output: '', filename: '' }),
  actionFn?: (code: string) => Promise<ExecutionResult>
): Promise<void> {
  const sandboxDir = await mkdtemp(join(tmpdir(), 'telos-tool-engine-'));
  try {
    const sandbox = new MockSandbox(sandboxDir, parseFn, applyFn, actionFn);
    const session = { sandbox } as any;
    const engine = new ToolExecutionEngine(session);
    await run(engine, sandboxDir);
  } finally {
    await rm(sandboxDir, { recursive: true, force: true });
  }
}

test('recovers filename/content from embedded JSON payload', async () => {
  await withTempSandbox(async (engine, sandboxDir) => {
    const result = await engine.executeProviderToolCall({
      id: 'tool_1',
      name: 'edit_file',
      arguments: {
        content: '{"filename":"./documentation/x.md","content":"hello from json"}',
      },
    });

    assert.match(result.observation, /created\/updated/i);
    const filePath = join(sandboxDir, 'documentation', 'x.md');
    const fileBody = await readFile(filePath, 'utf-8');
    assert.equal(fileBody, 'hello from json');
  });
});

test('backward compat: old "file" tool name still works', async () => {
  await withTempSandbox(async (engine, sandboxDir) => {
    const result = await engine.executeProviderToolCall({
      id: 'tool_compat',
      name: 'file',
      arguments: { filename: './compat.md', content: 'legacy name works' },
    });
    assert.match(result.observation, /created\/updated/i);
    const fileBody = await readFile(join(sandboxDir, 'compat.md'), 'utf-8');
    assert.equal(fileBody, 'legacy name works');
  });
});

test('view_file reads file contents', async () => {
  await withTempSandbox(async (engine, sandboxDir) => {
    const { writeFileSync, mkdirSync } = await import('fs');
    mkdirSync(join(sandboxDir, 'sub'), { recursive: true });
    writeFileSync(join(sandboxDir, 'sub', 'test.txt'), 'hello world', 'utf-8');
    const result = await engine.executeProviderToolCall({
      id: 'tool_view',
      name: 'view_file',
      arguments: { filename: './sub/test.txt' },
    });
    assert.equal(result.observation, 'hello world');
  });
});

test('normalizes typo path .documentation to ./documentation', async () => {
  await withTempSandbox(async (engine, sandboxDir) => {
    const result = await engine.executeProviderToolCall({
      id: 'tool_2',
      name: 'edit_file',
      arguments: {
        filename: '.documentation/06_sandbox_environment.md',
        content: 'chapter body',
      },
    });

    assert.match(result.observation, /created\/updated/i);
    const filePath = join(sandboxDir, 'documentation', '06_sandbox_environment.md');
    const fileBody = await readFile(filePath, 'utf-8');
    assert.equal(fileBody, 'chapter body');
  });
});

test('accepts filename/content aliases for file tool payload', async () => {
  await withTempSandbox(async (engine, sandboxDir) => {
    const result = await engine.executeProviderToolCall({
      id: 'tool_alias',
      name: 'EDIT_FILE',
      arguments: {
        path: './documentation/alias.md',
        body: 'alias content',
      },
    });

    assert.match(result.observation, /created\/updated/i);
    const filePath = join(sandboxDir, 'documentation', 'alias.md');
    const fileBody = await readFile(filePath, 'utf-8');
    assert.equal(fileBody, 'alias content');
  });
});

test('recovers missing file edit by creating file from REPLACE payload', async () => {
  await withTempSandbox(
    async (engine, sandboxDir) => {
      const editPayload = [
        '<<<< SEARCH',
        'old',
        '>>>>',
        '<<<< REPLACE',
        'new content from edit',
        '>>>>',
      ].join('\n');

      const result = await engine.executeProviderToolCall({
        id: 'tool_3',
        name: 'edit_file',
        arguments: {
          filename: './documentation/generated.md',
          content: editPayload,
        },
      });

      assert.match(result.observation, /Recovered by creating/i);
      const filePath = join(sandboxDir, 'documentation', 'generated.md');
      const fileBody = await readFile(filePath, 'utf-8');
      assert.equal(fileBody, 'new content from edit');
    },
    () => [{ search: 'old', replace: 'new content from edit' }],
    async (filename) => ({
      success: false,
      output: '',
      error: `File not found: "${filename}"`,
      filename,
    })
  );
});

test('normalizes whitespace tool name for action', async () => {
  await withTempSandbox(
    async (engine) => {
      const result = await engine.executeProviderToolCall({
        id: 'tool_4',
        name: ' action',
        arguments: {
          text: 'console.log("hello")',
        },
      });
      assert.equal(result.observation, 'ran');
    },
    () => [],
    async () => ({ success: true, output: '' }),
    async () => ({ success: true, output: 'ran' })
  );
});

test('handles TASK_DONE pseudo-tool directly and keeps FINISH as alias', async () => {
  await withTempSandbox(async (engine) => {
    const result = await engine.executeProviderToolCall({
      id: 'tool_5',
      name: 'TASK_DONE',
      arguments: { message: 'done successfully' },
    });

    assert.equal(result.finishMessage, 'done successfully');
    assert.match(result.observation, /TASK_DONE accepted/i);

    const legacy = await engine.executeProviderToolCall({
      id: 'tool_6',
      name: 'FINISH',
      arguments: { message: 'legacy still works' },
    });

    assert.equal(legacy.finishMessage, 'legacy still works');
  });
});
