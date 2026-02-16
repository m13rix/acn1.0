/**
 * Prompt Builder
 * 
 * Assembles the final system prompt by combining:
 * 1. Base system prompt from agent config
 * 2. Syntax documentation
 * 3. Loop documentation
 * 4. Tool documentation
 */

import type { LoadedAgent, LoadedTool, SyntaxType, LoopType } from '../types/index.js';
import type { ISandbox } from '../sandbox/interfaces.js';
import { ToolLoader } from '../loaders/ToolLoader.js';

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

    // 3. Syntax documentation (only for syntax-aware loops)
    const loopUsesSyntax = loop.usesSyntax?.() ?? true;
    if (loopUsesSyntax) {
      const syntaxDoc = syntax.getDescription();
      if (syntaxDoc.trim()) {
        sections.push(syntaxDoc.trim());
      }
    }

    // 4. Loop documentation
    const loopDoc = loop.getDescription();
    if (loopDoc.trim()) {
      sections.push(loopDoc.trim());
    }

    // 5. Sandbox documentation
    const sandboxDoc = sandbox.getDescription();
    if (sandboxDoc.trim()) {
      sections.push(sandboxDoc.trim());
    }

    // 6. Tool documentation
    const toolDoc = this.toolLoader.getToolDocumentation(tools);
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
}

export default PromptBuilder;
