/**
* Base syntax type interface and utilities
* 
* Syntax types define how agents express thinking, actions, and observations.
* Each syntax type provides extraction, wrapping, and documentation.
*/

import type { SyntaxType } from '../types/index.js';

/**
 * Abstract base class for syntax types
 */
export abstract class BaseSyntax implements SyntaxType {
  abstract name: string;

  // Extraction methods - must handle incomplete/cut-off tags
  abstract getThinking(text: string): string | null;
  abstract getAction(text: string): string | null;
  abstract getObservation(text: string): string | null;
  abstract getCli(text: string): string | null;
  abstract getSkills(text: string): string | null;
  abstract getFiles(text: string): { path: string; content: string }[];
  abstract getDiffs(text: string): string[];
  abstract getEdits(text: string): { filename: string; content: string }[];

  // Check if tag exists
  abstract hasAction(text: string): boolean;
  abstract hasCli(text: string): boolean;

  // Check if tag is fully closed
  abstract isActionClosed(text: string): boolean;
  abstract isCliClosed(text: string): boolean;

  abstract hasAnyClosedBlock(text: string): boolean;

  // Wrapping methods
  abstract wrapThinking(content: string): string;
  abstract wrapAction(content: string): string;
  abstract wrapObservation(content: string): string;
  abstract wrapCli(content: string): string;
  abstract wrapSkills(content: string): string;

  // Optional: wrap multiple skill entries (default implementation wraps each separately)
  wrapSkillsMultiple(contents: string[]): string {
    return contents.map(content => this.wrapSkills(content)).join('\n');
  }

  // Documentation for system prompt
  abstract getDescription(): string;
}

/**
 * Syntax registry for dynamic loading
 */
const syntaxRegistry = new Map<string, () => SyntaxType>();

export function registerSyntax(name: string, factory: () => SyntaxType): void {
  syntaxRegistry.set(name, factory);
}

export function getSyntax(name: string): SyntaxType {
  const factory = syntaxRegistry.get(name);
  if (!factory) {
    throw new Error(`Syntax "${name}" not found. Available: ${Array.from(syntaxRegistry.keys()).join(', ')}`);
  }
  return factory();
}

export function getAvailableSyntax(): string[] {
  return Array.from(syntaxRegistry.keys());
}
