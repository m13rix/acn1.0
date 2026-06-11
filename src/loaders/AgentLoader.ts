/**
 * Agent Loader
 * 
 * Recursively scans the agents directory and loads agent configurations.
 */

import { readdir, readFile, stat } from 'fs/promises';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { parse as parseYaml } from 'yaml';
import { fileURLToPath } from 'url';
import { normalizeAgentConfig, validateAgentConfig } from './agent-config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Use PROJECT_ROOT from environment if available (for sandbox context)
// Fallback to __dirname calculation (src/loaders -> project root)
const calculatedRoot = join(__dirname, '..', '..');
const PROJECT_ROOT = process.env['TELOS_PROJECT_ROOT'] || process.env['PROJECT_ROOT']
  || (existsSync(join(calculatedRoot, 'agents')) ? calculatedRoot : process.cwd());
const DEFAULT_AGENTS_DIR = join(PROJECT_ROOT, 'agents');
import type { AgentConfig, LoadedAgent } from '../types/index.js';
import { resolveActionAutoFixConfig } from '../core/action-autofix/constants.js';



export class AgentLoader {
  private agentsDir: string;
  private cache: Map<string, LoadedAgent> = new Map();

  constructor(agentsDir?: string) {
    this.agentsDir = agentsDir || DEFAULT_AGENTS_DIR;
  }

  /**
   * Load all agents from the agents directory
   */
  async loadAll(): Promise<LoadedAgent[]> {
    const agents: LoadedAgent[] = [];
    await this.scanDirectory(this.agentsDir, agents);

    // Cache all loaded agents
    for (const agent of agents) {
      this.cache.set(agent.config.name, agent);
    }

    return agents;
  }

  /**
   * Load a specific agent by name
   */
  async loadByName(name: string): Promise<LoadedAgent | null> {
    // Check cache first
    if (this.cache.has(name)) {
      return this.cache.get(name)!;
    }

    // Load all and find
    const agents = await this.loadAll();
    return agents.find(a => a.config.name === name) || null;
  }

  /**
   * Get list of available agent names
   */
  async getAvailableAgents(): Promise<string[]> {
    const agents = await this.loadAll();
    return agents.map(a => a.config.name);
  }

  /**
   * Recursively scan directory for agent configs
   */
  private async scanDirectory(dir: string, agents: LoadedAgent[]): Promise<void> {
    try {
      const entries = await readdir(dir, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = join(dir, entry.name);

        if (entry.isDirectory()) {
          const agentConfig = await this.tryLoadAgentConfig(fullPath);
          if (agentConfig) {
            agents.push(agentConfig);
          }

          // Always recurse so nested agent trees remain discoverable.
          await this.scanDirectory(fullPath, agents);
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
   * Try to load an agent config from a directory
   */
  private async tryLoadAgentConfig(dir: string): Promise<LoadedAgent | null> {
    // Look for agent.yaml or agent.yml
    const configFiles = ['agent.yaml', 'agent.yml', 'agent.json'];

    for (const configFile of configFiles) {
      const configPath = join(dir, configFile);

      try {
        const configStat = await stat(configPath);
        if (configStat.isFile()) {
          const content = await readFile(configPath, 'utf-8');
          const parsedConfig = this.parseConfig(content, configFile) as AgentConfig;
          const config = normalizeAgentConfig(parsedConfig);

          // Validate required fields
          if (!config.name || !config.model || !config.systemPrompt) {
            console.warn(`Warning: Agent config in ${dir} missing required fields (name, model, systemPrompt)`);
            continue;
          }
          validateAgentConfig(config);

          // Apply defaults
          config.tools = config.tools || [];
          if ((config.modality || 'text') === 'text') {
            config.loop = 'provider-tools';
            config.syntax = 'markdown';
          } else {
            config.loop = config.loop || 'provider-tools';
            config.syntax = config.syntax || 'markdown';
          }
          config.injectAgentsList = config.injectAgentsList ?? true;
          config.actionAutoFix = resolveActionAutoFixConfig(config.actionAutoFix);

          // Load system prompt content
          let systemPromptContent = '';
          const systemPromptPath = join(dir, config.systemPrompt);
          try {
            systemPromptContent = await readFile(systemPromptPath, 'utf-8');
          } catch {
            console.warn(`Warning: Could not load system prompt ${systemPromptPath}`);
          }

          // Load subagent prompt content if specified
          let subagentPromptContent: string | undefined;
          if (config.subagentPrompt) {
            const subagentPromptPath = join(dir, config.subagentPrompt);
            try {
              subagentPromptContent = await readFile(subagentPromptPath, 'utf-8');
            } catch {
              console.warn(`Warning: Could not load subagent prompt ${subagentPromptPath}`);
            }
          }

          return {
            config,
            systemPromptContent,
            subagentPromptContent,
            directory: dir,
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
}

export default AgentLoader;
