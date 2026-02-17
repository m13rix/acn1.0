/**
 * Agents Tool
 * 
 * Thin wrapper around the core AgentRunner module.
 * Provides agent management (call, subAgent, newAgent, list).
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { join } from 'path';

import { runAgent, listAgents, loadAgent } from '../../src/core/AgentRunner.js';
import {
    getAgentDepth,
    getAgentSandbox,
    isStreamingEnabled,
    getCurrentAgent,
} from '../../src/core/AgentContext.js';
import { getAgentModelSwitchingConfig } from '../../src/core/AgentContext.js';
import { getGlobalDisplay } from '../../src/core/GlobalDisplay.js';
/**
 * Resolve a model name or description to a valid model ID using the registry.
 */
async function resolveModel(modelNameOrDescription: string): Promise<string> {
    const rootDir = process.env.PROJECT_ROOT || process.cwd();
    const registryPath = join(rootDir, 'data', 'models.json');
    const contextConfig = getAgentModelSwitchingConfig();

    if (!fs.existsSync(registryPath)) {
        console.warn(`[agents] Model registry not found at ${registryPath}. Using input as model ID.`);
        return modelNameOrDescription;
    }

    try {
        // Base config with defaults
        const baseConfig: SelectorConfig = {
            registryPath,
            mode: 'allow_all',
            selector: {
                provider: 'openrouter', // Use openrouter provider for selection
                model: 'openai/gpt-oss-20b', // Fast, cheap model
                apiKey: process.env.OPENROUTER_API_KEY
            }
        };

        // Merge with context config if available
        const config: SelectorConfig = {
            ...baseConfig,
            ...contextConfig,
            // Ensure registry path is always set fallback (context might not have it)
            registryPath: contextConfig?.registryPath || baseConfig.registryPath,
            // Merge selector config if present
            selector: {
                ...baseConfig.selector!,
                ...(contextConfig?.selector || {})
            }
        };

        const selected = await selectModel(modelNameOrDescription, config);
        // Default to ID, then name (as ID), then fallback to input
        return selected.id || selected.name || modelNameOrDescription;
    } catch (error) {
        console.warn(`[agents] Model selection failed (using strict input): ${error instanceof Error ? error.message : String(error)}`);
        return modelNameOrDescription;
    }
}

import { sendRequest } from '../srcAgent/index.js';
import { LocalSandbox } from '../../src/sandbox/LocalSandbox.js';
import { selectModel, SelectorConfig } from '../../src/services/model-selection/ModelSelector.js';

// ────────────────────────────────────────────────────────────────────────────
// SubAgent storage
// ────────────────────────────────────────────────────────────────────────────────

interface SubAgentConfig {
    name: string;
    description: string;
    systemPrompt: string;
    model: string;
    baseSystemPrompt?: string;
}

const SUBAGENTS_FILE = '.acn-subagents.json';
let subAgentsCache: Map<string, SubAgentConfig> | null = null;

/**
 * Get the path to the subagents storage file (in sandbox dir)
 */
function getSubAgentsFilePath(): string | null {
    const sandbox = getAgentSandbox();
    if (sandbox) return join(sandbox.directory, SUBAGENTS_FILE);

    const sandboxDir = process.env.SANDBOX_DIR;
    if (sandboxDir) return join(sandboxDir, SUBAGENTS_FILE);

    return null;
}

/**
 * Load subagents from file storage (with in-memory caching)
 */
function loadSubAgents(): Map<string, SubAgentConfig> {
    // Return cache if available
    if (subAgentsCache) return subAgentsCache;

    const filePath = getSubAgentsFilePath();
    if (!filePath || !fs.existsSync(filePath)) {
        subAgentsCache = new Map();
        return subAgentsCache;
    }

    try {
        const content = fs.readFileSync(filePath, 'utf-8');
        const data = JSON.parse(content) as Record<string, SubAgentConfig>;
        subAgentsCache = new Map(Object.entries(data));
        return subAgentsCache;
    } catch (error) {
        console.warn(`[agents] Failed to load subagents: ${error instanceof Error ? error.message : String(error)}`);
        subAgentsCache = new Map();
        return subAgentsCache;
    }
}

/**
 * Save subagents to file storage
 */
function saveSubAgents(subAgents: Map<string, SubAgentConfig>): void {
    const filePath = getSubAgentsFilePath();
    if (!filePath) {
        console.warn('[agents] Warning: No sandbox available, subagents will not persist');
        return;
    }

    const data: Record<string, SubAgentConfig> = {};
    for (const [name, config] of subAgents) {
        data[name] = config;
    }

    // Update cache
    subAgentsCache = subAgents;

    try {
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
    } catch (error) {
        console.warn(`[agents] Failed to save subagents to file: ${error instanceof Error ? error.message : String(error)}`);
    }
}



// ────────────────────────────────────────────────────────────────────────────
// Public API
// ────────────────────────────────────────────────────────────────────────────

/**
 * Create a session-exclusive sub-agent.
 * Sub-agents clone the calling agent with additive system prompt and a different model.
 * 
 * @param name - Unique name for this sub-agent
 * @param config - Sub-agent configuration
 * @returns Confirmation message
 */
