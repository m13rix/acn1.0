import test from 'node:test';
import assert from 'node:assert/strict';
import { buildProviderToolRequest } from '../providerTools.js';
import { PRIMARY_COMPLETION_FUNCTION } from '../completion.js';

test('buildProviderToolRequest includes the completion tool', () => {
  const request = buildProviderToolRequest();
  const toolNames = request.tools.map(tool => tool.function.name);

  assert.ok(toolNames.includes('action'));
  assert.ok(toolNames.includes('cli'));
  assert.ok(toolNames.includes('file'));
  assert.ok(toolNames.includes(PRIMARY_COMPLETION_FUNCTION));
});
