/**
 * Skills Tool
 * 
 * Built-in tool providing skills functions for all agents.
 * Includes knowledge base management via the skills system.
 */

import { SkillsService } from '../../src/skills_system/SkillsService.js';
import * as fs from 'fs';
import * as path from 'path';

// Get the skills table from environment variable (set by Sandbox)
const SKILLS_TABLE = process.env.SKILLS_TABLE;

// Lazily initialized SkillsService
let skillsService: SkillsService | null = null;

/**
 * Get or create the SkillsService instance
 */
async function getSkillsService(): Promise<SkillsService> {
  if (!SKILLS_TABLE) {
    throw new Error('Skills system not configured for this agent. Add skillsTable to agent config.');
  }

  if (!skillsService) {
    skillsService = new SkillsService(SKILLS_TABLE);
    await skillsService.initialize();
  }

  return skillsService;
}

/**
 * Add a new entry to the agent's knowledge base using example-based semantic matching
 * 
 * @param content - The skill/knowledge content to store
 * @param examples - Array of example queries/requests when this entry should be retrieved (required, at least 1)
 * @param scoreThreshold - Optional similarity threshold (0-1, default: 0.8). Not recommended to change.
 * @returns Object with success status and entry ID
 * 
 * @example
 * const result = await skills.add(
 *   "Always be polite and friendly with the user",
 *   ["Hello, how are you?", "The user greets me", "Conversational interaction"],
 *   0.8
 * );
 * console.log(result.id); // Unique ID of the created entry
 */
export async function add(
  content: string,
  examples: string[],
  scoreThreshold?: number
): Promise<{ success: boolean; id: string }> {
  console.log(`[Skills] Adding to knowledge base: "${content.substring(0, 50)}${content.length > 50 ? '...' : ''}"`);
  console.log(`[Skills] With ${examples.length} example(s)`);

  if (!content || typeof content !== 'string') {
    throw new Error('Content must be a non-empty string');
  }

  if (!examples || !Array.isArray(examples) || examples.length === 0) {
    throw new Error('At least one example is required. Examples describe when this entry should be retrieved.');
  }

  // Validate all examples are strings
  for (const example of examples) {
    if (typeof example !== 'string' || !example.trim()) {
      throw new Error('All examples must be non-empty strings');
    }
  }

  const service = await getSkillsService();
  const result = await service.addEntry(content, examples, scoreThreshold);

  console.log(`[Skills] Entry added with ID: ${result.id}`);
  return result;
}

/**
 * Search the agent's knowledge base
 * Always returns the top result, regardless of score
 * 
 * @param query - The search query
 * @returns The top matching entry with its content and score, or null if no entries exist
 * 
 * @example
 * const result = await skills.search("user preferences");
 * if (result) {
 *   console.log(result.content); // The matched content
 *   console.log(result.score);   // Relevance score (0-1)
 * }
 */
export async function search(query: string): Promise<{ content: string; score: number } | null> {
  console.log(`[Skills] Searching knowledge base: "${query.substring(0, 50)}${query.length > 50 ? '...' : ''}"`);

  if (!query || typeof query !== 'string') {
    throw new Error('Query must be a non-empty string');
  }

  const service = await getSkillsService();
  const result = await service.manualSearch(query);

  if (!result) {
    console.log('[Skills] No results found');
    return null;
  }

  console.log(`[Skills] Found match with score: ${(result.score * 100).toFixed(1)}%`);
  return {
    content: result.content,
    score: result.score,
  };
}

