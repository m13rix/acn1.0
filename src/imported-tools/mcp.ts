import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type {
  ImportedDiscoveredTool,
  ImportedOriginalMetadata,
  ImportedSource,
  ImportInspectionDraft,
  ImportRiskReport,
  NormalizedMethodSpec,
} from '../types/index.js';
import { deriveMethodName, deriveNamespace, toSafeSlug } from './naming.js';
import { buildExampleValue, isFlatScalarSchema, schemaParameters } from './jsonSchema.js';
import { IMPORTED_TOOLS_MCP_TIMEOUT_MS } from './constants.js';
import { resolveImportedSource } from './sourceResolver.js';
import { isPlainObject } from './utils.js';

export interface McpInspectionOptions {
  source: ImportedSource;
  existingToolNames?: string[];
}

function toMethodSpec(tool: ImportedDiscoveredTool, namespace: string, usedNames: Set<string>): NormalizedMethodSpec {
  const inputSchema = isPlainObject(tool.inputSchema) ? tool.inputSchema as Record<string, unknown> : undefined;
  const parameters = schemaParameters(inputSchema);
  const methodName = deriveMethodName(tool.name, namespace, usedNames);
  usedNames.add(methodName);
  return {
    originalName: tool.name,
    methodName,
    description: tool.description,
    inputSchema,
    outputSchema: isPlainObject(tool.outputSchema) ? tool.outputSchema as Record<string, unknown> : undefined,
    parameters,
    orderedParameters: parameters.map((parameter) => parameter.name),
    positionalOverload: isFlatScalarSchema(inputSchema) && parameters.length <= 3,
    invocation: {
      kind: 'mcp',
      toolName: tool.name,
    },
  };
}

function buildRiskReport(tools: ImportedDiscoveredTool[], promptsCount: number, resourcesCount: number): ImportRiskReport {
  const warnings: string[] = [];
  const blockers: string[] = [];
  const inferred: string[] = [];

  if (tools.length === 0) {
    blockers.push('The MCP server did not expose any callable tools.');
  }
  if (promptsCount > 0) {
    warnings.push(`The source exposes ${promptsCount} prompt(s); v1 records them but does not activate them.`);
  }
  if (resourcesCount > 0) {
    warnings.push(`The source exposes ${resourcesCount} resource(s); v1 records them but does not activate them.`);
  }
  for (const tool of tools) {
    if (!tool.outputSchema) {
      warnings.push(`Tool "${tool.name}" does not declare an output schema.`);
    }
    if (tool.annotations?.destructiveHint) {
      warnings.push(`Tool "${tool.name}" is marked as potentially destructive.`);
    }
    if (!tool.description) {
      inferred.push(`Tool "${tool.name}" is missing a description; the importer will synthesize one.`);
    }
  }

  return { warnings, blockers, inferred };
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

export async function inspectMcpImport(options: McpInspectionOptions): Promise<ImportInspectionDraft> {
  const resolved = await resolveImportedSource(options.source);
  const transport = new StdioClientTransport({
    command: resolved.runtime.command,
    args: resolved.runtime.args,
    cwd: resolved.runtime.cwd || resolved.runtime.runtimeDir,
    env: resolved.runtime.env,
    stderr: 'pipe',
  });

  try {
    const client = new Client(
      { name: 'telos-imported-tools-studio', version: '1.0.0' },
      { capabilities: {} }
    );
    await withTimeout(
      client.connect(transport),
      IMPORTED_TOOLS_MCP_TIMEOUT_MS,
      `MCP connect (${resolved.runtime.command} ${resolved.runtime.args.join(' ')})`
    );

    const toolResult = await withTimeout(
      client.listTools(),
      IMPORTED_TOOLS_MCP_TIMEOUT_MS,
      `MCP tools/list (${resolved.runtime.command} ${resolved.runtime.args.join(' ')})`
    );
    const capabilities = client.getServerCapabilities();
    const promptsCount = capabilities?.prompts
      ? (await withTimeout(client.listPrompts(), IMPORTED_TOOLS_MCP_TIMEOUT_MS, 'MCP prompts/list')).prompts.length
      : 0;
    const resourcesCount = capabilities?.resources
      ? (await withTimeout(client.listResources(), IMPORTED_TOOLS_MCP_TIMEOUT_MS, 'MCP resources/list')).resources.length
      : 0;
    const displayName = options.source.displayName || client.getServerVersion()?.name || options.source.value;
    const namespace = deriveNamespace(displayName, options.existingToolNames);
    const slug = toSafeSlug(displayName);

    const discoveredTools = toolResult.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      outputSchema: tool.outputSchema,
      annotations: tool.annotations as Record<string, unknown> | undefined,
    } satisfies ImportedDiscoveredTool));

    const risk = buildRiskReport(discoveredTools, promptsCount, resourcesCount);
    const usedNames = new Set<string>();
    const methods = discoveredTools.map((tool) => toMethodSpec(tool, namespace, usedNames));
    const original: ImportedOriginalMetadata = {
      readme: resolved.readme,
      promptsCount,
      resourcesCount,
      discoveredTools,
    };

    return {
      kind: 'mcp',
      slug,
      namespace,
      displayName,
      knowledgeMode: 'both',
      description: `${displayName} imported MCP namespace.`,
      source: options.source,
      runtime: resolved.runtime,
      methods,
      risk,
      docs: {
        toolDescription: '',
        usageMarkdown: '',
        methodDocs: {},
        sources: [
          ...(resolved.readme ? [{ name: 'README.md', kind: 'readme' as const }] : []),
          { name: 'tool-inspection', kind: 'inspection' as const },
        ],
        generatedWith: '',
      },
      original,
    };
  } finally {
    await transport.close().catch(() => {});
    await resolved.cleanup().catch(() => {});
  }
}

export function buildMcpSmokeInput(method: NormalizedMethodSpec): Record<string, unknown> {
  const schema = method.inputSchema;
  return isPlainObject(schema) ? buildExampleValue(schema as Record<string, unknown>) as Record<string, unknown> : {};
}
