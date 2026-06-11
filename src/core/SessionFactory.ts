import type { LoadedAgent, LoadedTool, Provider, SyntaxType, LoopType } from '../types/index.js';
import { ToolLoader } from '../loaders/ToolLoader.js';
import { getSyntax } from '../syntax/index.js';
import { getLoop } from '../loops/index.js';
import type { SessionComponents } from './Session.js';
import { createTextRuntimePlaceholderProvider } from '../providers/ai-sdk-text.js';

export function getAugmentedToolNames(agent: LoadedAgent, extraToolNames: string[] = []): string[] {
  const toolNames = [...(agent.config.tools || [])];
  if (!toolNames.includes('files')) toolNames.push('files');
  if (agent.config.memory?.enabled !== false && !toolNames.includes('memory')) {
    toolNames.push('memory');
  }

  for (const extraToolName of extraToolNames) {
    if (!toolNames.includes(extraToolName)) {
      toolNames.push(extraToolName);
    }
  }

  return toolNames;
}

export async function loadAgentTools(
  agent: LoadedAgent,
  toolLoader: ToolLoader,
  extraToolNames: string[] = []
): Promise<LoadedTool[]> {
  return toolLoader.loadByNames(getAugmentedToolNames(agent, extraToolNames));
}

export function resolveTextAgentRuntime(agent: LoadedAgent): {
  provider: Provider;
  syntax: SyntaxType;
  loop: LoopType;
} {
  return {
    provider: createTextRuntimePlaceholderProvider(agent.config.provider || 'openrouter'),
    syntax: getSyntax('markdown'),
    loop: getLoop('provider-tools'),
  };
}

export async function buildTextSessionComponents(
  agent: LoadedAgent,
  toolLoader: ToolLoader,
  extraToolNames: string[] = []
): Promise<SessionComponents> {
  const runtime = resolveTextAgentRuntime(agent);
  const tools = await loadAgentTools(agent, toolLoader, extraToolNames);

  return {
    agent,
    provider: runtime.provider,
    syntax: runtime.syntax,
    loop: runtime.loop,
    tools,
  };
}
