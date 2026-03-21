import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { __internals } from '../tools/utils/index.js';

test('converts common zod schema shapes to json schema', () => {
  const schema = z.object({
    name: z.string(),
    capital: z.string().optional(),
    languages: z.array(z.string()),
    status: z.enum(['ok', 'draft']),
  });

  const jsonSchema = __internals.schemaToJsonSchema(schema) as any;

  assert.equal(jsonSchema.type, 'object');
  assert.deepEqual(jsonSchema.required, ['name', 'languages', 'status']);
  assert.equal(jsonSchema.properties.name.type, 'string');
  assert.equal(jsonSchema.properties.languages.type, 'array');
  assert.deepEqual(jsonSchema.properties.status.enum, ['ok', 'draft']);
  assert.equal(jsonSchema.additionalProperties, false);
});

test('keeps relative output paths inside sandbox and appends png extension', () => {
  const originalSandboxDir = process.env.SANDBOX_DIR;
  process.env.SANDBOX_DIR = 'C:\\sandbox-root';

  try {
    const result = __internals.resolveToolPath('./shots/monitor0', { ensureImageExtension: true });
    assert.equal(result.savedToSandbox, true);
    assert.equal(result.absolutePath, 'C:\\sandbox-root\\shots\\monitor0.png');
  } finally {
    process.env.SANDBOX_DIR = originalSandboxDir;
  }
});

test('parses fenced json payloads', () => {
  const parsed = __internals.parseJsonResponse('```json\n{"ok":true}\n```');
  assert.deepEqual(parsed, { ok: true });
});

test('validates structured response with zod schema', () => {
  const schema = z.object({ ok: z.boolean() });
  const parsed = __internals.validateStructuredResponse(schema, { ok: true });
  assert.deepEqual(parsed, { ok: true });
});
