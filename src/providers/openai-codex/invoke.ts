import type {
  Message,
  ProviderConfig,
  ProviderStreamEvent,
  ProviderToolCall,
  ProviderToolRequest,
  ProviderToolResponse,
} from '../../types/index.js';
// @ts-ignore - mime-types doesn't have perfect TypeScript types
import { lookup } from 'mime-types';

export interface CodexStreamAccumulator {
  toolCalls: Map<string, { name: string; argumentsRaw: string }>;
  reasoningDone: boolean;
  textDone: boolean;
}

export function createCodexStreamAccumulator(): CodexStreamAccumulator {
  return {
    toolCalls: new Map(),
    reasoningDone: false,
    textDone: false,
  };
}

export function buildCodexRequest(
  messages: Message[],
  config: ProviderConfig,
  toolRequest?: ProviderToolRequest
): Record<string, unknown> {
  const systemMessage = messages.find(message => message.role === 'system')?.content || '';
  const input = messages
    .filter(message => message.role !== 'system')
    .flatMap(message => mapMessageToCodexInput(message));
  const reasoning = mapReasoning(config.reasoning);

  const request: Record<string, unknown> = {
    model: stripModelPrefix(config.model),
    input,
    instructions: systemMessage,
    tools: toolRequest?.tools ? mapTools(toolRequest) : [],
    tool_choice: mapToolChoice(toolRequest?.toolChoice),
    parallel_tool_calls: true,
    reasoning,
    store: false,
    stream: config.stream ?? false,
    include: reasoning ? ['reasoning.encrypted_content'] : [],
  };

  Object.keys(request).forEach((key) => {
    if (request[key] === undefined) {
      delete request[key];
    }
  });

  return request;
}

export function parseCodexResponse(response: any): ProviderToolResponse {
  const outputItems = Array.isArray(response?.output) ? response.output : [];
  let content = '';
  let reasoning = '';
  const toolCalls: ProviderToolCall[] = [];

  for (const item of outputItems) {
    if (!item || typeof item !== 'object') continue;

    if (item.type === 'message') {
      const contents = Array.isArray(item.content) ? item.content : [];
      for (const part of contents) {
        if (!part || typeof part !== 'object') continue;
        if (part.type === 'output_text' || part.type === 'text') {
          content += String(part.text ?? '');
        } else if (String(part.type).includes('reasoning')) {
          reasoning += String(part.text ?? part.summary ?? '');
        }
      }
    } else if (item.type === 'reasoning' || String(item.type).includes('reasoning')) {
      const summaries = Array.isArray(item.summary) ? item.summary : [];
      for (const summary of summaries) {
        if (summary && typeof summary === 'object') {
          reasoning += String((summary as any).text ?? '');
        }
      }
      reasoning += String(item.text ?? '');
    } else if (item.type === 'function_call') {
      toolCalls.push({
        id: String(item.call_id ?? item.id ?? `tool_${toolCalls.length}`),
        name: String(item.name ?? 'unknown'),
        arguments: parseArguments(item.arguments),
      });
    }
  }

  if (!content && typeof response?.output_text === 'string') {
    content = response.output_text;
  }

  return {
    content,
    reasoning,
    finishReason: mapFinishReason(response?.status),
    toolCalls,
    usage: response?.usage
      ? {
          promptTokens: Number(response.usage.input_tokens ?? 0),
          completionTokens: Number(response.usage.output_tokens ?? 0),
          totalTokens: Number(response.usage.total_tokens ?? 0),
        }
      : undefined,
  };
}

