import type { ProviderToolRequest } from '../types/index.js';
import { PRIMARY_COMPLETION_FUNCTION } from './completion.js';

export function buildProviderToolRequest(): ProviderToolRequest {
  return {
    tools: [
      {
        type: 'function',
        function: {
          name: 'action',
          description: 'Execute TypeScript code in sandbox. Use a single "content" string argument.',
          parameters: {
            type: 'object',
            properties: {
              content: { type: 'string', description: 'TypeScript code to execute' },
            },
            required: ['content'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'cli',
          description: 'Execute shell command in sandbox. Use a single "content" string argument.',
          parameters: {
            type: 'object',
            properties: {
              content: { type: 'string', description: 'Shell command to execute' },
            },
            required: ['content'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'file',
          description: 'Create/update/edit a single file by filename. Use "filename" and "content".',
          parameters: {
            type: 'object',
            properties: {
              filename: { type: 'string', description: 'Target file path, e.g. ./src/app.ts' },
              content: {
                type: 'string',
                description: 'Either full file content or SEARCH/REPLACE edit payload for the specified filename',
              },
            },
            required: ['filename', 'content'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: PRIMARY_COMPLETION_FUNCTION,
          description: 'Finish the task only when everything is truly complete. Use a single "message" string argument.',
          parameters: {
            type: 'object',
            properties: {
              message: { type: 'string', description: 'Final user-facing completion message.' },
            },
            required: ['message'],
          },
        },
      },
    ],
    toolChoice: 'auto',
  };
}
