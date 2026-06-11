import type { AssistantModelMessage, ModelMessage, ToolModelMessage } from 'ai';
import { jsonSchema } from 'ai';
import type {
  Message,
  ProviderToolCall,
  ProviderToolRequest,
  ProviderToolResponse,
} from '../types/index.js';
// @ts-ignore - mime-types doesn't have perfect TypeScript types
import { lookup } from 'mime-types';

export function splitSystemMessages(messages: Message[]): { system: string; messages: Message[] } {
  const systemMessages = messages.filter(message => message.role === 'system').map(message => message.content.trim()).filter(Boolean);
  return {
    system: systemMessages.join('\n\n'),
    messages: messages.filter(message => message.role !== 'system'),
  };
}

function normalizeBase64(content: string): string {
  return String(content || '').replace(/\s+/g, '');
}

function isTextLikeFile(filename: string, mimeType: string): boolean {
  return (
    mimeType.startsWith('text/')
    || mimeType === 'application/javascript'
    || mimeType === 'application/json'
    || mimeType === 'application/x-typescript'
    || filename.endsWith('.ts')
    || filename.endsWith('.tsx')
    || filename.endsWith('.js')
    || filename.endsWith('.jsx')
    || filename.endsWith('.html')
    || filename.endsWith('.css')
    || filename.endsWith('.md')
  );
}

function tryDecodeBase64Text(content: string): string | null {
  const normalized = normalizeBase64(content);
  if (!normalized || /\s/.test(content)) return null;
  try {
    const decoded = Buffer.from(normalized, 'base64');
    if (decoded.length === 0) return null;
    const reencoded = decoded.toString('base64').replace(/=+$/, '');
    if (reencoded !== normalized.replace(/=+$/, '')) return null;
    return decoded.toString('utf8');
  } catch {
    return null;
  }
}

function fileMessageToUserContent(message: Message): ModelMessage {
  const filename = message.filename || 'file';
  const mimeType = String(lookup(filename) || 'application/octet-stream');
  if (isTextLikeFile(filename, mimeType)) {
    const decoded = tryDecodeBase64Text(message.content);
    return {
      role: 'user',
      content: [{ type: 'text', text: `<obs>\n${filename}:\n${decoded ?? message.content}\n</obs>` }],
    };
  }

  return {
    role: 'user',
    content: [{
      type: 'file',
      filename,
      mediaType: mimeType,
      data: normalizeBase64(message.content) || message.content,
    }],
  };
}

export function telosMessagesToModelMessages(messages: Message[]): ModelMessage[] {
  const out: ModelMessage[] = [];

  for (const message of messages) {
    if (message.role === 'system') {
      out.push({ role: 'system', content: message.content });
      continue;
    }

    if (message.role === 'file') {
      out.push(fileMessageToUserContent(message));
      continue;
    }

    if (message.role === 'tool') {
      out.push({
        role: 'tool',
        content: [{
          type: 'tool-result',
          toolCallId: message.toolCallId || 'tool_call',
          toolName: message.toolName || 'unknown',
          output: { type: 'text', value: message.content },
        }],
      } as ModelMessage);
      continue;
    }

    if (message.role === 'assistant') {
      const content: any[] = [];
      if (message.content?.trim()) {
        content.push({ type: 'text', text: message.content });
      }
      for (const toolCall of message.toolCalls || []) {
        content.push({
          type: 'tool-call',
          toolCallId: toolCall.id,
          toolName: toolCall.name,
          input: toolCall.arguments,
        });
      }
      out.push({ role: 'assistant', content } as ModelMessage);
      continue;
    }

    out.push({ role: 'user', content: message.content });
  }

  return out;
}

function contentPartText(part: unknown): string {
  if (!part || typeof part !== 'object') return '';
  const item = part as Record<string, unknown>;
  if (item['type'] === 'text' && typeof item['text'] === 'string') return item['text'];
  if (item['type'] === 'reasoning' && typeof item['text'] === 'string') return '';
  return '';
}

