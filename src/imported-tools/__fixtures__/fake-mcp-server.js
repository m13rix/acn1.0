import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import * as z from 'zod/v4';

const server = new McpServer({
  name: 'sdamgia-demo',
  version: '1.0.0',
});

server.registerTool('sdamgia_get_problem', {
  description: 'Retrieve a specific problem by ID.',
  inputSchema: {
    subject: z.string().describe('Subject code'),
    problem_id: z.string().describe('Problem ID'),
    response_format: z.enum(['json', 'markdown']).optional(),
  },
  outputSchema: {
    subject: z.string(),
    problem_id: z.string(),
    response_format: z.string(),
    statement: z.string(),
  },
  annotations: {
    readOnlyHint: true,
    idempotentHint: true,
  },
}, async ({ subject, problem_id, response_format = 'markdown' }) => {
  const structuredContent = {
    subject,
    problem_id,
    response_format,
    statement: `${subject}:${problem_id}:${response_format}`,
  };
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(structuredContent),
      },
    ],
    structuredContent,
  };
});

const transport = new StdioServerTransport();
await server.connect(transport);
