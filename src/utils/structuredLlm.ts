import { existsSync } from 'fs';
import { readFile } from 'fs/promises';
import path from 'path';
import { Ollama } from 'ollama';
import { AgentLoader } from '../loaders/AgentLoader.js';
import type { AgentConfig } from '../types/index.js';
import type { ZodTypeAny } from 'zod';

const DEFAULT_MODEL = 'qwen3.5:9b';
const DEFAULT_OLLAMA_HOST = process.env.OLLAMA_HOST || 'http://localhost:11434';
const SUPPORTED_IMAGE_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.webp',
  '.bmp',
  '.gif',
]);

export type JsonSchema = Record<string, unknown>;

export interface StructuredLlmRuntimeConfig {
  provider: string;
  model: string;
  host: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function getSandboxRoot(): string {
  return path.resolve(process.env.SANDBOX_DIR || process.cwd());
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isZodSchema(value: unknown): value is ZodTypeAny {
  return !!value
    && typeof value === 'object'
    && typeof (value as ZodTypeAny).safeParse === 'function'
    && isPlainObject((value as ZodTypeAny)._def);
}

function isJsonSchemaObject(value: unknown): value is JsonSchema {
  if (!isPlainObject(value)) {
    return false;
  }

  return ['type', 'properties', 'items', 'anyOf', 'allOf', '$ref', 'enum', 'const']
    .some(key => key in value);
}

function literalType(value: unknown): string | undefined {
  switch (typeof value) {
    case 'string':
      return 'string';
    case 'number':
      return Number.isInteger(value) ? 'integer' : 'number';
    case 'boolean':
      return 'boolean';
    default:
      return value === null ? 'null' : undefined;
  }
}

function getZodTypeName(schema: ZodTypeAny): string {
  return String(schema?._def?.typeName || '');
}

function unwrapZodSchema(schema: ZodTypeAny): ZodTypeAny {
  let current = schema;

  while (true) {
    const typeName = getZodTypeName(current);
    if (typeName === 'ZodOptional' || typeName === 'ZodNullable' || typeName === 'ZodDefault' || typeName === 'ZodCatch') {
      const inner = current._def?.innerType;
      if (!inner) {
        return current;
      }
      current = inner as ZodTypeAny;
      continue;
    }

    if (typeName === 'ZodEffects') {
      const inner = current._def?.schema;
      if (!inner) {
        return current;
      }
      current = inner as ZodTypeAny;
      continue;
    }

    return current;
  }
}

function isOptionalSchema(schema: ZodTypeAny): boolean {
  if (typeof (schema as any).isOptional === 'function') {
    try {
      return Boolean((schema as any).isOptional());
    } catch {
      // Fall back to type-name checks below.
    }
  }

  const typeName = getZodTypeName(schema);
  return typeName === 'ZodOptional' || typeName === 'ZodDefault';
}

function getObjectShape(schema: ZodTypeAny): Record<string, ZodTypeAny> {
  const rawShape = schema._def?.shape;
  if (typeof rawShape === 'function') {
    return rawShape();
  }
  if (isPlainObject(rawShape)) {
    return rawShape as Record<string, ZodTypeAny>;
  }
  return {};
}

export function zodToJsonSchema(schema: ZodTypeAny, seen = new WeakMap<object, JsonSchema>()): JsonSchema {
  const unwrapped = unwrapZodSchema(schema);
  if (seen.has(unwrapped)) {
    return seen.get(unwrapped)!;
  }

  const typeName = getZodTypeName(unwrapped);

  switch (typeName) {
    case 'ZodString':
      return { type: 'string' };
    case 'ZodNumber':
      return { type: 'number' };
    case 'ZodBigInt':
      return { type: 'integer' };
    case 'ZodBoolean':
      return { type: 'boolean' };
    case 'ZodNull':
      return { type: 'null' };
    case 'ZodDate':
      return { type: 'string', format: 'date-time' };
    case 'ZodLiteral': {
      const literalValue = unwrapped._def?.value;
      const literalSchema: JsonSchema = { const: literalValue };
      const type = literalType(literalValue);
      if (type) {
        literalSchema.type = type;
      }
      return literalSchema;
    }
    case 'ZodEnum': {
      const values = Array.isArray(unwrapped._def?.values) ? unwrapped._def.values : [];
      return { type: 'string', enum: values };
    }
    case 'ZodNativeEnum': {
      const enumValues = Object.values(unwrapped._def?.values || {}).filter(value => {
        const valueType = typeof value;
        return valueType === 'string' || valueType === 'number';
      });
      const uniqueValues = Array.from(new Set(enumValues));
      const types = Array.from(new Set(uniqueValues.map(value => typeof value === 'number'
        ? (Number.isInteger(value) ? 'integer' : 'number')
        : 'string')));

      return {
        type: types.length === 1 ? types[0] : types,
        enum: uniqueValues,
      };
    }
    case 'ZodArray':
      return { type: 'array', items: zodToJsonSchema(unwrapped._def?.type as ZodTypeAny, seen) };
    case 'ZodTuple': {
      const items = Array.isArray(unwrapped._def?.items) ? unwrapped._def.items : [];
      return {
        type: 'array',
        items: items.map((item: ZodTypeAny) => zodToJsonSchema(item, seen)),
        minItems: items.length,
        maxItems: items.length,
      };
    }
    case 'ZodRecord':
      return {
        type: 'object',
        additionalProperties: zodToJsonSchema(
          (unwrapped._def?.valueType || unwrapped._def?.type) as ZodTypeAny,
          seen
        ),
      };
    case 'ZodUnion': {
      const options = Array.isArray(unwrapped._def?.options) ? unwrapped._def.options : [];
      return { anyOf: options.map((option: ZodTypeAny) => zodToJsonSchema(option, seen)) };
    }
    case 'ZodDiscriminatedUnion': {
      const options = Array.from(unwrapped._def?.options?.values?.() || []) as ZodTypeAny[];
      return { anyOf: options.map((option: ZodTypeAny) => zodToJsonSchema(option, seen)) };
    }
    case 'ZodIntersection':
      return {
        allOf: [
          zodToJsonSchema(unwrapped._def?.left as ZodTypeAny, seen),
          zodToJsonSchema(unwrapped._def?.right as ZodTypeAny, seen),
        ],
      };
    case 'ZodLazy': {
      const placeholder: JsonSchema = {};
      seen.set(unwrapped, placeholder);
      const next = unwrapped._def?.getter?.();
      const resolved = next ? zodToJsonSchema(next as ZodTypeAny, seen) : placeholder;
      Object.assign(placeholder, resolved);
      return placeholder;
    }
    case 'ZodObject': {
      const placeholder: JsonSchema = {
        type: 'object',
        properties: {},
        additionalProperties: false,
      };
      seen.set(unwrapped, placeholder);

      const shape = getObjectShape(unwrapped);
      const properties: Record<string, JsonSchema> = {};
      const required: string[] = [];

      for (const [key, childSchema] of Object.entries(shape)) {
        properties[key] = zodToJsonSchema(childSchema, seen);
        if (!isOptionalSchema(childSchema)) {
          required.push(key);
        }
      }

      placeholder.properties = properties;
      if (required.length > 0) {
        placeholder.required = required;
      }
      return placeholder;
    }
    case 'ZodAny':
    case 'ZodUnknown':
      return {};
    default:
      return {};
  }
}

export function schemaToJsonSchema(schema: unknown): JsonSchema {
  if (isZodSchema(schema)) {
    return zodToJsonSchema(schema);
  }
  if (isJsonSchemaObject(schema)) {
    return schema;
  }

  throw new Error('schema must be a Zod schema or a JSON schema object.');
}

function formatZodError(error: any): string {
  const issues = Array.isArray(error?.issues) ? error.issues : [];
  if (issues.length === 0) {
    return error?.message || 'Unknown validation error';
  }

  return issues
    .map((issue: any) => {
      const issuePath = Array.isArray(issue?.path) && issue.path.length > 0
        ? issue.path.join('.')
        : '<root>';
      return `${issuePath}: ${issue?.message || 'invalid value'}`;
    })
    .join('; ');
}

function normalizeSchemaTypes(type: unknown): string[] {
  if (typeof type === 'string' && type) {
    return [type];
  }
  if (Array.isArray(type)) {
    return type.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0);
  }
  return [];
}

function jsonValueType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  switch (typeof value) {
    case 'string':
      return 'string';
    case 'number':
      return Number.isInteger(value) ? 'integer' : 'number';
    case 'boolean':
      return 'boolean';
    case 'object':
      return 'object';
    default:
      return typeof value;
  }
}

