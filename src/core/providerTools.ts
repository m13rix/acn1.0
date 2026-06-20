import type { ProviderToolRequest } from '../types/index.js';

export function buildProviderToolRequest(_requireFinish = true): ProviderToolRequest {
  const tools: ProviderToolRequest['tools'] = [
    {
      type: 'function',
      function: {
        name: 'action',
        description: 'Execute TypeScript code in the sandbox. All tools are available as injected TypeScript packages inside action: terminal, files, code, and configured agent tools. Use TASK_DONE("message") inside action when finished.',
        parameters: {
          type: 'object',
          properties: {
            content: { type: 'string', description: 'TypeScript code to execute' },
          },
          required: ['content'],
        },
      },
    },
  ];

  return {
    tools,
    toolChoice: 'auto',
  };
}