export function mapCodexSseEvent(
  eventName: string,
  payload: any,
  state: CodexStreamAccumulator
): ProviderStreamEvent[] {
  const out: ProviderStreamEvent[] = [];

  if (eventName === 'response.output_text.delta' || eventName === 'response.content_part.added') {
    const delta = extractString(payload, ['delta', 'text']) || extractString(payload?.part, ['text']);
    if (delta) {
      out.push({ type: 'text.delta', delta });
    }
    return out;
  }

  if (eventName === 'response.output_text.done') {
    if (!state.textDone) {
      state.textDone = true;
      out.push({ type: 'text.done' });
    }
    return out;
  }

  if (eventName.includes('reasoning') && eventName.endsWith('.delta')) {
    const delta = extractString(payload, ['delta', 'text', 'summary']) || extractString(payload?.part, ['text']);
    if (delta) {
      out.push({ type: 'reasoning.delta', delta });
    }
    return out;
  }

  if ((eventName.includes('reasoning') && eventName.endsWith('.done')) || eventName === 'response.reasoning.done') {
    if (!state.reasoningDone) {
      state.reasoningDone = true;
      out.push({ type: 'reasoning.done' });
    }
    return out;
  }

  if (eventName === 'response.function_call_arguments.delta') {
    const callId = String(payload?.item_id ?? payload?.call_id ?? payload?.id ?? 'tool_call');
    const entry = state.toolCalls.get(callId) || {
      name: String(payload?.name ?? 'unknown'),
      argumentsRaw: '',
    };
    entry.name = String(payload?.name ?? entry.name ?? 'unknown');
    entry.argumentsRaw += String(payload?.delta ?? '');
    state.toolCalls.set(callId, entry);
    if (payload?.delta) {
      out.push({
        type: 'tool_call.delta',
        toolCallId: callId,
        toolName: entry.name,
        delta: String(payload.delta),
      });
    }
    return out;
  }

  if (eventName === 'response.output_item.done') {
    const item = payload?.item;
    if (item?.type === 'function_call') {
      const callId = String(item.call_id ?? item.id ?? 'tool_call');
      const stateEntry = state.toolCalls.get(callId);
      const rawArgs = String(item.arguments ?? stateEntry?.argumentsRaw ?? '');
      out.push({
        type: 'tool_call.done',
        toolCallId: callId,
        toolName: String(item.name ?? stateEntry?.name ?? 'unknown'),
        toolCall: {
          id: callId,
          name: String(item.name ?? stateEntry?.name ?? 'unknown'),
          arguments: parseArguments(rawArgs),
        },
      });
      return out;
    }
    return out;
  }

  if (eventName === 'response.completed') {
    if (!state.textDone) {
      state.textDone = true;
      out.push({ type: 'text.done' });
    }
    out.push({ type: 'done' });
    return out;
  }

  return out;
}

function mapMessageToCodexInput(message: Message): Array<Record<string, unknown>> {
  if (message.role === 'tool') {
    return [{
      type: 'function_call_output',
      call_id: message.toolCallId,
      output: message.content,
    }];
  }

  if (message.role === 'assistant' && Array.isArray(message.toolCalls) && message.toolCalls.length > 0) {
    const items: Array<Record<string, unknown>> = [];

    if (message.content?.trim()) {
      items.push({
        role: 'assistant',
        content: [{ type: 'output_text', text: message.content }],
      });
    }

    // Tool calls are standalone response items in history, not content parts.
    items.push(...message.toolCalls.map(toolCall => ({
      type: 'function_call',
      call_id: toolCall.id,
      name: toolCall.name,
      arguments: JSON.stringify(toolCall.arguments ?? {}),
    })));

    return items;
  }

  if (message.role === 'file') {
    return [mapFileMessageToCodexInput(message)];
  }

  return [{
    role: message.role,
    content: [
      {
        type: message.role === 'assistant' ? 'output_text' : 'input_text',
        text: message.content,
      },
    ],
  }];
}

function formatFileMessage(filename: string, content: string): string {
  return `<obs>\n${filename}:\n${content}\n</obs>`;
}

function mapFileMessageToCodexInput(message: Message): Record<string, unknown> {
  const filename = message.filename || 'file';
  const content = buildFileMessageContent(filename, message.content);
  return {
    role: 'user',
    content,
  };
}

