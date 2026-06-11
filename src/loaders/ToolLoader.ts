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
const PROJECT_ROOT = process.env['TELOS_PROJECT_ROOT'] || process.env['PROJECT_ROOT']
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
          return {
            config,
            directory: dir,
            absolutePath,
            skillEntries: [],
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
    void config;
    void toolDir;
    return [];
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
      return '## Tool Modules\n\nNo tool modules are available.';
    }

    const toolDocs = tools.map(tool => {
      const description = this.compactToolDescription(tool.config.description);
      const relativeToolDoc = relative(this.toolsDir, join(tool.directory, 'tool.yaml')).replace(/\\/g, '/');
      const pathHint = `tools/${relativeToolDoc}`;
      return description
        ? `- \`${tool.config.name}\`: ${description} Full API: \`${pathHint}\`.`
        : `- \`${tool.config.name}\`: module available. Full API: \`${pathHint}\`.`;
    }).join('\n');

    return `## Tool Modules

Use these TypeScript modules inside \`action(content)\`; they are already available as globals. Keep calls focused and print useful results with \`console.log(...)\`.

${toolDocs}

For exact method signatures or uncommon options, read only the needed module doc from \`process.env.PROJECT_ROOT || process.cwd()\`, for example \`tools/search/tool.yaml\`. Do not load every tool doc up front.`;
  }

  private compactToolDescription(description: string): string {
    const normalizedLines = description
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean)
      .filter(line => !line.startsWith('```'));
    const methodLines = normalizedLines
      .filter(line => /^-?\s*`?[A-Za-z0-9_.]+\(/.test(line.replace(/^-\s*/, '')))
      .slice(0, 6)
      .map(line => line.replace(/^-\s*/, '').replace(/`/g, '').split(/\s+-\s+|\s+->\s+|:/)[0]?.trim())
      .filter(Boolean);

    const lead = normalizedLines
      .find(line => !line.startsWith('-') && !line.toLowerCase().startsWith('example'))
      || normalizedLines[0]
      || '';
    const summary = lead.length > 180 ? `${lead.slice(0, 177)}...` : lead;

    if (methodLines.length === 0) {
      return summary;
    }

    return `${summary} Key methods: ${Array.from(new Set(methodLines)).join(', ')}.`;
  }
}

export default ToolLoader;
