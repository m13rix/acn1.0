import type { ImportedMethodParameterSpec } from '../types/index.js';
import { isPlainObject } from './utils.js';

export interface SchemaValidationResult {
  ok: boolean;
  errors: string[];
}

function schemaType(schema: Record<string, unknown>): string | string[] | undefined {
  if (typeof schema.type === 'string' || Array.isArray(schema.type)) {
    return schema.type as string | string[];
  }
  return undefined;
}

function validatePrimitive(expected: string, value: unknown): boolean {
  switch (expected) {
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'array':
      return Array.isArray(value);
    case 'object':
      return isPlainObject(value);
    case 'null':
      return value === null;
    default:
      return true;
  }
}

function validateSchemaInternal(schema: Record<string, unknown> | undefined, value: unknown, path: string): string[] {
  if (!schema) return [];

  const errors: string[] = [];
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    errors.push(`${path} must be one of: ${schema.enum.map(String).join(', ')}`);
  }

  const expected = schemaType(schema);
  if (typeof expected === 'string' && !validatePrimitive(expected, value)) {
    errors.push(`${path} must be ${expected}`);
    return errors;
  }
  if (Array.isArray(expected) && !expected.some((entry) => validatePrimitive(entry, value))) {
    errors.push(`${path} must match one of: ${expected.join(', ')}`);
    return errors;
  }

  if (isPlainObject(value) && isPlainObject(schema.properties)) {
    const properties = schema.properties as Record<string, Record<string, unknown>>;
    const required = Array.isArray(schema.required) ? schema.required.map(String) : [];
    for (const key of required) {
      if (!(key in value)) {
        errors.push(`${path}.${key} is required`);
      }
    }
    for (const [key, childValue] of Object.entries(value)) {
      if (properties[key]) {
        errors.push(...validateSchemaInternal(properties[key], childValue, `${path}.${key}`));
      }
    }
  }

  if (Array.isArray(value) && isPlainObject(schema.items)) {
    for (let index = 0; index < value.length; index += 1) {
      errors.push(...validateSchemaInternal(schema.items as Record<string, unknown>, value[index], `${path}[${index}]`));
    }
  }

  return errors;
}

export function validateSchema(schema: Record<string, unknown> | undefined, value: unknown): SchemaValidationResult {
  const errors = validateSchemaInternal(schema, value, 'input');
  return { ok: errors.length === 0, errors };
}

export function isFlatScalarSchema(schema: Record<string, unknown> | undefined): boolean {
  if (!schema || schema.type !== 'object' || !isPlainObject(schema.properties)) return false;
  const properties = schema.properties as Record<string, Record<string, unknown>>;
  return Object.values(properties).every((property) => {
    const type = property.type;
    return typeof type === 'string' && ['string', 'number', 'integer', 'boolean'].includes(type);
  });
}

export function schemaParameters(schema: Record<string, unknown> | undefined): ImportedMethodParameterSpec[] {
  if (!schema || schema.type !== 'object' || !isPlainObject(schema.properties)) return [];
  const properties = schema.properties as Record<string, Record<string, unknown>>;
  const required = new Set(Array.isArray(schema.required) ? schema.required.map(String) : []);
  return Object.entries(properties).map(([name, property]) => ({
    name,
    description: typeof property.description === 'string' ? property.description : undefined,
    required: required.has(name),
    schema: property,
    location: 'object',
  }));
}

export function buildExampleValue(schema: Record<string, unknown> | undefined): unknown {
  if (!schema) return {};
  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    return schema.enum[0];
  }
  if (schema.type === 'string') return 'example';
  if (schema.type === 'number' || schema.type === 'integer') return 1;
  if (schema.type === 'boolean') return false;
  if (schema.type === 'array') {
    return isPlainObject(schema.items) ? [buildExampleValue(schema.items as Record<string, unknown>)] : [];
  }
  if (schema.type === 'object' && isPlainObject(schema.properties)) {
    const result: Record<string, unknown> = {};
    const required = new Set(Array.isArray(schema.required) ? schema.required.map(String) : []);
    for (const [key, child] of Object.entries(schema.properties as Record<string, Record<string, unknown>>)) {
      if (required.has(key)) {
        result[key] = buildExampleValue(child);
      }
    }
    return result;
  }
  return {};
}

export function schemaToTsType(schema: Record<string, unknown> | undefined): string {
  if (!schema) return 'Record<string, unknown>';
  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    return schema.enum.map((entry) => JSON.stringify(entry)).join(' | ');
  }
  if (schema.type === 'string') return 'string';
  if (schema.type === 'number' || schema.type === 'integer') return 'number';
  if (schema.type === 'boolean') return 'boolean';
  if (schema.type === 'null') return 'null';
  if (schema.type === 'array') {
    return `${schemaToTsType(isPlainObject(schema.items) ? schema.items as Record<string, unknown> : undefined)}[]`;
  }
  if (schema.type === 'object' && isPlainObject(schema.properties)) {
    const required = new Set(Array.isArray(schema.required) ? schema.required.map(String) : []);
    const entries = Object.entries(schema.properties as Record<string, Record<string, unknown>>)
      .map(([key, property]) => `${JSON.stringify(key)}${required.has(key) ? '' : '?'}: ${schemaToTsType(property)};`);
    return `{ ${entries.join(' ')} }`;
  }
  return 'unknown';
}
