/**
 * XML Tags Syntax
 * 
 * Uses XML-style tags for agent communication:
 * - <think>...</think> for reasoning
 * - <action>...</action> for code execution
 * - <obs>...</obs> for observations (injected by system)
 */

import { BaseSyntax, registerSyntax } from './base.js';

export class XMLTagsSyntax extends BaseSyntax {
  name = 'xml-tags';
  
  /**
   * Extract content from a tag, handling incomplete/cut-off tags
   * @param text - The text to search
   * @param tagName - The tag name (without brackets)
   * @returns The content inside the tag, or null if not found
   */
  private extractTag(text: string, tagName: string): string | null {
    // Pattern 1: Complete tag <tag>content</tag>
    const completePattern = new RegExp(`<${tagName}>([\\s\\S]*?)</${tagName}>`, 'i');
    const completeMatch = text.match(completePattern);
    if (completeMatch) {
      return completeMatch[1]?.trim() ?? null;
    }
    
    // Pattern 2: Incomplete tag (cut off by stop sequence) <tag>content
    // This handles cases where the closing tag was not generated
    const incompletePattern = new RegExp(`<${tagName}>([\\s\\S]*)$`, 'i');
    const incompleteMatch = text.match(incompletePattern);
    if (incompleteMatch) {
      return incompleteMatch[1]?.trim() ?? null;
    }
    
    return null;
  }
  
  /**
   * Check if a tag opening exists in the text
   */
  private hasTag(text: string, tagName: string): boolean {
    const pattern = new RegExp(`<${tagName}>`, 'i');
    return pattern.test(text);
  }
  
  getThinking(text: string): string | null {
    return this.extractTag(text, 'think');
  }
  
  getAction(text: string): string | null {
    return this.extractTag(text, 'action');
  }
  
  getObservation(text: string): string | null {
    return this.extractTag(text, 'obs');
  }
  
  getCli(text: string): string | null {
    return this.extractTag(text, 'cli');
  }
  
  getSkills(text: string): string | null {
    return this.extractTag(text, 'skills');
  }
  
  hasAction(text: string): boolean {
    return this.hasTag(text, 'action');
  }
  
  hasCli(text: string): boolean {
    return this.hasTag(text, 'cli');
  }
  
  wrapThinking(content: string): string {
    return `<think>\n${content}\n</think>`;
  }
  
  wrapAction(content: string): string {
    return `<action>\n${content}\n</action>`;
  }
  
  wrapObservation(content: string): string {
    return `<obs>\n${content}\n</obs>`;
  }
  
  wrapCli(content: string): string {
    return `<cli>\n${content}\n</cli>`;
  }
  
  wrapSkills(content: string): string {
    return `<skills>\n${content}\n</skills>`;
  }
  
  getDescription(): string {
    return `## Syntax (xml-tags)

- \`<think>...\n</think>\` optional private reasoning.
- \`<action>...\n</action>\` TypeScript to run locally. Use \`console.log(...)\` to produce output.
- \`<cli>...\n</cli>\` Shell command to run in the sandbox. Use for npm install, file operations, git, etc.
- \`<obs>...\n</obs>\` is injected by the system after execution (do not write it yourself).`;
  }
}

// Register the syntax
registerSyntax('xml-tags', () => new XMLTagsSyntax());

export default XMLTagsSyntax;
