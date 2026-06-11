import type { AgentMemoryCategoryConfig, LoadedAgent, LoadedTool } from '../types/index.js';

export function areMemoryToolDocsEnabled(agent: LoadedAgent): boolean {
  return Boolean(agent.config.memoryToolDocs ?? agent.config.memory?.memoryToolDocs);
}

export function getToolDocCategoryName(toolName: string): string {
  return `tooldoc_${toolName}`;
}

export function getEffectiveMemoryCategories(
  agent: LoadedAgent,
  tools: LoadedTool[]
): AgentMemoryCategoryConfig[] | undefined {
  const baseCategories = agent.config.memory?.categories ?? [];
  if (!areMemoryToolDocsEnabled(agent)) {
    return agent.config.memory?.categories;
  }

  const categories: AgentMemoryCategoryConfig[] = [...baseCategories];
  const seen = new Set(categories.map((cat) => cat.name));

  for (const tool of tools) {
    const categoryName = getToolDocCategoryName(tool.config.name);
    if (!seen.has(categoryName)) {
      seen.add(categoryName);
      categories.push({ name: categoryName });
    }
  }

  return categories;
}