function buildFileMessageContent(filename: string, rawContent: string): Array<Record<string, unknown>> {
  const mimeType = lookup(filename) || 'application/octet-stream';
  const normalizedMimeType = String(mimeType);

  if (normalizedMimeType.startsWith('image/')) {
    const normalizedBase64 = normalizeBase64(rawContent);
    if (normalizedBase64) {
      return [{
        type: 'input_image',
        image_url: `data:${normalizedMimeType};base64,${normalizedBase64}`,
      }];
    }
  }

  if (isTextLikeFile(filename, normalizedMimeType)) {
    const decoded = decodeBase64Text(rawContent);
    return [{
      type: 'input_text',
      text: formatFileMessage(filename, decoded ?? rawContent),
    }];
  }

  const normalizedBase64 = normalizeBase64(rawContent);
  if (normalizedBase64) {
    return [{
      type: 'input_file',
      filename,
      file_data: normalizedBase64,
    }];
  }

  return [{
    type: 'input_text',
    text: formatFileMessage(filename, rawContent),
  }];
}

function isTextLikeFile(filename: string, mimeType: string): boolean {
  return (
    mimeType.startsWith('text/') ||
    mimeType === 'application/javascript' ||
    mimeType === 'application/json' ||
    mimeType === 'application/x-typescript' ||
    filename.endsWith('.ts') ||
    filename.endsWith('.tsx') ||
    filename.endsWith('.js') ||
    filename.endsWith('.jsx') ||
    filename.endsWith('.html') ||
    filename.endsWith('.css') ||
    filename.endsWith('.md')
  );
}

function normalizeBase64(content: string): string | null {
  const normalized = String(content || '').replace(/\s+/g, '');
  if (!normalized || normalized.length % 4 !== 0) {
    return null;
  }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(normalized)) {
    return null;
  }

  try {
    const decoded = Buffer.from(normalized, 'base64');
    if (decoded.length === 0 && normalized.length > 0) {
      return null;
    }

    const reencoded = decoded.toString('base64').replace(/=+$/, '');
    const original = normalized.replace(/=+$/, '');
    return reencoded === original ? normalized : null;
  } catch {
    return null;
  }
}

function decodeBase64Text(content: string): string | null {
  if (/\s/.test(content)) {
    return null;
  }

  const normalized = normalizeBase64(content);
  if (!normalized) {
    return null;
  }

  try {
    return Buffer.from(normalized, 'base64').toString('utf-8');
  } catch {
    return null;
  }
}

function mapReasoning(reasoning: ProviderConfig['reasoning']): { effort: 'low' | 'medium' | 'high' } | undefined {
  switch (reasoning) {
    case 'low':
    case 'off':
      return { effort: 'low' };
    case 'high':
      return { effort: 'high' };
    case 'medium':
    default:
      return { effort: 'medium' };
  }
}

function mapTools(toolRequest: ProviderToolRequest): Array<Record<string, unknown>> {
  return toolRequest.tools.map((tool) => ({
    type: tool.type,
    name: tool.function.name,
    description: tool.function.description,
    parameters: tool.function.parameters,
    strict: tool.function.strict,
  }));
}

function mapToolChoice(choice: ProviderToolRequest['toolChoice']): string {
  if (choice === 'none') return 'none';
  // Codex reference client uses string tool_choice and defaults to auto.
  return 'auto';
}

function parseArguments(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  if (typeof raw !== 'string' || !raw.trim()) {
    return {};
  }
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return { value: parsed };
  } catch {
    return { content: raw };
  }
}

function extractString(payload: any, keys: string[]): string {
  for (const key of keys) {
    const value = payload?.[key];
    if (typeof value === 'string' && value) {
      return value;
    }
  }
  return '';
}

function stripModelPrefix(model: string): string {
  return model.startsWith('openai-codex/') ? model.slice('openai-codex/'.length) : model;
}

function mapFinishReason(status: unknown): ProviderToolResponse['finishReason'] {
  const normalized = String(status ?? '').toLowerCase();
  if (normalized === 'completed') return 'stop';
  if (normalized === 'max_output_tokens' || normalized === 'incomplete') return 'length';
  if (normalized === 'content_filter') return 'content_filter';
  return 'other';
}