function joinPath(pathParts: string[]): string {
  return pathParts.length === 0 ? '<root>' : pathParts.join('.');
}

function getSchemaPropertyMap(schema: JsonSchema): Record<string, JsonSchema> {
  return isPlainObject(schema.properties)
    ? schema.properties as Record<string, JsonSchema>
    : {};
}

function getSchemaAllowedTypes(schema: JsonSchema): string[] {
  return normalizeSchemaTypes(schema.type);
}

function valueMatchesSchemaTypes(value: unknown, allowedTypes: string[]): boolean {
  if (allowedTypes.length === 0) {
    return true;
  }

  const actualType = jsonValueType(value);
  return allowedTypes.some((allowedType) => {
    if (allowedType === 'number') {
      return actualType === 'number' || actualType === 'integer';
    }
    return actualType === allowedType;
  });
}

function repairParsedValueForJsonSchema(schema: JsonSchema, value: unknown): unknown {
  if (!isPlainObject(value)) {
    return value;
  }

  const schemaTypes = getSchemaAllowedTypes(schema);
  if (schemaTypes.length > 0 && !schemaTypes.includes('object')) {
    return value;
  }

  const properties = getSchemaPropertyMap(schema);
  const required = Array.isArray(schema.required)
    ? schema.required.filter((entry): entry is string => typeof entry === 'string')
    : [];

  if (Object.keys(properties).length === 0 || required.length === 0) {
    return value;
  }

  const repaired: Record<string, unknown> = { ...value };
  const extraKeys = Object.keys(repaired).filter((key) => !(key in properties));
  const missingKeys = required.filter((key) => !(key in repaired));
  const consumedExtraKeys = new Set<string>();

  for (const missingKey of missingKeys) {
    const propertySchema = properties[missingKey];
    if (!propertySchema) {
      continue;
    }

    const candidates = extraKeys.filter((extraKey) => {
      if (consumedExtraKeys.has(extraKey)) {
        return false;
      }
      return valueMatchesSchemaTypes(repaired[extraKey], getSchemaAllowedTypes(propertySchema));
    });

    if (candidates.length === 1) {
      const [candidateKey] = candidates;
      repaired[missingKey] = repaired[candidateKey!];
      consumedExtraKeys.add(candidateKey!);
      delete repaired[candidateKey!];
    }
  }

  return repaired;
}

