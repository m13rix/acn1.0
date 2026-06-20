import test from 'node:test';
import assert from 'node:assert/strict';
import { buildProviderToolRequest } from '../providerTools.js';
import { PRIMARY_COMPLETION_FUNCTION } from '../completion.js';

test('buildProviderToolRequest includes the completion tool', () => {
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
