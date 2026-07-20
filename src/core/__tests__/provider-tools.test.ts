import test from 'node:test';
import assert from 'node:assert/strict';
import { buildProviderToolRequest } from '../providerTools.js';
import { PRIMARY_COMPLETION_FUNCTION } from '../completion.js';

test('buildProviderToolRequest keeps the default cloud-compatible action-only tool shape', () => {
  const request = buildProviderToolRequest();
  const toolNames = request.tools.map(tool => tool.function.name);

  assert.deepEqual(toolNames, ['action']);
});

test('buildProviderToolRequest omits the completion tool when finish is optional', () => {
  const request = buildProviderToolRequest(false);
  const toolNames = request.tools.map(tool => tool.function.name);

  assert.deepEqual(toolNames, ['action']);
  assert.ok(!toolNames.includes(PRIMARY_COMPLETION_FUNCTION));
});

test('buildProviderToolRequest can expose native TASK_DONE for local providers', () => {
  const request = buildProviderToolRequest(true, {
    includeCompletionTool: true,
    strict: true,
  });
  const toolNames = request.tools.map(tool => tool.function.name);

  assert.deepEqual(toolNames, ['action', PRIMARY_COMPLETION_FUNCTION]);
  assert.equal(request.tools[0]?.function.strict, true);
  assert.equal(request.tools[1]?.function.strict, true);
  assert.deepEqual(request.tools[1]?.function.parameters?.required, ['message']);
});