function validateAgainstJsonSchema(schema: JsonSchema, value: unknown, pathParts: string[] = []): void {
  if (Array.isArray(schema.anyOf) && schema.anyOf.length > 0) {
    const errors: string[] = [];
    for (const candidate of schema.anyOf) {
      try {
        validateAgainstJsonSchema(candidate as JsonSchema, value, pathParts);
        return;
      } catch (error) {
        errors.push((error as Error).message);
      }
    }
    throw new Error(errors[0] || `${joinPath(pathParts)}: value does not match any allowed schema`);
  }

  if (Array.isArray(schema.allOf) && schema.allOf.length > 0) {
    for (const candidate of schema.allOf) {
      validateAgainstJsonSchema(candidate as JsonSchema, value, pathParts);
    }
  }

  if ('const' in schema && value !== schema.const) {
    throw new Error(`${joinPath(pathParts)}: expected const value ${JSON.stringify(schema.const)}`);
  }

  if (Array.isArray(schema.enum) && schema.enum.length > 0 && !schema.enum.some(entry => entry === value)) {
    throw new Error(`${joinPath(pathParts)}: expected one of ${schema.enum.map(entry => JSON.stringify(entry)).join(', ')}`);
  }

  const allowedTypes = normalizeSchemaTypes(schema.type);
  if (allowedTypes.length > 0) {
    const actualType = jsonValueType(value);
    const matches = allowedTypes.some((allowedType) => {
      if (allowedType === 'number') {
        return actualType === 'number' || actualType === 'integer';
      }
      return actualType === allowedType;
    });

    if (!matches) {
      throw new Error(`${joinPath(pathParts)}: expected ${allowedTypes.join(' | ')}, received ${actualType}`);
    }
  }

  if (schema.type === 'object' || (!schema.type && isPlainObject(value))) {
    if (!isPlainObject(value)) {
      throw new Error(`${joinPath(pathParts)}: expected object`);
    }

    const properties = isPlainObject(schema.properties)
      ? schema.properties as Record<string, JsonSchema>
      : {};
    const required = Array.isArray(schema.required)
      ? schema.required.filter((entry): entry is string => typeof entry === 'string')
      : [];

    for (const requiredKey of required) {
      if (!(requiredKey in value)) {
        throw new Error(`${joinPath([...pathParts, requiredKey])}: is required`);
      }
    }

    for (const [key, propertyValue] of Object.entries(value)) {
      if (properties[key]) {
        validateAgainstJsonSchema(properties[key]!, propertyValue, [...pathParts, key]);
        continue;
      }

      if (schema.additionalProperties === false) {
        throw new Error(`${joinPath([...pathParts, key])}: additional properties are not allowed`);
      }

      if (isPlainObject(schema.additionalProperties)) {
        validateAgainstJsonSchema(schema.additionalProperties as JsonSchema, propertyValue, [...pathParts, key]);
      }
    }
  }

  if (schema.type === 'array' || (!schema.type && Array.isArray(value))) {
    if (!Array.isArray(value)) {
      throw new Error(`${joinPath(pathParts)}: expected array`);
    }

    if (typeof schema.minItems === 'number' && value.length < schema.minItems) {
      throw new Error(`${joinPath(pathParts)}: expected at least ${schema.minItems} item(s)`);
    }

    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) {
      throw new Error(`${joinPath(pathParts)}: expected at most ${schema.maxItems} item(s)`);
    }

    if (Array.isArray(schema.items)) {
      value.forEach((entry, index) => {
        const itemSchema = schema.items![index];
        if (itemSchema) {
          validateAgainstJsonSchema(itemSchema as JsonSchema, entry, [...pathParts, String(index)]);
        }
      });
    } else if (isPlainObject(schema.items)) {
      value.forEach((entry, index) => {
        validateAgainstJsonSchema(schema.items as JsonSchema, entry, [...pathParts, String(index)]);
      });
    }
  }
}

