/**
 * Tool Loader
 *
 * Recursively scans the tools directory and loads tool configurations.
 */

import { readdir, readFile, stat } from 'fs/promises';
import { existsSync } from 'fs';
import { join, dirname, relative } from 'path';
import { parse as parseYaml } from 'yaml';
import { fileURLToPath } from 'url';
import type { ToolConfig, LoadedTool, ToolSkillEntry } from '../types/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Use PROJECT_ROOT from environment if available (for sandbox context)
// Fallback to __dirname calculation, then to cwd
const calculatedRoot = join(__dirname, '..', '..');
const PROJECT_ROOT = process.env['PROJECT_ROOT']
  || (existsSync(join(calculatedRoot, 'tools')) ? calculatedRoot : process.cwd());
const DEFAULT_TOOLS_DIR = join(PROJECT_ROOT, 'tools');

export class ToolLoader {
  private toolsDir: string;
  private cache: Map<string, LoadedTool> = new Map();

  constructor(toolsDir?: string) {
    this.toolsDir = toolsDir || DEFAULT_TOOLS_DIR;
  }

  /**
   * Load all tools from the tools directory
   */
  async loadAll(): Promise<LoadedTool[]> {
    const tools: LoadedTool[] = [];
    await this.scanDirectory(this.toolsDir, tools);

    // Cache all loaded tools
    for (const tool of tools) {
      this.cache.set(tool.config.name, tool);
    }

    return tools;
  }

  /**
   * Load a specific tool by name
   */
  async loadByName(name: string): Promise<LoadedTool | null> {
    // Check cache first
    if (this.cache.has(name)) {
      return this.cache.get(name)!;
    }

    // Load all and find
    const tools = await this.loadAll();
    return tools.find(t => t.config.name === name) || null;
  }

  /**
   * Load multiple tools by name
   */
  async loadByNames(names: string[]): Promise<LoadedTool[]> {
    const allTools = await this.loadAll();
    const toolMap = new Map(allTools.map(t => [t.config.name, t]));

    const result: LoadedTool[] = [];
    const missing: string[] = [];

    for (const name of names) {
      const tool = toolMap.get(name);
      if (tool) {
        result.push(tool);
      } else {
        missing.push(name);
      }
    }

    if (missing.length > 0) {
      console.warn(`Warning: Tools not found: ${missing.join(', ')}`);
    }

    return result;
  }