function contentPartReasoning(part: unknown): string {
  if (!part || typeof part !== 'object') return '';
  const item = part as Record<string, unknown>;
  const type = String(item['type'] ?? '');
  if (!type.includes('reasoning')) return '';
  if (typeof item['text'] === 'string') return item['text'];
  if (typeof item['summary'] === 'string') return item['summary'];
  return '';
}

function outputToText(output: unknown): string {
  if (!output || typeof output !== 'object') {
    return String(output ?? '');
  }
  const item = output as Record<string, unknown>;
  if (item['type'] === 'text') return String(item['value'] ?? '');
  if (item['type'] === 'json') return JSON.stringify(item['value'] ?? {});
  if (item['type'] === 'error-text') return `Error: ${String(item['value'] ?? '')}`;
  if (item['type'] === 'error-json') return `Error: ${JSON.stringify(item['value'] ?? {})}`;
  return JSON.stringify(output);
}

export function modelResponseMessagesToTelos(messages: ModelMessage[]): Message[] {
  const out: Message[] = [];
  for (const message of messages) {
    if (message.role === 'assistant') {
      const assistant = message as AssistantModelMessage;
      const contentParts = Array.isArray(assistant.content) ? assistant.content : [{ type: 'text', text: String(assistant.content || '') }];
      const text = contentParts.map(contentPartText).filter(Boolean).join('');
      const reasoning = contentParts.map(contentPartReasoning).filter(Boolean).join('\n');
      const toolCalls: ProviderToolCall[] = contentParts
        .filter(part => part && typeof part === 'object' && (part as any).type === 'tool-call')
        .map((part: any) => ({
          id: String(part.toolCallId || part.id || `tool_${Math.random().toString(36).slice(2, 8)}`),
          name: String(part.toolName || 'unknown'),
          arguments: part.input && typeof part.input === 'object' ? part.input : {},
        }));
      out.push({ role: 'assistant', content: text, reasoning, toolCalls });
    } else if (message.role === 'tool') {
      const toolMessage = message as ToolModelMessage;
      for (const part of toolMessage.content || []) {
        if ((part as any).type !== 'tool-result') continue;
        out.push({
          role: 'tool',
          content: outputToText((part as any).output),
          toolCallId: String((part as any).toolCallId || ''),
          toolName: String((part as any).toolName || ''),
        });
      }
    }
  }
  return out;
}

export function providerToolRequestToAiSdkTools(toolRequest: ProviderToolRequest): Record<string, any> {
  const tools: Record<string, any> = {};
  for (const definition of toolRequest.tools) {
    tools[definition.function.name] = {
      description: definition.function.description,
      inputSchema: jsonSchema((definition.function.parameters || { type: 'object', properties: {} }) as any),
    };
  }
  return tools;
}

export function toolCallsFromAiSdkParts(parts: Array<any>): ProviderToolCall[] {
  return parts
    .filter(part => part?.type === 'tool-call')
    .map((part, index) => ({
      id: String(part.toolCallId || `tool_${index}`),
      name: String(part.toolName || 'unknown'),
      arguments: part.input && typeof part.input === 'object' ? part.input : {},
    }));
}

export function usageFromAiSdk(usage: any): ProviderToolResponse['usage'] {
  if (!usage) return undefined;
  const promptTokens = Number(usage.inputTokens?.total ?? usage.promptTokens ?? 0);
  const completionTokens = Number(usage.outputTokens?.total ?? usage.completionTokens ?? 0);
  return {
    promptTokens,
    completionTokens,
    totalTokens: Number(usage.totalTokens ?? promptTokens + completionTokens),
    cachedPromptTokens: Number(usage.inputTokens?.cacheRead ?? usage.raw?.input_tokens_details?.cached_tokens ?? 0),
    cacheWriteTokens: Number(usage.inputTokens?.cacheWrite ?? usage.raw?.input_tokens_details?.cache_write_tokens ?? 0),
    reasoningTokens: Number(usage.outputTokens?.reasoning ?? usage.raw?.output_tokens_details?.reasoning_tokens ?? 0),
    raw: usage.raw ?? usage,
  };
}