export function parseJsonResponse(content: string): unknown {
  const candidates: string[] = [];
  const trimmed = String(content || '').trim();

  if (!trimmed) {
    throw new Error('Model returned an empty response.');
  }

  candidates.push(trimmed);

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced?.[1]) {
    candidates.push(fenced[1].trim());
  }

  const firstObject = trimmed.indexOf('{');
  const lastObject = trimmed.lastIndexOf('}');
  if (firstObject !== -1 && lastObject > firstObject) {
    candidates.push(trimmed.slice(firstObject, lastObject + 1));
  }

  const firstArray = trimmed.indexOf('[');
  const lastArray = trimmed.lastIndexOf(']');
  if (firstArray !== -1 && lastArray > firstArray) {
    candidates.push(trimmed.slice(firstArray, lastArray + 1));
  }

  const uniqueCandidates = Array.from(new Set(candidates.filter(Boolean)));
  let lastError: unknown;

  for (const candidate of uniqueCandidates) {
    try {
      return JSON.parse(candidate);
    } catch (error) {
      lastError = error;
    }
  }

  throw new Error(`Failed to parse model response as JSON: ${(lastError as Error | undefined)?.message || 'unknown error'}`);
}

export function validateStructuredResponse(schema: unknown, parsed: unknown): unknown {
  if (isZodSchema(schema)) {
    const result = schema.safeParse(parsed);
    if (!result.success) {
      throw new Error(formatZodError(result.error));
    }
    return result.data;
  }

  if (isJsonSchemaObject(schema)) {
    const repaired = repairParsedValueForJsonSchema(schema, parsed);
    validateAgainstJsonSchema(schema, repaired);
    return repaired;
  }

  return parsed;
}

function normalizeImagePath(filePath: string): string {
  const extension = path.extname(filePath).toLowerCase();
  if (extension && SUPPORTED_IMAGE_EXTENSIONS.has(extension)) {
    return filePath;
  }
  return `${filePath}.png`;
}

export function resolveToolPath(
  requestedPath: string,
  options?: { ensureImageExtension?: boolean }
): { absolutePath: string; savedToSandbox: boolean } {
  if (typeof requestedPath !== 'string' || !requestedPath.trim()) {
    throw new Error('Path must be a non-empty string.');
  }

  const sandboxRoot = getSandboxRoot();
  const trimmedPath = requestedPath.trim();
  const wantsAbsolute = path.isAbsolute(trimmedPath);

  let absolutePath = wantsAbsolute
    ? path.resolve(trimmedPath)
    : path.resolve(sandboxRoot, trimmedPath);

  if (!wantsAbsolute) {
    const relativeToSandbox = path.relative(sandboxRoot, absolutePath);
    if (relativeToSandbox.startsWith('..') || path.isAbsolute(relativeToSandbox)) {
      throw new Error(`Relative path "${requestedPath}" resolves outside the sandbox.`);
    }
  }

  if (options?.ensureImageExtension) {
    absolutePath = normalizeImagePath(absolutePath);
  }

  return {
    absolutePath,
    savedToSandbox: !wantsAbsolute,
  };
}

