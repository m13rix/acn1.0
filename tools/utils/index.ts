import { mkdir, mkdtemp, readFile, rm } from 'fs/promises';
import { existsSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import sharp from 'sharp';
import type { ZodTypeAny } from 'zod';
import {
  structuredLlm as runStructuredLlm,
  structuredLlmInternals,
} from '../../src/utils/structuredLlm.js';

const execFileAsync = promisify(execFile);

const SUPPORTED_IMAGE_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.webp',
  '.bmp',
  '.gif',
]);

type JsonSchema = Record<string, unknown>;

interface ScreenshotPowerShellResult {
  outputPath: string;
  monitorIndex: number;
  x: number;
  y: number;
  width: number;
  height: number;
  deviceName?: string;
  isPrimary?: boolean;
}

interface ScreenshotResult extends ScreenshotPowerShellResult {
  path: string;
  savedToSandbox: boolean;
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

function normalizeImagePath(filePath: string): string {
  const extension = path.extname(filePath).toLowerCase();
  if (extension && SUPPORTED_IMAGE_EXTENSIONS.has(extension)) {
    return filePath;
  }
  return `${filePath}.png`;
}

function resolveToolPath(requestedPath: string, options?: { ensureImageExtension?: boolean }): { absolutePath: string; savedToSandbox: boolean } {
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

function zodToJsonSchema(schema: ZodTypeAny, seen = new WeakMap<object, JsonSchema>()): JsonSchema {
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
      const options = Array.from(unwrapped._def?.options?.values?.() || []);
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

function schemaToJsonSchema(schema: unknown): JsonSchema {
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

function parseJsonResponse(content: string): unknown {
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

function validateStructuredResponse(schema: unknown, parsed: unknown): unknown {
  if (isZodSchema(schema)) {
    const result = schema.safeParse(parsed);
    if (!result.success) {
      throw new Error(formatZodError(result.error));
    }
    return result.data;
  }

  return parsed;
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

async function captureRawMonitorScreenshot(outputPath: string, monitorIndex: number): Promise<ScreenshotPowerShellResult> {
  if (process.platform !== 'win32') {
    throw new Error('utils.screenshot is currently implemented only for Windows hosts.');
  }

  const powerShellScript = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$outputPath = [System.IO.Path]::GetFullPath($args[0])
$monitorIndex = [int]$args[1]
$screens = [System.Windows.Forms.Screen]::AllScreens

if ($screens.Length -eq 0) {
  throw 'No displays found.'
}

if ($monitorIndex -lt 0 -or $monitorIndex -ge $screens.Length) {
  throw "Monitor index $monitorIndex is out of range. Available monitors: $($screens.Length)."
}

$screen = $screens[$monitorIndex]
$bounds = $screen.Bounds
$bitmap = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)

try {
  $graphics.CopyFromScreen(
    (New-Object System.Drawing.Point($bounds.X, $bounds.Y)),
    [System.Drawing.Point]::Empty,
    $bounds.Size
  )
  $bitmap.Save($outputPath, [System.Drawing.Imaging.ImageFormat]::Png)

  [pscustomobject]@{
    outputPath = $outputPath
    monitorIndex = $monitorIndex
    x = $bounds.X
    y = $bounds.Y
    width = $bounds.Width
    height = $bounds.Height
    deviceName = $screen.DeviceName
    isPrimary = $screen.Primary
  } | ConvertTo-Json -Compress
}
finally {
  $graphics.Dispose()
  $bitmap.Dispose()
}
`;

  const { stdout, stderr } = await execFileAsync(
    'powershell',
    [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      powerShellScript,
      outputPath,
      String(monitorIndex),
    ],
    { maxBuffer: 1024 * 1024 * 5 }
  );

  const text = `${stdout || ''}\n${stderr || ''}`.trim();
  if (!text) {
    throw new Error('PowerShell did not return screenshot metadata.');
  }

  const lastLine = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean).at(-1);
  if (!lastLine) {
    throw new Error('Failed to capture screenshot metadata.');
  }

  return JSON.parse(lastLine) as ScreenshotPowerShellResult;
}

function buildScreenshotOverlay(width: number, height: number, title: string, subtitle: string): Buffer {
  const canvasWidth = Math.max(width, 480);
  const canvasHeight = Math.max(height, 84);

  const safeTitle = title
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  const safeSubtitle = subtitle
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  const svg = `
<svg xmlns="http://www.w3.org/2000/svg" width="${canvasWidth}" height="${canvasHeight}">
  <rect x="9" y="9" width="${canvasWidth - 18}" height="${canvasHeight - 18}" rx="20" ry="20"
        fill="none" stroke="#ff3b30" stroke-width="18"/>
  <rect x="24" y="18" width="${Math.min(340, canvasWidth - 48)}" height="54" rx="18" ry="18"
        fill="rgba(15, 23, 42, 0.86)" stroke="rgba(255,255,255,0.18)" stroke-width="2"/>
  <text x="42" y="40" font-size="22" font-family="Segoe UI, Arial, sans-serif"
        font-weight="700" fill="#ffffff">${safeTitle}</text>
  <text x="42" y="61" font-size="13" font-family="Segoe UI, Arial, sans-serif"
        fill="rgba(255,255,255,0.88)">${safeSubtitle}</text>
</svg>`;

  return Buffer.from(svg);
}

async function decorateScreenshot(rawScreenshotPath: string, targetPath: string, metadata: ScreenshotPowerShellResult): Promise<void> {
  const image = sharp(rawScreenshotPath);
  const info = await image.metadata();
  const width = info.width || metadata.width || 1;
  const height = info.height || metadata.height || 1;
  const border = 18;
  const header = 84;

  const overlay = buildScreenshotOverlay(
    width + border * 2,
    height + border * 2 + header,
    `Monitor ${metadata.monitorIndex}`,
    `${metadata.width}x${metadata.height} at (${metadata.x}, ${metadata.y})`
  );

  await sharp({
    create: {
      width: width + border * 2,
      height: height + border * 2 + header,
      channels: 4,
      background: '#0f172a',
    },
  })
    .composite([
      {
        input: rawScreenshotPath,
        left: border,
        top: header + border,
      },
      {
        input: overlay,
        left: 0,
        top: 0,
      },
    ])
    .toFile(targetPath);
}

export async function screenshot(filePath: string, monitorIndex: number = 0): Promise<ScreenshotResult> {
  if (!Number.isInteger(monitorIndex) || monitorIndex < 0) {
    throw new Error('monitorIndex must be a non-negative integer.');
  }

  const { absolutePath, savedToSandbox } = resolveToolPath(filePath, { ensureImageExtension: true });
  await mkdir(path.dirname(absolutePath), { recursive: true });

  const tempDir = await mkdtemp(path.join(tmpdir(), 'acn-utils-shot-'));
  const tempFile = path.join(tempDir, 'raw-monitor.png');

  try {
    const metadata = await captureRawMonitorScreenshot(tempFile, monitorIndex);
    await decorateScreenshot(tempFile, absolutePath, metadata);

    return {
      ...metadata,
      path: absolutePath,
      savedToSandbox,
    };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

export async function llm<TSchema extends ZodTypeAny>(
  prompt: string,
  schema: TSchema,
  imagePath?: string
): Promise<ReturnType<TSchema['parse']>>;
export async function llm<TJson = unknown>(
  prompt: string,
  schema: JsonSchema,
  imagePath?: string
): Promise<TJson>;
export async function llm(
  prompt: string,
  schema: ZodTypeAny | JsonSchema,
  imagePath?: string
): Promise<unknown> {
  return runStructuredLlm(prompt, schema, imagePath);
}

export const __internals = {
  ...structuredLlmInternals,
};
