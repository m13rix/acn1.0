/**
 * System Tool
 * 
 * Built-in tool providing system functions for all agents.
 * Includes knowledge base management via the skills system.
 */

import { SkillsService } from '../../src/skills_system/SkillsService.js';

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
 * Add a new entry to the agent's knowledge base
 * 
 * @param content - The content to store in the knowledge base
 * @returns Object with success status and entry ID
 * 
 * @example
 * const result = await system.add("The user prefers dark mode themes");
 * console.log(result.id); // Unique ID of the created entry
 */
export async function add(content: string): Promise<{ success: boolean; id: string }> {
  console.log(`[System] Adding to knowledge base: "${content.substring(0, 50)}${content.length > 50 ? '...' : ''}"`);
  
  if (!content || typeof content !== 'string') {
    throw new Error('Content must be a non-empty string');
  }
  
  const service = await getSkillsService();
  const result = await service.addEntry(content);
  
  console.log(`[System] Entry added with ID: ${result.id}`);
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
 * const result = await system.search("user preferences");
 * if (result) {
 *   console.log(result.content); // The matched content
 *   console.log(result.score);   // Relevance score (0-1)
 * }
 */
export async function search(query: string): Promise<{ content: string; score: number } | null> {
  console.log(`[System] Searching knowledge base: "${query.substring(0, 50)}${query.length > 50 ? '...' : ''}"`);
  
  if (!query || typeof query !== 'string') {
    throw new Error('Query must be a non-empty string');
  }
  
  const service = await getSkillsService();
  const result = await service.manualSearch(query);
  
  if (!result) {
    console.log('[System] No results found');
    return null;
  }
  
  console.log(`[System] Found match with score: ${(result.normalizedScore * 100).toFixed(1)}%`);
  return {
    content: result.content,
    score: result.normalizedScore,
  };
}
