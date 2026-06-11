/**
 * Agents Tool
 *
 * Thin wrapper around the core AgentRunner module.
 * Provides agent management (call, subAgent, newAgent, list).
 */

import * as fs from 'fs';
import { join } from 'path';

import { listAgents, loadAgent } from '../../src/core/AgentRunner.js';
import { getAgentInvocationService } from '../../src/core/AgentInvocationService.js';
import { runInSandboxCallQueue } from '../../src/core/AgentCallQueue.js';
import {
    getAgentDepth,
    getAgentSandbox,
    isStreamingEnabled,
    getCurrentAgent,
} from '../../src/core/AgentContext.js';
import { getGlobalDisplay } from '../../src/core/GlobalDisplay.js';
import type { LoadedAgent } from '../../src/types/index.js';
import type { AgentInstructionAlgorithmConfig } from '../../src/types/index.js';
import type { NotDiamondRoutingResult } from '../../src/services/model-selection/NotDiamondRouter.js';

const SUBAGENT_SCOPE_SEPARATOR = '::';
const AGENT_CALL_QUEUE_NOTICE = 'Parallel agents.call detected; call was queued and executed sequentially.';

function normaliseModelId(model: string): string {
    return stripInlineAlias(model).trim().toLowerCase();
}

function stripInlineAlias(model: string): string {
    const text = String(model || '').trim();
    const match = text.match(/^(.*?)\s*\[[^\]]+\]\s*$/);
    return (match ? match[1] : text).trim();
}

function buildScopedSubAgentKey(name: string, parentAgentName?: string): string {
    if (!parentAgentName) {
        return name;
    }
    return `${parentAgentName}${SUBAGENT_SCOPE_SEPARATOR}${name}`;
}

async function loadAgentCaseInsensitive(name: string): Promise<LoadedAgent | undefined> {
    const direct = await loadAgent(name);
    if (direct) {
        return direct;
    }

    const available = await listAgents();
    const match = available.find(agentName => agentName.toLowerCase() === name.toLowerCase());
    if (!match) {
        return undefined;
    }

    return (await loadAgent(match)) || undefined;
}

function isModelAllowedForAgent(model: string, agent: LoadedAgent): boolean {
    const switching = agent.config.modelSwitching;
    if (switching?.mode !== 'whitelist') {
        return true;
    }

    const whitelist = Array.isArray(switching.whitelist) ? switching.whitelist : [];
    if (whitelist.length === 0) {
        return normaliseModelId(model) === normaliseModelId(agent.config.model);
    }

    const normalizedModel = normaliseModelId(model);
    return whitelist.some(item => normaliseModelId(item) === normalizedModel);
}

function getSafeFallbackModel(agent: LoadedAgent): string {
    const switching = agent.config.modelSwitching;
    const whitelist = Array.isArray(switching?.whitelist) ? switching!.whitelist! : [];

    if (switching?.mode === 'whitelist' && whitelist.length > 0) {
        const defaultModel = agent.config.model;
        const hasDefault = whitelist.some(item => normaliseModelId(item) === normaliseModelId(defaultModel));
        return hasDefault ? defaultModel : whitelist[0]!;
    }

    return agent.config.model;
}

function summarizeAgentResult(result: string): string {
    const text = String(result || '').trim().replace(/\s+/g, ' ');
    if (!text) {
        return '(empty response)';
    }
    return text.length > 160 ? `${text.slice(0, 160)}...` : text;
}

import { sendRequest } from '../srcAgent/index.js';
import { LocalSandbox } from '../../src/sandbox/LocalSandbox.js';
import { normalizeAgentRequest } from './request.js';
import { actionContext } from '../../src/core/ActionContext.js';
import { buildAgentCallTextResult, readAgentTextLog } from '../../src/core/agentTextLog.js';
import type { SessionSnapshot } from '../../src/core/Session.js';
import {
    readPersistedAgentSessionState,
    writePersistedAgentSessionState,
    type AgentResumeDescriptor,
} from '../../src/core/agentResumeState.js';

/**
 * Get the calling agent's LoadedAgent — works across process boundaries.
 * 1. Tries AsyncLocalStorage context (same process)
 * 2. Falls back to TELOS_AGENT_NAME env var (child process)
 */
