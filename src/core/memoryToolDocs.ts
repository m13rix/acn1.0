import type { AgentMemoryCategoryConfig, LoadedAgent, LoadedTool } from '../types/index.js';
import { resolveProjectMemoryCategory } from '../memory_system/projectCategory.js';

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
  const categories: AgentMemoryCategoryConfig[] = [...baseCategories];
  const seen = new Set(categories.map((cat) => cat.name.toLocaleLowerCase()));

  const projectCategory = resolveProjectMemoryCategory(agent.config.memory?.projectCategory);
  if (projectCategory && !seen.has(projectCategory.toLocaleLowerCase())) {
    seen.add(projectCategory.toLocaleLowerCase());
    categories.push({ name: projectCategory });
  }

  if (!areMemoryToolDocsEnabled(agent)) {
    return categories.length > 0 ? categories : undefined;
  }

  for (const tool of tools) {
    const categoryName = getToolDocCategoryName(tool.config.name);
    const normalizedCategoryName = categoryName.toLocaleLowerCase();
    if (!seen.has(normalizedCategoryName)) {
      seen.add(normalizedCategoryName);
      categories.push({ name: categoryName });
    }
  }

  return categories.length > 0 ? categories : undefined;
}