async function loadImageAsBase64(imagePath: string): Promise<string> {
  const { absolutePath } = resolveToolPath(imagePath);

  if (!existsSync(absolutePath)) {
    throw new Error(`Image file not found: ${imagePath}`);
  }

  const extension = path.extname(absolutePath).toLowerCase();
  if (!SUPPORTED_IMAGE_EXTENSIONS.has(extension)) {
    throw new Error(`Unsupported image extension "${extension}". Supported: ${Array.from(SUPPORTED_IMAGE_EXTENSIONS).join(', ')}`);
  }

  const buffer = await readFile(absolutePath);
  return buffer.toString('base64');
}

async function loadCurrentAgentConfig(): Promise<AgentConfig | null> {
  const currentAgentName = process.env.ACN_AGENT_NAME;
  if (!currentAgentName) {
    return null;
  }

  const loader = new AgentLoader();
  const loadedAgent = await loader.loadByName(currentAgentName);
  return loadedAgent?.config || null;
}

export async function resolveStructuredLlmConfig(): Promise<StructuredLlmRuntimeConfig> {
  const agentConfig = await loadCurrentAgentConfig();
  const configuredProvider = agentConfig?.utils?.llm?.provider?.trim();
  const configuredModel = agentConfig?.utils?.llm?.model?.trim();
  const configuredHost = agentConfig?.utils?.llm?.host?.trim();

  return {
    provider: configuredProvider || 'ollama',
    model: configuredModel || process.env.ACN_UTILS_LLM_MODEL || DEFAULT_MODEL,
    host: configuredHost || DEFAULT_OLLAMA_HOST,
  };
}

function isRetryableOllamaError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error || '');
  return /model runner has unexpectedly stopped/i.test(message)
    || /status[_\s-]*code.*500/i.test(message)
    || /ECONNRESET/i.test(message)
    || /socket hang up/i.test(message)
    || /fetch failed/i.test(message);
}

export async function structuredLlm<TSchema extends ZodTypeAny>(
  prompt: string,
  schema: TSchema,
  imagePath?: string
): Promise<ReturnType<TSchema['parse']>>;
export async function structuredLlm<TJson = unknown>(
  prompt: string,
  schema: JsonSchema,
  imagePath?: string
): Promise<TJson>;
export async function structuredLlm(
  prompt: string,
  schema: ZodTypeAny | JsonSchema,
  imagePath?: string
): Promise<unknown> {
  if (typeof prompt !== 'string' || !prompt.trim()) {
    throw new Error('prompt must be a non-empty string.');
  }

  const runtime = await resolveStructuredLlmConfig();
  if (runtime.provider.toLowerCase() !== 'ollama') {
    throw new Error(`utils.llm supports only provider="ollama", received "${runtime.provider}".`);
  }

  const jsonSchema = schemaToJsonSchema(schema);
  const client = new Ollama({ host: runtime.host });
  const images = imagePath ? [await loadImageAsBase64(imagePath)] : undefined;

  const systemPrompt = [
    'You are a structured-output helper.',
    'Return only valid JSON.',
    'Do not wrap the answer in markdown fences.',
    'Do not add commentary, explanations, or extra keys.',
    'The JSON must satisfy the provided schema exactly.',
  ].join(' ');

  const messages: Array<{ role: string; content: string; images?: string[] }> = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: prompt.trim(), images },
  ];

  let lastError = 'unknown error';

  for (let attempt = 0; attempt < 3; attempt++) {
    let response;
    let transportError: unknown;

    for (let transportAttempt = 0; transportAttempt < 3; transportAttempt++) {
      try {
        response = await client.chat({
          model: runtime.model,
          stream: false,
          think: false,
          format: jsonSchema,
          messages,
          options: {
            temperature: 0,
          },
        });
        transportError = null;
        break;
      } catch (error) {
        transportError = error;
        if (!isRetryableOllamaError(error) || transportAttempt === 2) {
          throw error;
        }
        await sleep(400 * (transportAttempt + 1));
      }
    }

    if (!response) {
      throw transportError instanceof Error ? transportError : new Error(String(transportError || 'Unknown Ollama transport error'));
    }

    const rawContent = response.message?.content || '';

    try {
      const parsed = parseJsonResponse(rawContent);
      return validateStructuredResponse(schema, parsed);
    } catch (error: any) {
      lastError = error?.message || String(error);
      messages.push({
        role: 'assistant',
        content: rawContent,
      });
      messages.push({
        role: 'user',
        content: `The previous response was invalid: ${lastError}. Return only corrected JSON that matches the schema exactly.`,
      });
    }
  }

  throw new Error(`utils.llm failed to produce valid structured JSON after 3 attempts: ${lastError}`);
}

export const structuredLlmInternals = {
  schemaToJsonSchema,
  resolveToolPath,
  parseJsonResponse,
  validateStructuredResponse,
};
