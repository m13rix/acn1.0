import { GoogleGenAI } from '@google/genai';
import type { GeneratedDocBundle, ImportedDocSource, ImportInspectionDraft } from '../types/index.js';
import { parseJsonResponse } from '../utils/structuredLlm.js';
import {
  IMPORTED_TOOLS_DEFAULT_GEMINI_MODEL,
  IMPORTED_TOOLS_DOCS_MODE,
  IMPORTED_TOOLS_GEMINI_TIMEOUT_MS,
} from './constants.js';
import { clampText, isPlainObject } from './utils.js';

interface GenerateDocsOptions {
  preferModel?: boolean;
  timeoutMs?: number;
}

interface GeneratedDocPayload {
  toolDescription: string;
  usageMarkdown: string;
  methodDocs: Record<string, string>;
}

export function buildFallbackDocs(draft: ImportInspectionDraft): GeneratedDocBundle {
  const methodDocs = Object.fromEntries(
    draft.methods.map((method) => [method.methodName, method.description || 'Imported method.'])
  );
  return {
    toolDescription: [
      `${draft.displayName} imported ${draft.kind === 'mcp' ? 'MCP' : 'ClawHub'} tool namespace.`,
      '',
      'Available functions:',
      ...draft.methods.map((method) => `- \`${draft.namespace}.${method.methodName}(...)\` - ${methodDocs[method.methodName]}`),
    ].join('\n'),
    usageMarkdown: [
      `# ${draft.displayName}`,
      '',
      draft.description,
      '',
      '## Methods',
      ...draft.methods.map((method) => `- \`${draft.namespace}.${method.methodName}\` - ${methodDocs[method.methodName]}`),
    ].join('\n'),
    methodDocs,
    sources: draft.docs.sources,
    generatedWith: 'fallback',
  };
}

function validateDocPayload(value: unknown): GeneratedDocPayload {
  if (!isPlainObject(value)) {
    throw new Error('Gemini doc payload must be an object.');
  }
  const toolDescription = typeof value.toolDescription === 'string' ? value.toolDescription.trim() : '';
  const usageMarkdown = typeof value.usageMarkdown === 'string' ? value.usageMarkdown.trim() : '';
  const methodDocsRaw = isPlainObject(value.methodDocs) ? value.methodDocs : {};
  const methodDocs = Object.fromEntries(
    Object.entries(methodDocsRaw)
      .map(([key, entry]) => [key, String(entry).trim()])
      .filter(([, entry]) => Boolean(entry))
  );
  if (!toolDescription || !usageMarkdown) {
    throw new Error('Gemini doc payload is missing required text fields.');
  }
  return { toolDescription, usageMarkdown, methodDocs };
}

async function callGemini(prompt: string): Promise<GeneratedDocPayload> {
  const apiKey = process.env['GEMINI_KEY'] || process.env['GEMINI_API_KEY'];
  if (!apiKey) {
    throw new Error('GEMINI_KEY or GEMINI_API_KEY is required for imported-tool doc generation.');
  }

  const client = new GoogleGenAI({ apiKey });
  const response = await client.models.generateContent({
    model: IMPORTED_TOOLS_DEFAULT_GEMINI_MODEL,
    contents: prompt,
    config: {
      temperature: 0.1,
      responseMimeType: 'application/json',
    },
  });

  return validateDocPayload(parseJsonResponse(response.text || ''));
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms.`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function generateImportedDocs(
  draft: ImportInspectionDraft,
  extraSources: Array<{ name: string; content: string; kind: ImportedDocSource['kind'] }>,
  options: GenerateDocsOptions = {}
): Promise<GeneratedDocBundle> {
  const preferModel = options.preferModel ?? false;
  if (!preferModel || IMPORTED_TOOLS_DOCS_MODE === 'test' || process.env['IMPORTED_TOOLS_SKIP_GEMINI'] === '1') {
    return buildFallbackDocs(draft);
  }

  const prompt = [
    'You generate ACN imported tool docs.',
    'Return JSON with keys: toolDescription, usageMarkdown, methodDocs.',
    'toolDescription must be concise and match existing ACN tool.yaml style.',
    'usageMarkdown should be short, practical, and LLM-friendly.',
    'methodDocs must be a plain object keyed by normalized method name.',
    '',
    JSON.stringify({
      kind: draft.kind,
      displayName: draft.displayName,
      namespace: draft.namespace,
      description: draft.description,
      methods: draft.methods.map((method) => ({
        methodName: method.methodName,
        originalName: method.originalName,
        description: method.description,
        parameters: method.parameters.map((parameter) => ({
          name: parameter.name,
          required: parameter.required,
          description: parameter.description,
        })),
      })),
      risk: draft.risk,
    }, null, 2),
    '',
    ...extraSources.map((source) => `## ${source.kind}:${source.name}\n${clampText(source.content, 5000)}`),
  ].join('\n');

  try {
    const payload = await withTimeout(
      callGemini(prompt),
      options.timeoutMs || IMPORTED_TOOLS_GEMINI_TIMEOUT_MS,
      'Imported docs generation'
    );
    return {
      toolDescription: payload.toolDescription,
      usageMarkdown: payload.usageMarkdown,
      methodDocs: payload.methodDocs,
      sources: draft.docs.sources,
      generatedWith: IMPORTED_TOOLS_DEFAULT_GEMINI_MODEL,
    };
  } catch (error) {
    console.warn('[imported-tools] Falling back to deterministic docs generation:', error);
    return buildFallbackDocs(draft);
  }
}
