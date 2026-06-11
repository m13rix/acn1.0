import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3Content,
  LanguageModelV3FinishReason,
  LanguageModelV3FunctionTool,
  LanguageModelV3GenerateResult,
  LanguageModelV3Prompt,
  LanguageModelV3StreamPart,
  LanguageModelV3StreamResult,
  LanguageModelV3ToolChoice,
  LanguageModelV3Usage,
} from '@ai-sdk/provider';
import type {
  Message,
  ProviderConfig,
  ProviderStreamEvent,
  ProviderToolRequest,
} from '../types/index.js';
import { OpenAICodexProvider } from '../providers/openai-codex/index.js';

function emptyUsage(): LanguageModelV3Usage {
  return {
    inputTokens: { total: undefined, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: undefined, text: undefined, reasoning: undefined },
  };
}

function finishReason(unified: LanguageModelV3FinishReason['unified'], raw?: string): LanguageModelV3FinishReason {
  return { unified, raw };
}

function outputToText(output: unknown): string {
  if (!output || typeof output !== 'object') return String(output ?? '');
  const item = output as Record<string, unknown>;
  if (item['type'] === 'text') return String(item['value'] ?? '');
  if (item['type'] === 'json') return JSON.stringify(item['value'] ?? {});
  if (item['type'] === 'error-text') return `Error: ${String(item['value'] ?? '')}`;
  if (item['type'] === 'error-json') return `Error: ${JSON.stringify(item['value'] ?? {})}`;
  return JSON.stringify(output);
}

function dataToBase64(data: unknown): string {
  if (typeof data === 'string') {
    const commaIndex = data.indexOf(',');
    if (data.startsWith('data:') && commaIndex >= 0) {
      return data.slice(commaIndex + 1);
    }
    return data;
  }
  if (data instanceof Uint8Array) return Buffer.from(data).toString('base64');
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('base64');
  return String(data ?? '');
}

function promptToMessages(prompt: LanguageModelV3Prompt): Message[] {
  const messages: Message[] = [];

  for (const message of prompt) {
    if (message.role === 'system') {
      messages.push({ role: 'system', content: message.content });
      continue;
    }

    if (message.role === 'user') {
      const textParts: string[] = [];
      for (const part of message.content) {
        if (part.type === 'text') {
          textParts.push(part.text);
        } else if (part.type === 'file') {
          messages.push({
            role: 'file',
            filename: part.filename,
            content: dataToBase64(part.data),
          });
        }
      }
      if (textParts.length > 0 || message.content.length === 0) {
        messages.push({ role: 'user', content: textParts.join('') });
      }
      continue;
    }

    if (message.role === 'assistant') {
      const textParts: string[] = [];
      const reasoningParts: string[] = [];
      const toolCalls = [];
      for (const part of message.content) {
        if (part.type === 'text') textParts.push(part.text);
        if (part.type === 'reasoning') reasoningParts.push(part.text);
        if (part.type === 'tool-call') {
          toolCalls.push({
            id: part.toolCallId,
            name: part.toolName,
            arguments: part.input && typeof part.input === 'object' ? part.input as Record<string, unknown> : {},
          });
        }
      }
      messages.push({
        role: 'assistant',
        content: textParts.join(''),
        reasoning: reasoningParts.join('\n'),
        toolCalls,
      });
      continue;
    }

    if (message.role === 'tool') {
      for (const part of message.content) {
        if (part.type !== 'tool-result') continue;
        messages.push({
          role: 'tool',
          toolCallId: part.toolCallId,
          toolName: part.toolName,
          content: outputToText(part.output),
        });
      }
    }
  }

  return messages;
}

function toolsToProviderRequest(options: LanguageModelV3CallOptions): ProviderToolRequest | undefined {
  const functionTools = (options.tools || []).filter((tool): tool is LanguageModelV3FunctionTool => tool.type === 'function');
  if (functionTools.length === 0) return undefined;

  return {
    tools: functionTools.map(tool => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema as Record<string, unknown>,
        strict: tool.strict,
      },
    })),
    toolChoice: mapToolChoice(options.toolChoice),
  };
}

function mapToolChoice(choice: LanguageModelV3ToolChoice | undefined): ProviderToolRequest['toolChoice'] {
  if (!choice || choice.type === 'auto' || choice.type === 'required') return 'auto';
  if (choice.type === 'none') return 'none';
  return { type: 'function', function: { name: choice.toolName } };
}

function providerConfig(modelId: string, options: LanguageModelV3CallOptions): ProviderConfig {
  return {
    model: modelId,
    maxTokens: options.maxOutputTokens,
    temperature: options.temperature,
    top_p: options.topP,
    top_k: options.topK,
    seed: options.seed,
    frequency_penalty: options.frequencyPenalty,
    presence_penalty: options.presencePenalty,
    stopSequences: options.stopSequences,
    providerOptions: options.providerOptions as Record<string, unknown> | undefined,
    stream: false,
  };
}