async function getCallingAgent(): Promise<LoadedAgent | undefined> {
    // 1. Try AsyncLocalStorage (works in same process)
    const fromContext = getCurrentAgent();
    if (fromContext) return fromContext;

    // 2. Fallback: load from env var (works across process boundary)
    const agentName = (process.env.TELOS_AGENT_NAME || '').trim();
    if (agentName) {
        const loaded = await loadAgentCaseInsensitive(agentName);
        return loaded || undefined;
    }

    return undefined;
}

// ────────────────────────────────────────────────────────────────────────────
// SubAgent storage
// ────────────────────────────────────────────────────────────────────────────────

interface SubAgentConfig {
    name: string;
    description: string;
    systemPrompt: string;
    /** "auto" by default, or a Not Diamond/local model name requested by the agent. */
    model?: string;
    /** Concrete execution model selected on the first request. */
    selectedModel?: string;
    selectedProvider?: string;
    notDiamondModel?: string;
    notDiamondSessionId?: string;
    instructionAlgorithm?: AgentInstructionAlgorithmConfig | false;
    baseSystemPrompt?: string;
    /** Name of the agent that created this sub-agent (used as base config) */
    parentAgentName?: string;
}

const SUBAGENTS_FILE = '.telos-subagents.json';
const LAST_AGENT_SESSION_FILE = '.telos-last-agent-session.json';
let subAgentsCache: Map<string, SubAgentConfig> | null = null;

async function resolveActiveSandbox(): Promise<LocalSandbox | undefined> {
    let sandbox = getAgentSandbox();

    if (!sandbox && process.env.SANDBOX_DIR) {
        sandbox = new LocalSandbox({ existingPath: process.env.SANDBOX_DIR });
        await sandbox.initialize([], undefined);
    }

    return sandbox as LocalSandbox | undefined;
}

async function runNamedAgentInCurrentSandbox(options: {
    agent: string | LoadedAgent;
    request: string;
    parentDepth: number;
    stream: boolean;
    interfaceOverride?: string;
    extraSystemPrompt?: string;
    modelOverride?: string;
    providerOverride?: string;
    systemPromptOverride?: string;
    instructionAlgorithmOverride?: AgentInstructionAlgorithmConfig | false;
    isSubagent?: boolean;
    queueNotice?: string;
    resumeSnapshot?: SessionSnapshot;
    resumeDescriptor?: AgentResumeDescriptor;
    onModelRouted?: (result: NotDiamondRoutingResult) => void | Promise<void>;
}): Promise<string> {
    const sandbox = await resolveActiveSandbox();
    if (!sandbox) {
        const label = typeof options.agent === 'string' ? options.agent : options.agent.config.name;
        return `Error: No sandbox available. Cannot call agent "${label}" outside of an active session.`;
    }

    const sandboxKey = sandbox.directory;
    const textLogPath = join(
        sandbox.directory,
        `.telos-agent-call-text-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.jsonl`
    );
    const parentActionStore = actionContext.getStore();
    const routeEnv = {
        ...(parentActionStore?.env || {}),
        TELOS_TEXT_LOG_PATH: textLogPath,
    };
    const resumeStatePath = join(sandbox.directory, LAST_AGENT_SESSION_FILE);

    const queued = await runInSandboxCallQueue(sandboxKey, async () => {
        const invoke = () => getAgentInvocationService().callAgent({
            agent: options.agent,
            message: options.request,
            sandbox,
            parentDepth: options.parentDepth,
            extraSystemPrompt: options.extraSystemPrompt,
            stream: options.stream,
            modelOverride: options.modelOverride,
            providerOverride: options.providerOverride,
            systemPromptOverride: options.systemPromptOverride,
            instructionAlgorithmOverride: options.instructionAlgorithmOverride,
            isSubagent: options.isSubagent,
            interface: options.interfaceOverride,
            routeEnv,
            restoreSnapshot: options.resumeSnapshot,
            onSessionSnapshot: async (snapshot) => {
                if (!options.resumeDescriptor) {
                    return;
                }
                await writePersistedAgentSessionState(resumeStatePath, {
                    version: 1,
                    savedAt: new Date().toISOString(),
                    descriptor: options.resumeDescriptor,
                    snapshot,
                });
            },
            onModelRouted: async (result) => {
                await options.onModelRouted?.(result);
            },
        });

        return parentActionStore
            ? actionContext.run({ ...parentActionStore, env: routeEnv }, invoke)
            : actionContext.run({ env: routeEnv }, invoke);
    });

    const textEntries = await readAgentTextLog(textLogPath);
    const aggregatedResult = buildAgentCallTextResult(textEntries, queued.value);

    return queued.waited
        ? `${options.queueNotice || AGENT_CALL_QUEUE_NOTICE}\n\n${aggregatedResult}`
        : aggregatedResult;
}

