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
   * Remove thought blocks from text to avoid extracting tags from reasoning.
   * Handles both closed <think>...</think> and unclosed <think>... at the end.
   */
  private stripThoughts(text: string): string {
    // 1. Remove closed thought blocks
    let cleaned = text.replace(/<(think|thought)>[\s\S]*?<\/(think|thought)>/gi, '');
    // 2. Remove unclosed thought block if it's at the end (for streaming/cut-off responses)
    cleaned = cleaned.replace(/<(think|thought)>[\s\S]*$/gi, '');
    return cleaned;
  }

  /**
   * Extract content from a tag, handling incomplete/cut-off tags
   * @param text - The text to search
   * @param tagName - The tag name (without brackets)
   * @returns The content inside the tag, or null if not found
   */
  private extractTag(text: string, tagName: string): string | null {
    // We scan the full text, including thoughts, to support CoT actions
    const textToSearch = text;

    const openTag = `<${tagName}>`;
    const closeTag = `</${tagName}>`;

    // Pattern 1: Find all complete tags <tag>content</tag>
    const completePattern = new RegExp(`<${tagName}>([\\s\\S]*?)</${tagName}>`, 'gi');
    const matches = Array.from(textToSearch.matchAll(completePattern));

    if (matches.length > 0) {
      // Return the content of the LAST complete tag
      const lastMatch = matches[matches.length - 1];
      if (lastMatch) {
        return lastMatch[1]?.trim() ?? null;
      }
    }

    // Pattern 2: Incomplete tag (cut off by stop sequence) <tag>content
    // Search for the LAST occurrence of the opening tag
    const lastOpenIndex = textToSearch.toLowerCase().lastIndexOf(openTag.toLowerCase());
    if (lastOpenIndex !== -1) {
      // Ensure we don't return code if it was actually closed (should be handled by Pattern 1)
      const contentAfterOpen = textToSearch.slice(lastOpenIndex + openTag.length);
      const closeTagIndex = contentAfterOpen.toLowerCase().indexOf(closeTag.toLowerCase());

      if (closeTagIndex === -1) {
        return contentAfterOpen.trim();
      }
    }

    return null;
  }

  /**
   * Check if a tag opening exists in the text
   */
  private hasTag(text: string, tagName: string): boolean {
    const textToSearch = text;

    const pattern = new RegExp(`<${tagName}>`, 'i');
    return pattern.test(textToSearch);
  }

  /**
   * Check if a tag is fully closed
   */
  private isTagClosed(text: string, tagName: string): boolean {
    const textToSearch = text;

    const openTag = `<${tagName}>`;
    const closeTag = `</${tagName}>`;

    const lastOpenIndex = textToSearch.toLowerCase().lastIndexOf(openTag.toLowerCase());
    if (lastOpenIndex === -1) return false;

    const lastCloseIndex = textToSearch.toLowerCase().lastIndexOf(closeTag.toLowerCase());
    return lastCloseIndex > lastOpenIndex;
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

  getFiles(text: string): { path: string; content: string }[] {
    return [];
  }

  getDiffs(text: string): string[] {
    return [];
  }

  getEdits(text: string): { filename: string; content: string }[] {
    return []; // XML syntax doesn't support edit blocks
  }

  hasAction(text: string): boolean {
    return this.hasTag(text, 'action');
  }

  hasCli(text: string): boolean {
    return this.hasTag(text, 'cli');
  }

  isActionClosed(text: string): boolean {
    return this.isTagClosed(text, 'action');
  }

  isCliClosed(text: string): boolean {
    return this.isTagClosed(text, 'cli');
  }

  hasAnyClosedBlock(text: string): boolean {
    return this.isActionClosed(text) || this.isCliClosed(text);
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

  /**
   * Wrap multiple skill entries as separate <skills> tags
   */
  override wrapSkillsMultiple(contents: string[]): string {
    return contents.map(content => this.wrapSkills(content)).join('\n');
  }

  getDescription(): string {
    return `## Syntax (xml-tags)

- \`<think>...\n</think>\` optional private reasoning.
- \`<action>...\n</action>\` Executable code (see Sandbox details for specific language and behavior).
- \`<cli>...\n</cli>\` Command execution (see Sandbox details for available commands).
- \`<obs>...\n</obs>\` is injected by the system after execution (do not write it yourself).
- \`<skills>...\n</skills>\` contains relevant knowledge, guidelines, or instructions that have been automatically retrieved based on the user's query.`;
  }
}

// Register the syntax
registerSyntax('xml-tags', () => new XMLTagsSyntax());

export default XMLTagsSyntax;
