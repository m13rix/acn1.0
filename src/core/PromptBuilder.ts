/**
 * Prompt Builder
 *
 * Assembles the final system prompt by combining:
 * 1. Base system prompt from agent config
 * 2. Loop documentation
 * 4. Tool documentation
 */

import type { LoadedAgent, LoadedTool, SyntaxType, LoopType } from '../types/index.js';
import type { ISandbox } from '../sandbox/interfaces.js';
import { ToolLoader } from '../loaders/ToolLoader.js';
import { areMemoryToolDocsEnabled } from './memoryToolDocs.js';

export class PromptBuilder {
  private toolLoader: ToolLoader;

  constructor(toolLoader?: ToolLoader) {
    this.toolLoader = toolLoader || new ToolLoader();
  }

  /**
   * Build the complete system prompt for an agent
   */
  build(
    agent: LoadedAgent,
    syntax: SyntaxType,
    loop: LoopType,
    tools: LoadedTool[],
    sandbox: ISandbox
  ): string {
    const sections: string[] = [];

    // 1. Base system prompt
    if (agent.systemPromptContent.trim()) {
      sections.push(agent.systemPromptContent.trim());
    }

    // 2. Separator
    sections.push('---');

    // 3. Loop documentation
    const loopDoc = loop.getDescription();
    if (loopDoc.trim()) {
      sections.push(loopDoc.trim());
    }

    // 5. Sandbox documentation
    const sandboxDoc = sandbox.getDescription(agent.config.actionToolPolicy);
    if (sandboxDoc.trim()) {
      sections.push(sandboxDoc.trim());
    }

    // 6. Tool documentation
    const toolDoc = areMemoryToolDocsEnabled(agent)
      ? this.buildCompactToolDocumentation(tools)
      : this.toolLoader.getToolDocumentation(tools);
    if (toolDoc.trim()) {
      sections.push(toolDoc.trim());
    }

    return sections.join('\n\n');
  }

  /**
   * Build a minimal prompt for debugging
   */
  buildMinimal(agent: LoadedAgent): string {
    return agent.systemPromptContent.trim();
  }

  private buildCompactToolDocumentation(tools: LoadedTool[]): string {
    if (tools.length === 0) {
      return '## Tool Modules\n\nNo tool modules are available.';
    }

    const names = tools.map((tool) => `\`${tool.config.name}\``).join(', ');
    const utilsHint = tools.some((tool) => tool.config.name === 'utils')
      ? 'Every tool has `tool.help()`. If something is unclear, inspect help instead of guessing.'
      : '';

    return `## Tool Modules

Available modules: ${names}.

${utilsHint} Full docs may also be available through MEMORY HINTS/search, so do not load every tool doc up front.`;
  }
}

export default PromptBuilder;