function buildStandardResumeDescriptor(name: string, interfaceOverride?: string): AgentResumeDescriptor {
    return {
        label: name,
        agent: name,
        interfaceOverride,
        isSubagent: true,
    };
}

function buildSubagentResumeDescriptor(name: string, subConfig: SubAgentConfig, interfaceOverride?: string): AgentResumeDescriptor {
    return {
        label: name,
        agent: subConfig.parentAgentName || 'CORE',
        extraSystemPrompt: subConfig.systemPrompt,
        modelOverride: subConfig.selectedModel || subConfig.model || 'auto',
        providerOverride: subConfig.selectedProvider,
        systemPromptOverride: subConfig.baseSystemPrompt,
        instructionAlgorithmOverride: subConfig.instructionAlgorithm,
        interfaceOverride,
        isSubagent: true,
    };
}

async function getLastAgentSessionState() {
    const sandbox = await resolveActiveSandbox();
    if (!sandbox) {
        return null;
    }

    return readPersistedAgentSessionState(join(sandbox.directory, LAST_AGENT_SESSION_FILE));
}

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
    model?: string;
    instructionAlgorithm?: AgentInstructionAlgorithmConfig | false;
}): Promise<string> {
    const currentSubAgents = loadSubAgents();
    const currentAgent = await getCallingAgent();
    if (!currentAgent) {
        return `Error: Unable to resolve calling agent context for sub-agent "${name}".`;
    }

    const scopedKey = buildScopedSubAgentKey(name, currentAgent.config.name);
    if (currentSubAgents.has(scopedKey)) {
        return `Sub-agent "${name}" already exists in this session.`;
    }

    const requestedModel = stripInlineAlias(config.model || 'auto') || 'auto';

    // Check if the current agent has a subagent base prompt defined
    const baseSystemPrompt = currentAgent?.subagentPromptContent;
    const parentAgentName = currentAgent?.config?.name;

    const subAgentConfig: SubAgentConfig = {
        name,
        description: config.description,
        systemPrompt: config.systemPrompt,
        model: requestedModel,
        instructionAlgorithm: typeof config.instructionAlgorithm === 'undefined'
            ? currentAgent.config.subagentInstructionAlgorithm
            : config.instructionAlgorithm,
        baseSystemPrompt,
        parentAgentName,
    };

    currentSubAgents.set(scopedKey, subAgentConfig);
    saveSubAgents(currentSubAgents);

    // Show creation in CLI
    const depth = getAgentDepth();
    const display = getGlobalDisplay();
    if (display) {
        display.showAgentCreation(name, requestedModel, config.systemPrompt, depth);
    } else {
        console.log(`[agents] Created sub-agent: ${name} (Model: ${requestedModel})`);
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
 [GUIDE: HOW TO CREATE AGENTS IN THE SYSTEM. Every agent should be based on the 'core' agent - with the exact same prompts and config, so just duplicate that. After, change the name, description, tools, and system prompt. Keep modelSwitching focused on allowed Not Diamond routing candidates: use whitelist/blacklist/allow_all with model names from ./data/model-switching/notdiamond-models.json, and for provider-specific local names use ./data/model-switching/aliases.json or inline entries like gpt-5.4-mini[openai/gpt-5.4-mini]. Do not build a custom model-description library. Sub-agents default to model: auto and the first request is routed by Not Diamond using the assembled prompt and user request. Memory is added automatically unless explicitly disabled, so you normally should not add any separate legacy memory tools. Use memory entries with exclusive=true for agent-private reusable know-how and shared memory for cross-agent knowledge. Choose only the tools the agent will actually use without missing anything (memory and files tools are added automatically). And - the most important - THE SYSTEM PROMPT. You should of course use the 'core' prompt as a foundation and change it or add new details and instructions as you wish, for example keeping the core directives and adding something new. This prompt will basically dictate all of the agents' behaviour, so design it as high-quality as possible]`;

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
export async function call(name: string, request: unknown, options?: { interface?: string }): Promise<string> {
    const parentDepth = getAgentDepth(); // Will be 0 in child process
    const stream = isStreamingEnabled();
    const currentAgent = await getCallingAgent();
    const normalizedRequest = normalizeAgentRequest(request, 'call');

    try {
        const currentSubAgents = loadSubAgents();
        const scopedKey = currentAgent ? buildScopedSubAgentKey(name, currentAgent.config.name) : name;
        let resolvedKey: string | null = null;
        let subConfig: SubAgentConfig | undefined;

        if (currentSubAgents.has(scopedKey)) {
            resolvedKey = scopedKey;
            subConfig = currentSubAgents.get(scopedKey);
        } else if (currentSubAgents.has(name)) {
            resolvedKey = name;
            subConfig = currentSubAgents.get(name);
        } else {
            const matches = Array.from(currentSubAgents.entries()).filter(([, cfg]) => cfg.name === name);
            if (matches.length === 1) {
                resolvedKey = matches[0]![0];
                subConfig = matches[0]![1];
            } else if (matches.length > 1) {
                const variants = matches.map(([, cfg]) => cfg.parentAgentName || 'unknown').join(', ');
                return `Error: Sub-agent "${name}" is ambiguous in this session (parents: ${variants}).`;
            }
        }

        if (subConfig && resolvedKey) {
            // Self-heal legacy entries that had no parent metadata.
            if (!subConfig.parentAgentName && currentAgent) {
                subConfig.parentAgentName = currentAgent.config.name;
                if (!subConfig.baseSystemPrompt) {
                    subConfig.baseSystemPrompt = currentAgent.subagentPromptContent;
                }

                const migratedKey = buildScopedSubAgentKey(subConfig.name, subConfig.parentAgentName);
                if (migratedKey !== resolvedKey) {
                    currentSubAgents.delete(resolvedKey);
                    currentSubAgents.set(migratedKey, subConfig);
                    resolvedKey = migratedKey;
                }
                saveSubAgents(currentSubAgents);
            }

            const baseAgent = subConfig.parentAgentName || 'CORE';
            const requestedModel = subConfig.selectedModel || subConfig.model || 'auto';
            const selectedProvider = subConfig.selectedProvider;

            const baseAgentConfig = currentAgent && currentAgent.config.name === baseAgent
                ? currentAgent
                : await loadAgentCaseInsensitive(baseAgent);
            if (
                baseAgentConfig
                && !selectedProvider
                && requestedModel.toLowerCase() !== 'auto'
                && !isModelAllowedForAgent(requestedModel, baseAgentConfig)
            ) {
                const safeFallback = getSafeFallbackModel(baseAgentConfig);
                console.warn(`[agents] Sub-agent "${name}" model "${requestedModel}" is outside whitelist for ${baseAgent}. Using "${safeFallback}".`);
                subConfig.model = safeFallback;
                currentSubAgents.set(resolvedKey, subConfig);
                saveSubAgents(currentSubAgents);
            }
            const modelOverride = subConfig.selectedModel || subConfig.model || 'auto';

            const result = await runNamedAgentInCurrentSandbox({
                agent: baseAgent,
                request: normalizedRequest,
                parentDepth,
                stream,
                interfaceOverride: options?.interface,
                extraSystemPrompt: subConfig.systemPrompt,
                modelOverride,
                providerOverride: selectedProvider,
                systemPromptOverride: subConfig.baseSystemPrompt,
                instructionAlgorithmOverride: subConfig.instructionAlgorithm,
                isSubagent: true,
                resumeDescriptor: buildSubagentResumeDescriptor(name, subConfig, options?.interface),
                onModelRouted: async (routingResult) => {
                    subConfig.selectedModel = routingResult.executionModel;
                    subConfig.selectedProvider = routingResult.executionProvider;
                    subConfig.notDiamondModel = routingResult.notDiamondModel;
                    subConfig.notDiamondSessionId = routingResult.notDiamondSessionId;
                    currentSubAgents.set(resolvedKey!, subConfig!);
                    saveSubAgents(currentSubAgents);
                },
            });
            console.error(`[agents] call("${name}") completed: ${summarizeAgentResult(result)}`);
            return result;
        }

        const result = await runNamedAgentInCurrentSandbox({
            agent: name,
            request: normalizedRequest,
            parentDepth,
            stream,
            interfaceOverride: options?.interface,
            isSubagent: true,
            resumeDescriptor: buildStandardResumeDescriptor(name, options?.interface),
        });
        console.error(`[agents] call("${name}") completed: ${summarizeAgentResult(result)}`);
        return result;

    } catch (error) {
        const errorMsg = error instanceof Error ? error.message : 'Unknown error';
        return `Error calling agent "${name}": ${errorMsg}`;
    }
}

/**
 * Continue the most recent agents.call session in the current sandbox.
 *
 * @param request - Message to send into the last agent session
 * @returns Agent response stacked like agents.call
 */
export async function resume(request: unknown): Promise<string> {
    const normalizedRequest = normalizeAgentRequest(request, 'resume');
    const parentDepth = getAgentDepth();
    const stream = isStreamingEnabled();

    try {
        const state = await getLastAgentSessionState();
        if (!state) {
            return 'Error: No previous agents.call session found to resume in this sandbox.';
        }

        const result = await runNamedAgentInCurrentSandbox({
            agent: state.descriptor.agent,
            request: normalizedRequest,
            parentDepth,
            stream,
            interfaceOverride: state.descriptor.interfaceOverride,
            extraSystemPrompt: state.descriptor.extraSystemPrompt,
            modelOverride: state.descriptor.modelOverride,
            providerOverride: state.descriptor.providerOverride,
            systemPromptOverride: state.descriptor.systemPromptOverride,
            instructionAlgorithmOverride: state.descriptor.instructionAlgorithmOverride,
            isSubagent: state.descriptor.isSubagent,
            resumeSnapshot: state.snapshot,
            resumeDescriptor: state.descriptor,
        });

        console.error(`[agents] resume("${state.descriptor.label}") completed: ${summarizeAgentResult(result)}`);
        return result;
    } catch (error) {
        const errorMsg = error instanceof Error ? error.message : 'Unknown error';
        return `Error resuming agent session: ${errorMsg}`;
    }
}

/**
 * Call the current agent again using the same execution pipeline as agents.call().
 * Falls back to TELOS_AGENT_NAME when running from heartbeat/background action code.
 */
export async function callSelf(request: unknown): Promise<string> {
    const currentAgent = await getCallingAgent();
    const selfName = currentAgent?.config.name || (process.env.TELOS_AGENT_NAME || '').trim();
    const normalizedRequest = normalizeAgentRequest(request, 'callSelf');

    if (!selfName) {
        return 'Error: Unable to resolve the current agent for agents.callSelf().';
    }

    try {
        console.error(`[agents] callSelf invoked for "${selfName}" from heartbeat/background context.`);
        const result = await runNamedAgentInCurrentSandbox({
            agent: currentAgent || selfName,
            request: normalizedRequest,
            parentDepth: getAgentDepth(),
            stream: isStreamingEnabled(),
            isSubagent: false,
            queueNotice: 'Parallel agents.callSelf detected; call was queued and executed sequentially.',
        });
        console.error(`[agents] callSelf completed for "${selfName}": ${summarizeAgentResult(result)}`);
        return result;
    } catch (error) {
        const errorMsg = error instanceof Error ? error.message : 'Unknown error';
        return `Error calling self agent "${selfName}": ${errorMsg}`;
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
    for (const [, config] of currentSubAgents) {
        const parent = config.parentAgentName || 'unknown';
        lines.push(`- ${config.name} [sub-agent by ${parent}]: ${config.description}`);
    }

    if (lines.length === 0) {
        return 'No agents available. Use agents.newAgent() to create one.';
    }

    return `Available agents:\n${lines.join('\n')}`;
}