  /**
   * Recursively scan directory for tool configs
   */
  private async scanDirectory(dir: string, tools: LoadedTool[]): Promise<void> {
    try {
      const entries = await readdir(dir, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = join(dir, entry.name);

        if (entry.isDirectory()) {
          const toolConfig = await this.tryLoadToolConfig(fullPath);
          if (toolConfig) {
            tools.push(toolConfig);
          }

          // Always recurse so nested tool trees remain discoverable.
          await this.scanDirectory(fullPath, tools);
        }
      }
    } catch (error) {
      // Directory doesn't exist or can't be read
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.warn(`Warning: Could not scan directory ${dir}:`, error);
      }
    }
  }

  /**
   * Try to load a tool config from a directory
   */
  private async tryLoadToolConfig(dir: string): Promise<LoadedTool | null> {
    // Look for tool.yaml or tool.yml
    const configFiles = ['tool.yaml', 'tool.yml', 'tool.json'];

    for (const configFile of configFiles) {
      const configPath = join(dir, configFile);

      try {
        const configStat = await stat(configPath);
        if (configStat.isFile()) {
          const content = await readFile(configPath, 'utf-8');
          const config = this.parseConfig(content, configFile) as ToolConfig;

          // Validate required fields.
          // description may be intentionally empty for skill-driven tools.
          if (!config.name || typeof config.description !== 'string') {
            console.warn(`Warning: Tool config in ${dir} missing required fields`);
            continue;
          }

          // Default module to index.ts
          config.module = config.module || 'index.ts';

          // Resolve the absolute path to the module
          const absolutePath = join(dir, config.module);
          const skillEntries = await this.loadToolSkillEntries(config, dir);

          return {
            config,
            directory: dir,
            absolutePath,
            skillEntries,
          };
        }
      } catch {
        // Config file doesn't exist, try next
      }
    }

    return null;
  }

  /**
   * Parse config file based on extension
   */
  private parseConfig(content: string, filename: string): unknown {
    if (filename.endsWith('.json')) {
      return JSON.parse(content);
    } else {
      return parseYaml(content);
    }
  }

  private async loadToolSkillEntries(config: ToolConfig, toolDir: string): Promise<ToolSkillEntry[]> {
    if (!config.skills?.enabled) {
      return [];
    }

    const skillsDir = join(toolDir, config.skills.directory || 'skills');
    const entries: ToolSkillEntry[] = [];
    await this.scanSkillDirectory(config.name, skillsDir, entries);
    return entries;
  }

  private async scanSkillDirectory(toolName: string, dir: string, entries: ToolSkillEntry[]): Promise<void> {
    try {
      const dirEntries = await readdir(dir, { withFileTypes: true });
      for (const entry of dirEntries) {
        const fullPath = join(dir, entry.name);
        if (entry.isDirectory()) {
          await this.scanSkillDirectory(toolName, fullPath, entries);
          continue;
        }
        if (!entry.isFile() || !/\.(json|ya?ml)$/i.test(entry.name)) {
          continue;
        }

        const fileStats = await stat(fullPath);
        const raw = await readFile(fullPath, 'utf8');
        const parsed = this.parseConfig(raw, entry.name);
        const normalizedEntries = this.normalizeSkillEntries(toolName, fullPath, parsed, fileStats.mtimeMs);
        entries.push(...normalizedEntries);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.warn(`Warning: Could not load tool skills from ${dir}:`, error);
      }
    }
  }

  private normalizeSkillEntries(
    toolName: string,
    filePath: string,
    value: unknown,
    updatedAt: number
  ): ToolSkillEntry[] {
    const payloads = Array.isArray(value)
      ? value
      : value && typeof value === 'object' && Array.isArray((value as { entries?: unknown[] }).entries)
        ? (value as { entries: unknown[] }).entries
        : [value];

    const relativePath = relative(this.toolsDir, filePath).replace(/\\/g, '/');
    const result: ToolSkillEntry[] = [];

    for (let index = 0; index < payloads.length; index += 1) {
      const payload = payloads[index];
      if (!payload || typeof payload !== 'object') {
        continue;
      }
      const content = typeof (payload as { content?: unknown }).content === 'string'
        ? (payload as { content: string }).content.trim()
        : '';
      const examples = Array.isArray((payload as { examples?: unknown[] }).examples)
        ? (payload as { examples: unknown[] }).examples
          .map((example) => typeof example === 'string' ? example.trim() : '')
          .filter(Boolean)
        : [];
      if (!content || examples.length === 0) {
        continue;
      }

      const title = typeof (payload as { title?: unknown }).title === 'string'
        ? (payload as { title: string }).title.trim()
        : undefined;
      const scoreThreshold = typeof (payload as { scoreThreshold?: unknown }).scoreThreshold === 'number'
        ? (payload as { scoreThreshold: number }).scoreThreshold
        : undefined;

      result.push({
        id: `${toolName}:${relativePath}:${index}`,
        toolName,
        title,
        content,
        examples,
        scoreThreshold,
        updatedAt,
        filePath,
      });
    }

    return result;
  }

  /**
   * Get tool documentation for prompt building
   */
  getToolDocumentation(tools: LoadedTool[]): string {
    if (tools.length === 0) {
      return '## Tools\n\nNo tools available.';
    }

    const toolDocs = tools.map(tool => {
      const description = tool.config.description.trim();
      const embeddedSkillsNote = description && tool.skillEntries && tool.skillEntries.length > 0
        ? `\n\nThis tool also ships embedded retrieval skills for detailed usage guidance.`
        : '';
      return description
        ? `### ${tool.config.name}\n\n${description}${embeddedSkillsNote}`
        : `### ${tool.config.name}`;
    }).join('\n\n');

    return `## Tools.
${toolDocs}`;
  }
}

export default ToolLoader;