function mapProviderEventToV3(
  event: ProviderStreamEvent,
  state: { textStarted: boolean; reasoningStarted: boolean; openToolInputs: Set<string> }
): LanguageModelV3StreamPart[] {
  const out: LanguageModelV3StreamPart[] = [];

  if (event.type === 'text.delta' && event.delta) {
    if (!state.textStarted) {
      state.textStarted = true;
      out.push({ type: 'text-start', id: 'text' });
    }
    out.push({ type: 'text-delta', id: 'text', delta: event.delta });
  } else if (event.type === 'reasoning.delta' && event.delta) {
    if (!state.reasoningStarted) {
      state.reasoningStarted = true;
      out.push({ type: 'reasoning-start', id: 'reasoning' });
    }
    out.push({ type: 'reasoning-delta', id: 'reasoning', delta: event.delta });
  } else if (event.type === 'reasoning.done') {
    if (state.reasoningStarted) {
      out.push({ type: 'reasoning-end', id: 'reasoning' });
      state.reasoningStarted = false;
    }
  } else if (event.type === 'tool_call.delta' && event.toolCallId) {
    if (!state.openToolInputs.has(event.toolCallId)) {
      state.openToolInputs.add(event.toolCallId);
      out.push({ type: 'tool-input-start', id: event.toolCallId, toolName: event.toolName || 'unknown' });
    }
    out.push({ type: 'tool-input-delta', id: event.toolCallId, delta: event.delta || '' });
  } else if (event.type === 'tool_call.done' && event.toolCall) {
    if (state.openToolInputs.has(event.toolCall.id)) {
      out.push({ type: 'tool-input-end', id: event.toolCall.id });
      state.openToolInputs.delete(event.toolCall.id);
    }
    out.push({
      type: 'tool-call',
      toolCallId: event.toolCall.id,
      toolName: event.toolCall.name,
      input: JSON.stringify(event.toolCall.arguments || {}),
    });
  } else if (event.type === 'text.done') {
    if (state.textStarted) {
      out.push({ type: 'text-end', id: 'text' });
      state.textStarted = false;
    }
  } else if (event.type === 'done') {
    if (state.reasoningStarted) out.push({ type: 'reasoning-end', id: 'reasoning' });
    if (state.textStarted) out.push({ type: 'text-end', id: 'text' });
    for (const id of state.openToolInputs) out.push({ type: 'tool-input-end', id });
    out.push({ type: 'finish', usage: emptyUsage(), finishReason: finishReason('stop', 'completed') });
  }

  return out;
}

function contentFromProviderEvents(events: ProviderStreamEvent[]): LanguageModelV3Content[] {
  let text = '';
  let reasoning = '';
  const content: LanguageModelV3Content[] = [];

  for (const event of events) {
    if (event.type === 'text.delta') text += event.delta || '';
    if (event.type === 'reasoning.delta') reasoning += event.delta || '';
    if (event.type === 'tool_call.done' && event.toolCall) {
      content.push({
        type: 'tool-call',
        toolCallId: event.toolCall.id,
        toolName: event.toolCall.name,
        input: JSON.stringify(event.toolCall.arguments || {}),
      });
    }
  }

  if (reasoning) content.unshift({ type: 'reasoning', text: reasoning });
  if (text) content.unshift({ type: 'text', text });
  return content;
}

export function createOpenAICodexLanguageModel(modelId: string): LanguageModelV3 {
  const provider = new OpenAICodexProvider();

  return {
    specificationVersion: 'v3',
    provider: 'openai-codex',
    modelId,
    supportedUrls: {},

    async doGenerate(options: LanguageModelV3CallOptions): Promise<LanguageModelV3GenerateResult> {
      const messages = promptToMessages(options.prompt);
      const toolRequest = toolsToProviderRequest(options);
      const config = providerConfig(modelId, options);
      const response = toolRequest
        ? await provider.completeWithTools(messages, config, toolRequest)
        : await provider.complete(messages, config);

      const content: LanguageModelV3Content[] = [];
      if (response.content) content.push({ type: 'text', text: response.content });
      if (response.reasoning) content.push({ type: 'reasoning', text: response.reasoning });
      for (const toolCall of response.toolCalls || []) {
        content.push({
          type: 'tool-call',
          toolCallId: toolCall.id,
          toolName: toolCall.name,
          input: JSON.stringify(toolCall.arguments || {}),
        });
      }

      return {
        content,
        finishReason: finishReason(response.toolCalls?.length ? 'tool-calls' : 'stop', response.finishReason),
        usage: response.usage
          ? {
              inputTokens: {
                total: response.usage.promptTokens,
                noCache: response.usage.cachedPromptTokens !== undefined
                  ? Math.max(0, response.usage.promptTokens - response.usage.cachedPromptTokens)
                  : undefined,
                cacheRead: response.usage.cachedPromptTokens,
                cacheWrite: response.usage.cacheWriteTokens,
              },
              outputTokens: {
                total: response.usage.completionTokens,
                text: response.usage.completionTokens,
                reasoning: response.usage.reasoningTokens,
              },
              raw: response.usage as any,
            }
          : emptyUsage(),
        warnings: [],
      };
    },

    async doStream(options: LanguageModelV3CallOptions): Promise<LanguageModelV3StreamResult> {
      const messages = promptToMessages(options.prompt);
      const toolRequest = toolsToProviderRequest(options);
      const config = { ...providerConfig(modelId, options), stream: true };

      const stream = new ReadableStream<LanguageModelV3StreamPart>({
        async start(controller) {
          controller.enqueue({ type: 'stream-start', warnings: [] });
          const state = { textStarted: false, reasoningStarted: false, openToolInputs: new Set<string>() };
          const events: ProviderStreamEvent[] = [];
          try {
            const source = toolRequest
              ? provider.streamEventsWithTools(messages, config, toolRequest)
              : provider.streamEvents(messages, config);
            for await (const event of source) {
              events.push(event);
              for (const part of mapProviderEventToV3(event, state)) {
                controller.enqueue(part);
              }
            }
            if (!events.some(event => event.type === 'done')) {
              const content = contentFromProviderEvents(events);
              const hasToolCall = content.some(part => part.type === 'tool-call');
              controller.enqueue({
                type: 'finish',
                usage: emptyUsage(),
                finishReason: finishReason(hasToolCall ? 'tool-calls' : 'stop'),
              });
            }
            controller.close();
          } catch (error) {
            controller.enqueue({ type: 'error', error });
            controller.close();
          }
        },
      });

      return { stream };
    },
  };
}