export async function subAgent(name: string, config: {
    description: string;
    systemPrompt: string;
    model: string;
}): Promise<string> {
    const currentSubAgents = loadSubAgents();

    if (currentSubAgents.has(name)) {
        return `Sub-agent "${name}" already exists in this session.`;
    }

    // Resolve model description to actual model ID
    const resolvedModel = await resolveModel(config.model);

    // Check if the current agent has a subagent base prompt defined
    const currentAgent = getCurrentAgent();
    const baseSystemPrompt = currentAgent?.subagentPromptContent;

    const subAgentConfig: SubAgentConfig = {
        name,
        description: config.description,
        systemPrompt: config.systemPrompt,
        model: resolvedModel,
        baseSystemPrompt,
    };

    currentSubAgents.set(name, subAgentConfig);
    saveSubAgents(currentSubAgents);

    // Show creation in CLI
    const depth = getAgentDepth();
    const display = getGlobalDisplay();
    if (display) {
        display.showAgentCreation(name, resolvedModel, config.systemPrompt, depth);
    } else {
        console.log(`[agents] Created sub-agent: ${name} (Model: ${resolvedModel})`);
    }

    return `Created sub-agent: ${name} - ${config.description}`;
}

/**
 * Create a new permanent agent via Gemini CLI (srcAgent).
 * 
 * @param prompt - Description of the agent to create
 * @returns Result message from srcAgent
 */
export async function newAgent(prompt: string): Promise<string> {
    const depth = getAgentDepth();
    const display = getGlobalDisplay();

    if (display) {
        display.showAgentCreation('new_agent', 'gemini-cli', prompt, depth);
    } else {
        console.log(`[agents] Requesting creation of new agent: ${prompt}`);
    }

    try {
        const geminiPrompt = `Create a new agent. ${prompt}
 [GUIDE: HOW TO CREATE AGENTS IN THE SYSTEM. Every agent should be based on the 'core' agent - with the exact same prompts and config, so just duplicate that. After, you need to change the name, description, and most importantly - models. You need to pick the most fitting (in price and capabilities) for base models, as well as for model switching systems (it will allow the agent to pick the most fitting for some of the use cases. Important: basically the more varied this list - the better, and this list should also include the default model). To learn about the current models read ./current_models.md file. You also need to pick the 'skillsTable' - it is basically a dynamic library of advice that the agent can fill and later use. It is recommended to use for each of the agents ITS OWN TABLE. However, if you think that the agent may benefit from the learnings of other agents in the system, you can use their tables. You also need to specify tools the agent will be able to use. As you can see, there is a large variety of them. You need to choose only the ones the agent will actually use without missing anything (skills and files tools are added automatically). And - the most important - THE SYSTEM PROMPT. You should of course use the 'core' prompt as a foundation and change it or add new details and instructions as you wish, for example keeping the core directives and adding something new. This prompt will basically dictate all of the agents' behaviour, so design it as high-quality as possible]`;

        return await sendRequest(geminiPrompt);
    } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        return `Failed to create agent via srcAgent: ${errorMsg}`;
    }
}

/**
 * Call an agent or sub-agent by name.
 * Uses the exact same Session→Executor→Display pipeline as the CLI.
 * 
 * @param name - Agent name (from agents/ directory or a sub-agent)
 * @param request - Message to send to the agent
 * @returns Agent's response
 */
export async function call(name: string, request: string): Promise<string> {
    const parentDepth = getAgentDepth(); // Will be 0 in child process
    const stream = isStreamingEnabled();
    let sandbox = getAgentSandbox();

    // If no sandbox in context (running inside child process), try to attach 
    // to the sandbox directory from environment variable
    if (!sandbox && process.env.SANDBOX_DIR) {
        // Hydrate sandbox from environment (parent already created it)
        sandbox = new LocalSandbox({ existingPath: process.env.SANDBOX_DIR });

        // Mark it as initialized since it's an existing attached sandbox
        // We need to call initialize() to set the flag true, but with empty tools
        // since we are just using it to execute, not to install new tools
        // (Shared sandbox already has tools installed)
        await sandbox.initialize([], undefined);
    }

    if (!sandbox) {
        return `Error: No sandbox available. Cannot call agent "${name}" outside of an active session.`;
    }

    try {
        // ── Check if it's a sub-agent ──────────────────────────────────
        const currentSubAgents = loadSubAgents();
        if (currentSubAgents.has(name)) {
            const subConfig = currentSubAgents.get(name)!;

            // For sub-agents: load the CORE agent, apply sub-agent's prompt + model
            return await runAgent({
                agent: 'CORE',
                message: request,
                sandbox,
                parentDepth,
                extraSystemPrompt: subConfig.systemPrompt,
                stream,
                modelOverride: subConfig.model,
                systemPromptOverride: subConfig.baseSystemPrompt,
            });
        }

        // ── Call a regular agent ───────────────────────────────────────
        return await runAgent({
            agent: name,
            message: request,
            sandbox,
            parentDepth,
            stream,
        });

    } catch (error) {
        const errorMsg = error instanceof Error ? error.message : 'Unknown error';
        return `Error calling agent "${name}": ${errorMsg}`;
    }
}

/**
 * List all available agents and sub-agents.
 * 
 * @returns Formatted list of agents
 */
export async function list(): Promise<string> {
    const lines: string[] = [];

    // List agents from agents/ directory
    try {
        const agentNames = await listAgents();
        for (const agentName of agentNames) {
            const agent = await loadAgent(agentName);
            if (agent) {
                const desc = agent.config.description || 'No description';
                lines.push(`- ${agentName}: ${desc}`);
            }
        }
    } catch (error) {
        lines.push(`(Error loading agents: ${error instanceof Error ? error.message : 'unknown'})`);
    }

    // List session sub-agents
    const currentSubAgents = loadSubAgents();
    for (const [name, config] of currentSubAgents) {
        lines.push(`- ${name} [sub-agent]: ${config.description}`);
    }

    if (lines.length === 0) {
        return 'No agents available. Use agents.newAgent() to create one.';
    }

    return `Available agents:\n${lines.join('\n')}`;
}
