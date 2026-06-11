import { createProvider } from '../../providers/factory.js';
import type { Message } from '../../types/index.js';

export interface ModelRepairInput {
  code: string;
  errorText: string;
  provider: string;
  model: string;
  temperature: number;
  maxTokens: number;
  toolDocs?: string;
}

export interface ModelRepairResult {
  repairedCode?: string;
  note: string;
}

const MAX_CODE_CHARS = 14000;
const MAX_ERROR_CHARS = 10000;

export async function repairCodeWithModel(input: ModelRepairInput): Promise<ModelRepairResult> {
  try {
    const provider = createProvider(input.provider);
    const systemMessage = [
      'You fix broken TypeScript sandbox snippets.',
      'Return ONLY valid TypeScript code.',
      'Do not add explanations, markdown, or comments unless they already exist in code.',
      'Keep edits minimal and preserve intent.',
    ].join(' ');

    const parts: string[] = [
      'Fix this TypeScript code so it executes successfully in Node.js/tsx.',
      'Return code only.',
      '',
    ];

    if (input.toolDocs) {
      parts.push('AVAILABLE TOOLS (name -> return type / shape):');
      parts.push(truncate(input.toolDocs, MAX_CODE_CHARS));
      parts.push('');
    }

    parts.push('ERROR:', truncate(input.errorText, MAX_ERROR_CHARS));
    parts.push('', 'CODE:', truncate(input.code, MAX_CODE_CHARS));

    const userMessage = parts.join('\n');

    const messages: Message[] = [
      { role: 'system', content: systemMessage },
      { role: 'user', content: userMessage },
    ];

    const response = await provider.complete(messages, {
      model: input.model,
      temperature: input.temperature,
      maxTokens: input.maxTokens,
      stream: false,
      reasoning: 'low',
    });

    const repaired = sanitizeModelCodeResponse(response.content || '');
    if (!repaired.trim()) {
      return {
        note: 'model repair returned empty output',
      };
    }

    return {
      repairedCode: repaired,
      note: `model repair generated updated code (${input.provider}/${input.model})`,
    };
  } catch (error: any) {
    return {
      note: `model repair skipped: ${error?.message || String(error)}`,
    };
  }
}

export function sanitizeModelCodeResponse(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';

  const fenced = trimmed.match(/```(?:typescript|ts|javascript|js)?\s*\n([\s\S]*?)\n```/i);
  if (fenced?.[1]) {
    return fenced[1].trim();
  }

  if (trimmed.startsWith('```')) {
    return trimmed
      .replace(/^```(?:typescript|ts|javascript|js)?\s*\n?/i, '')
      .replace(/\n?```$/i, '')
      .trim();
  }

  return trimmed;
}

function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}\n...[truncated]`;
}
