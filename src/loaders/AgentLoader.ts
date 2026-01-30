/**
 * Agent Loader
 * 
 * Recursively scans the agents directory and loads agent configurations.
 */

import { readdir, readFile, stat } from 'fs/promises';
import { join, dirname } from 'path';
import { parse as parseYaml } from 'yaml';
import { fileURLToPath } from 'url';
import type { AgentConfig, LoadedAgent } from '../types/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..', '..');
const DEFAULT_AGENTS_DIR = join(PROJECT_ROOT, 'agents');

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
          // Check if this directory contains an agent config
          const agentConfig = await this.tryLoadAgentConfig(fullPath);
          if (agentConfig) {
            agents.push(agentConfig);
          } else {
            // Recurse into subdirectory
            await this.scanDirectory(fullPath, agents);
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
          const config = this.parseConfig(content, configFile) as AgentConfig;

          // Validate required fields
          // If planner/executor defined, legacy model/systemPrompt not strictly required
          const isDualLayer = !!config.planner && !!config.executor;
          if (!isDualLayer && (!config.name || !config.model || !config.systemPrompt)) {
            console.warn(`Warning: Agent config in ${dir} missing required fields (name, model, systemPrompt)`);
            continue;
          }
          if (isDualLayer && !config.name) {
            console.warn(`Warning: Agent config in ${dir} missing name`);
            continue;
          }

          // Apply defaults
          config.tools = config.tools || [];
          config.loop = config.loop || 'accumulator';
          config.syntax = config.syntax || 'xml-tags';

          // Load system prompt content
          let systemPromptContent = '';
          if (config.systemPrompt) {
            const systemPromptPath = join(dir, config.systemPrompt);
            try {
              systemPromptContent = await readFile(systemPromptPath, 'utf-8');
            } catch {
              console.warn(`Warning: Could not load system prompt ${systemPromptPath}`);
            }
          }

          let plannerSystemPromptContent = '';
          if (config.planner?.systemPrompt) {
            const p = join(dir, config.planner.systemPrompt);
            try {
              plannerSystemPromptContent = await readFile(p, 'utf-8');
            } catch {
              console.warn(`Warning: Could not load planner system prompt ${p}`);
            }
          }

          let executorSystemPromptContent = '';
          if (config.executor?.systemPrompt) {
            const p = join(dir, config.executor.systemPrompt);
            try {
              executorSystemPromptContent = await readFile(p, 'utf-8');
            } catch {
              console.warn(`Warning: Could not load executor system prompt ${p}`);
            }
          }

          return {
            config,
            systemPromptContent,
            plannerSystemPromptContent,
            executorSystemPromptContent,
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
