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

/**
 * View files from the sandbox directory and add them to context
 * Files are read as base64 and stored in .acn-files.json for the Executor to process
 * 
 * @param filePaths - Array of file paths relative to the sandbox directory
 * @returns Object with success status, count of files read, and any errors
 * 
 * @example
 * const result = await skills.viewFiles(["./document.pdf", "./image.jpg"]);
 * console.log(result.filesRead); // Number of files successfully read
 */
export async function viewFiles(
  filePaths: string[]
): Promise<{ success: boolean; filesRead: number; errors?: string[] }> {
  if (!filePaths || !Array.isArray(filePaths) || filePaths.length === 0) {
    throw new Error('filePaths must be a non-empty array');
  }

  // Validate all paths are strings
  for (const filePath of filePaths) {
    if (typeof filePath !== 'string' || !filePath.trim()) {
      throw new Error('All file paths must be non-empty strings');
    }
  }

  const sandboxDir = process.cwd(); // Sandbox directory is the current working directory
  const filesJsonPath = path.join(sandboxDir, '.acn-files.json');

  const files: Array<{ content: string; filename: string }> = [];
  const errors: string[] = [];

  for (const filePath of filePaths) {
    try {
      const absolutePath = path.resolve(sandboxDir, filePath);

      // Security: Ensure the path is within the sandbox directory
      if (!absolutePath.startsWith(path.resolve(sandboxDir))) {
        errors.push(`Path "${filePath}" is outside sandbox directory`);
        continue;
      }

      // Check if file exists
      if (!fs.existsSync(absolutePath)) {
        errors.push(`File "${filePath}" not found`);
        continue;
      }

      // Check if it's a file (not a directory)
      const stats = fs.statSync(absolutePath);
      if (!stats.isFile()) {
        errors.push(`"${filePath}" is not a file`);
        continue;
      }

      // Read file as base64
      const base64Content = fs.readFileSync(absolutePath, { encoding: 'base64' });
      const filename = path.basename(absolutePath);

      files.push({
        content: base64Content,
        filename: filename,
      });

      console.log(`[Skills] Read file: ${filename} (${stats.size} bytes)`);
    } catch (error: any) {
      errors.push(`Failed to read "${filePath}": ${error.message}`);
    }
  }

  // Write files to .acn-files.json
  if (files.length > 0) {
    try {
      fs.writeFileSync(filesJsonPath, JSON.stringify(files, null, 2), 'utf-8');
      console.log(`[Skills] Added ${files.length} file(s) to context`);
    } catch (error: any) {
      errors.push(`Failed to write .acn-files.json: ${error.message}`);
    }
  }

  return {
    success: files.length > 0,
    filesRead: files.length,
    errors: errors.length > 0 ? errors : undefined,
  };
}
