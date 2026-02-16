/**
 * Tool Loader
 *
 * Recursively scans the tools directory and loads tool configurations.
 */

import { readdir, readFile, stat } from 'fs/promises';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { parse as parseYaml } from 'yaml';
import { fileURLToPath } from 'url';
import type { ToolConfig, LoadedTool } from '../types/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Use PROJECT_ROOT from environment if available (for sandbox context)
// Fallback to __dirname calculation, then to hardcoded path
const calculatedRoot = join(__dirname, '..', '..');
const PROJECT_ROOT = process.env['PROJECT_ROOT']
  || (existsSync(join(calculatedRoot, 'tools')) ? calculatedRoot : 'G:\\agent0\\acn1.0');
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
          // Check if this directory contains a tool config
          const toolConfig = await this.tryLoadToolConfig(fullPath);
          if (toolConfig) {
            tools.push(toolConfig);
          } else {
            // Recurse into subdirectory
            await this.scanDirectory(fullPath, tools);
          }
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

          // Validate required fields
          if (!config.name || !config.description) {
            console.warn(`Warning: Tool config in ${dir} missing required fields`);
            continue;
          }

          // Default module to index.ts
          config.module = config.module || 'index.ts';

          // Resolve the absolute path to the module
          const absolutePath = join(dir, config.module);

          return {
            config,
            directory: dir,
            absolutePath,
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

  /**
   * Get tool documentation for prompt building
   */
  getToolDocumentation(tools: LoadedTool[]): string {
    if (tools.length === 0) {
      return '## Tools\n\nNo tools available.';
    }

    const toolDocs = tools.map(tool => {
      return `### ${tool.config.name}\n\n${tool.config.description}`;
    }).join('\n\n');

    return `## Tools.
${toolDocs}`;
  }
}

export default ToolLoader;
