import test from 'node:test';
import assert from 'node:assert/strict';
import { applyMcpDefaults } from '../runtime.js';

test('applyMcpDefaults prefers json output when response_format is available', () => {
  const method = {
    methodName: 'getCatalog',
    originalName: 'sdamgia_get_catalog',
    parameters: [],
    orderedParameters: [],
    positionalOverload: false,
    invocation: { kind: 'mcp', toolName: 'sdamgia_get_catalog' },
    inputSchema: {
      type: 'object',
      properties: {
        subject: { type: 'string' },
        response_format: { type: 'string', enum: ['json', 'markdown'] },
      },
    },
  } as any;

  assert.deepEqual(
    applyMcpDefaults(method, { subject: 'math' }),
    { subject: 'math', response_format: 'json' }
  );
});

test('applyMcpDefaults preserves explicit response_format choice', () => {
  const method = {
    methodName: 'getCatalog',
    originalName: 'sdamgia_get_catalog',
    parameters: [],
    orderedParameters: [],
    positionalOverload: false,
    invocation: { kind: 'mcp', toolName: 'sdamgia_get_catalog' },
    inputSchema: {
      type: 'object',
      properties: {
        subject: { type: 'string' },
        response_format: { type: 'string', enum: ['json', 'markdown'] },
      },
    },
  } as any;

  assert.deepEqual(
    applyMcpDefaults(method, { subject: 'math', response_format: 'markdown' }),
    { subject: 'math', response_format: 'markdown' }
  );
});
