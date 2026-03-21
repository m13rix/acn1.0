import { GoogleGenAI, ThinkingLevel, Type } from '@google/genai';
import type {
  GeneratedSkillBundle,
  GeneratedSkillEntry,
  ImportedDocSource,
  ImportInspectionDraft,
} from '../types/index.js';
import { parseJsonResponse } from '../utils/structuredLlm.js';
import {
  IMPORTED_TOOLS_DEFAULT_GEMINI_MODEL,
  IMPORTED_TOOLS_DOCS_MODE,
  IMPORTED_TOOLS_GEMINI_TIMEOUT_MS,
} from './constants.js';
import { clampText, isPlainObject } from './utils.js';

interface GeneratedSkillPayload {
  entries: GeneratedSkillEntry[];
}

interface GenerateSkillsOptions {
  preferModel?: boolean;
  timeoutMs?: number;
}

export function buildFallbackSkills(draft: ImportInspectionDraft): GeneratedSkillBundle {
  const entries = draft.methods.map((method) => {
    const parameterList = method.parameters.length > 0
      ? method.parameters
        .map((parameter) => `${parameter.name}${parameter.required ? ' (required)' : ' (optional)'}`)
        .join(', ')
      : 'no parameters';

    return {
      title: `${draft.namespace}.${method.methodName}`,
      content: [
        `Use \`${draft.namespace}.${method.methodName}\` when ${method.description || 'this imported method matches the user request'}.`,
        `Prefer the object form: \`${draft.namespace}.${method.methodName}({ ... })\`.`,
        `Parameters: ${parameterList}.`,
      ].join('\n'),
      examples: [
        `Need ${draft.displayName} to ${method.methodName}`,
        `Use ${draft.namespace}.${method.methodName} for ${method.originalName}`,
      ],
      scoreThreshold: 0.82,
    };
  });

  return {
    entries,
    generatedWith: 'fallback',
    sourceSummary: 'Generated from MCP tool inspection metadata.',
  };
}

function validateSkillPayload(value: unknown): GeneratedSkillPayload {
  if (!isPlainObject(value) || !Array.isArray(value.entries)) {
    throw new Error('Gemini skill payload must contain an entries array.');
  }

  const entries = value.entries
    .filter((entry) => isPlainObject(entry))
    .map((entry) => {
      const title = typeof entry.title === 'string' ? entry.title.trim() : '';
      const content = typeof entry.content === 'string' ? entry.content.trim() : '';
      const examples = Array.isArray(entry.examples)
        ? entry.examples
          .map((example) => typeof example === 'string' ? example.trim() : '')
          .filter(Boolean)
        : [];
      const scoreThreshold = typeof entry.scoreThreshold === 'number'
        ? entry.scoreThreshold
        : undefined;

      return { title, content, examples, scoreThreshold };
    })
    .filter((entry) => entry.title && entry.content && entry.examples.length > 0);

  if (entries.length === 0) {
    throw new Error('Gemini skill payload did not contain any valid entries.');
  }

  return { entries };
}

async function callGemini(prompt: string): Promise<GeneratedSkillPayload> {
  const apiKey = process.env['GEMINI_KEY'] || process.env['GEMINI_API_KEY'];
  if (!apiKey) {
    throw new Error('GEMINI_KEY or GEMINI_API_KEY is required for imported-tool skill generation.');
  }

  const client = new GoogleGenAI({ apiKey });
  const response = await client.models.generateContent({
    model: IMPORTED_TOOLS_DEFAULT_GEMINI_MODEL,
    contents: prompt,
    config: {
      thinkingConfig: {
        thinkingLevel: ThinkingLevel.MINIMAL,
      },
      responseMimeType: 'application/json',
      responseSchema: {
        type: Type.OBJECT,
        required: ['entries'],
        properties: {
          entries: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              required: ['title', 'content', 'examples'],
              properties: {
                title: { type: Type.STRING },
                content: { type: Type.STRING },
                examples: {
                  type: Type.ARRAY,
                  items: { type: Type.STRING },
                },
                scoreThreshold: { type: Type.NUMBER },
              },
            },
          },
        },
      },
    },
  });

  return validateSkillPayload(parseJsonResponse(response.text || ''));
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

export async function generateImportedSkills(
  draft: ImportInspectionDraft,
  extraSources: Array<{ name: string; content: string; kind: ImportedDocSource['kind'] }>,
  options: GenerateSkillsOptions = {}
): Promise<GeneratedSkillBundle> {
  const preferModel = options.preferModel ?? false;
  if (!preferModel || IMPORTED_TOOLS_DOCS_MODE === 'test' || process.env['IMPORTED_TOOLS_SKIP_GEMINI'] === '1') {
    return buildFallbackSkills(draft);
  }

  const prompt = [
    'You generate embedded ACN tool skills for example-based retrieval.',
    'Return JSON with key "entries".',
    'Each entry must target a distinct user intent or task cluster.',
    'Each entry content must explain when to use the imported ACN tool wrapper, which method(s) to call, key parameter rules, and practical usage notes.',
    'Examples must be diverse natural-language user requests that should retrieve that entry.',
    'Use the normalized ACN method names, not raw MCP method names, inside the content.',
    'Do not repeat the same examples across entries.',
    '',
    JSON.stringify({
      displayName: draft.displayName,
      namespace: draft.namespace,
      knowledgeMode: draft.knowledgeMode,
      methods: draft.methods.map((method) => ({
        methodName: method.methodName,
        originalName: method.originalName,
        description: method.description,
        parameters: method.parameters.map((parameter) => ({
          name: parameter.name,
          required: parameter.required,
          description: parameter.description,
          schema: parameter.schema,
        })),
      })),
    }, null, 2),
    '',
    ...extraSources.map((source) => `## ${source.kind}:${source.name}\n${clampText(source.content, 8000)}`),
  ].join('\n');

  try {
    const payload = await withTimeout(
      callGemini(prompt),
      options.timeoutMs || IMPORTED_TOOLS_GEMINI_TIMEOUT_MS,
      'Imported skills generation'
    );
    return {
      entries: payload.entries,
      generatedWith: IMPORTED_TOOLS_DEFAULT_GEMINI_MODEL,
      sourceSummary: 'Generated from MCP tool descriptions and schemas.',
    };
  } catch (error) {
    console.warn('[imported-tools] Falling back to deterministic skill generation:', error);
    return buildFallbackSkills(draft);
  }
}
