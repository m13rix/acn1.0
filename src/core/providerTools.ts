import type { ProviderToolRequest } from '../types/index.js';
import { PRIMARY_COMPLETION_FUNCTION } from './completion.js';

export interface ProviderToolRequestOptions {
  includeCompletionTool?: boolean;
  strict?: boolean;
}

export function buildProviderToolRequest(
  _requireFinish = true,
  options: ProviderToolRequestOptions = {}
): ProviderToolRequest {
  const strict = options.strict === true;
  const tools: ProviderToolRequest['tools'] = [
    {
      type: 'function',
      function: {
        name: 'action',
        description: options.includeCompletionTool
          ? 'Execute TypeScript/JavaScript code in the sandbox. All tools are available as injected TypeScript packages inside action: terminal, files, code, and configured agent tools. Do not call TASK_DONE inside action when the native TASK_DONE tool is available; use the native TASK_DONE provider tool after the work is complete.'
          : 'Execute TypeScript code in the sandbox. All tools are available as injected TypeScript packages inside action: terminal, files, code, and configured agent tools. Use TASK_DONE("message") inside action when finished.',
        parameters: {
          type: 'object',
          properties: {
            content: { type: 'string', description: 'TypeScript code to execute' },
          },
          required: ['content'],
          additionalProperties: false,
        },
        strict,
      },
    },
  ];

  if (options.includeCompletionTool) {
    tools.push({
      type: 'function',
      function: {
        name: PRIMARY_COMPLETION_FUNCTION,
        description: 'Finish the task with the final user-facing message. Call this only after the requested work is complete and any needed verification has run.',
        parameters: {
          type: 'object',
          properties: {
            message: { type: 'string', description: 'Final user-facing completion message' },
          },
          required: ['message'],
          additionalProperties: false,
        },
        strict,
      },
    });
  }

  return {
    tools,
    toolChoice: 'auto',
  };
}
