import test from 'node:test';
import assert from 'node:assert/strict';
import { validateStructuredResponse } from '../structuredLlm.js';

test('validateStructuredResponse enforces JSON schema required keys and additionalProperties', () => {
  const schema = {
    type: 'object',
    additionalProperties: false,
    properties: {
      shouldHandle: { type: 'boolean' },
      reason: { type: 'string' },
    },
    required: ['shouldHandle', 'reason'],
  };

  const valid = validateStructuredResponse(schema, {
    shouldHandle: true,
    reason: 'looks like homework',
  });

  assert.deepEqual(valid, {
    shouldHandle: true,
    reason: 'looks like homework',
  });

  assert.throws(() => validateStructuredResponse(schema, {
    junk: 123,
    is_homework: true,
    reason: 'wrong field name',
  }), /shouldHandle.*required|additional properties are not allowed/i);
});

test('validateStructuredResponse repairs a single compatible extra key into a missing required key', () => {
  const schema = {
    type: 'object',
    additionalProperties: false,
    properties: {
      shouldHandle: { type: 'boolean' },
      reason: { type: 'string' },
    },
    required: ['shouldHandle', 'reason'],
  };

  const repaired = validateStructuredResponse(schema, {
    is_homework: true,
    reason: 'explicit homework wording',
  });

  assert.deepEqual(repaired, {
    shouldHandle: true,
    reason: 'explicit homework wording',
  });
});
