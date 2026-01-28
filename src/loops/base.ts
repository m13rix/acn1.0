/**
 * Base loop type interface and utilities
 * 
 * Loop types define how the agent loop operates:
 * - What stop sequences to use
 * - How to process responses
 * - How to build continuation messages
 */

import type { LoopType, ProcessedResponse, SyntaxType } from '../types/index.js';

/**
 * Abstract base class for loop types
 */
export abstract class BaseLoop implements LoopType {
  abstract name: string;
  stopSequences?: string[];

  // Process model response and extract action if present
  abstract processResponse(response: string, syntax: SyntaxType): ProcessedResponse;

  // Build messages for continuation after action execution
  abstract buildContinuationMessages(
    currentAssistantContent: string,
    observation: string,
    syntax: SyntaxType,
    filename?: string, // Filename of the executed file (for code executions only)
    originalUserRequest?: string
  ): { updatedAssistantContent: string; continuationUserMessage: string };

  // Documentation for system prompt
  abstract getDescription(): string;

  /**
   * Default implementation: don't commit messages after each action
   * Messages accumulate until completion
   */
  shouldCommitMessagesAfterAction(): boolean {
    return false;
  }
}

/**
 * Loop registry for dynamic loading
 */
const loopRegistry = new Map<string, () => LoopType>();

export function registerLoop(name: string, factory: () => LoopType): void {
  loopRegistry.set(name, factory);
}

export function getLoop(name: string): LoopType {
  const factory = loopRegistry.get(name);
  if (!factory) {
    throw new Error(`Loop "${name}" not found. Available: ${Array.from(loopRegistry.keys()).join(', ')}`);
  }
  return factory();
}

export function getAvailableLoops(): string[] {
  return Array.from(loopRegistry.keys());
}
