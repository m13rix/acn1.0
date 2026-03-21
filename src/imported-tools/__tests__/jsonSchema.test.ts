import test from 'node:test';
import assert from 'node:assert/strict';
import { buildExampleValue, isFlatScalarSchema, schemaParameters, validateSchema } from '../jsonSchema.js';

test('validates nested JSON schema objects and arrays', () => {
  const schema = {
    type: 'object',
    properties: {
      query: { type: 'string' },
      limit: { type: 'integer' },
      tags: { type: 'array', items: { type: 'string' } },
      filter: {
        type: 'object',
        properties: {
          enabled: { type: 'boolean' },
        },
        required: ['enabled'],
      },
    },
    required: ['query', 'filter'],
  };

  const good = validateSchema(schema, {
    query: 'hello',
    limit: 10,
    tags: ['x'],
    filter: { enabled: true },
  });
  assert.equal(good.ok, true);

  const bad = validateSchema(schema, {
    limit: '10',
    filter: {},
  });
  assert.equal(bad.ok, false);
  assert.match(bad.errors.join(' | '), /query/);
  assert.match(bad.errors.join(' | '), /filter\.enabled/);
});

test('detects flat scalar schemas and builds examples', () => {
  const flat = {
    type: 'object',
    properties: {
      subject: { type: 'string' },
      problem_id: { type: 'string' },
    },
    required: ['subject', 'problem_id'],
  };
  assert.equal(isFlatScalarSchema(flat), true);
  assert.deepEqual(schemaParameters(flat).map((entry) => entry.name), ['subject', 'problem_id']);
  assert.deepEqual(buildExampleValue(flat), {
    subject: 'example',
    problem_id: 'example',
  });
});
