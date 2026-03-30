/**
 * AgentRunner
 * 
 * Central module for running agents. Provides a single `runAgent()` function
 * that creates a fresh Session (with shared sandbox) and Executor, then
 * executes a message — using the **exact same** pipeline and display as
 * the CLI chat loop.
 * 
 * Used by the `agents` tool to call/sub-call agents.
 */

import { AgentLoader } from '../loaders/AgentLoader.js';
import { ToolLoader } from '../loaders/ToolLoader.js';
import { Session } from './Session.js';
import { Executor, type ExecutorCallbacks } from './Executor.js';
import { getProvider } from '../providers/index.js';
import { getSyntax } from '../syntax/index.js';
import { getLoop } from '../loops/index.js';
import { runWithAgentContext } from './AgentContext.js';
import { getGlobalDisplay } from './GlobalDisplay.js';
import { StreamDisplay, COLORS, SYMBOLS, getLineContinuation } from '../cli/display.js';
import type { ISandbox } from '../sandbox/interfaces.js';
import type { LoadedAgent } from '../types/index.js';

// Shared loader instances (singleton-like, safe to reuse)
// Shared loader instances (singleton-like, safe to reuse)
const toolLoader = new ToolLoader();

interface UiBridgePayload {
    event: string;
    accumulated?: string;
    text?: string;
    code?: string;
    command?: string;
    filename?: string;
    content?: string;
    agentName?: string;
}

const UI_BRIDGE_LIMITS: Partial<Record<keyof UiBridgePayload, number>> = {
    accumulated: 20000,
    text: 24000,
    code: 12000,
    command: 4000,
    filename: 500,
    content: 24000,
    agentName: 200,
};

function truncateUiBridgeValue(value: string, maxChars: number, label: string): string {
    if (value.length <= maxChars) {
        return value;
    }

    const reserved = Math.min(220, Math.max(100, Math.floor(maxChars * 0.18)));
    const headLength = Math.max(0, Math.floor((maxChars - reserved) * 0.75));
    const tailLength = Math.max(0, maxChars - reserved - headLength);
    const removed = value.length - headLength - tailLength;
    const notice = `\n\n[${label} truncated: removed ${removed} chars]\n\n`;
    return `${value.slice(0, headLength)}${notice}${value.slice(value.length - tailLength)}`;
}

function sanitizeUiBridgePayload(payload: UiBridgePayload): UiBridgePayload {
    const sanitized: UiBridgePayload = { ...payload };

    for (const [key, limit] of Object.entries(UI_BRIDGE_LIMITS) as Array<[keyof UiBridgePayload, number]>) {
        const value = sanitized[key];
        if (typeof value === 'string') {
            sanitized[key] = truncateUiBridgeValue(value, limit, String(key)) as never;
        }
    }

    return sanitized;
}

function createTelegramUiBridge(scopeId: string, agentName: string): ExecutorCallbacks | null {
    const apiUrl = process.env.ACN_API_URL;
    const chatId = process.env.ACN_CHAT_ID;

    if (!apiUrl || !chatId) {
        return null;
    }

    let queue = Promise.resolve();
    const post = (payload: UiBridgePayload): void => {
        const sanitizedPayload = sanitizeUiBridgePayload(payload);
        queue = queue
            .then(async () => {
                const response = await fetch(`${apiUrl}/api/ui/event`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        chatId,
                        scopeId,
                        agentName,
                        ...sanitizedPayload,
                    }),
                });
                if (!response.ok) {
                    const errorText = await response.text();
                    throw new Error(errorText || `HTTP ${response.status}`);
                }
            })
            .catch((error) => {
                console.warn(`[AgentRunner] Failed to forward UI event "${sanitizedPayload.event}":`, error);
            });
    };

    return {
        onBeforeProviderCall: () => post({ event: 'executor.before_provider_call' }),
        onReasoningDelta: (_delta, accumulated) => post({ event: 'executor.reasoning_delta', accumulated }),
        onTextDelta: (_delta, accumulated) => post({ event: 'executor.text_delta', accumulated }),
        onTextDone: (text) => post({ event: 'executor.text_done', text }),
        onAction: (code) => post({ event: 'executor.action', code }),
        onCli: (command) => post({ event: 'executor.cli', command }),
        onFile: (filename, content) => post({ event: 'executor.file', filename, content }),
        onObservation: (content) => post({ event: 'executor.observation', content }),
        onResponse: (content) => post({ event: 'executor.response', content }),
    };
}

function composeCallbacks(...callbackSets: Array<ExecutorCallbacks | null | undefined>): ExecutorCallbacks {
    const sets = callbackSets.filter(Boolean) as ExecutorCallbacks[];
    if (sets.length === 0) {
        return {};
    }

    return {
        onReasoningDelta: (delta, accumulated) => {
            for (const set of sets) set.onReasoningDelta?.(delta, accumulated);
        },
        onReasoningDone: (fullReasoning) => {
            for (const set of sets) set.onReasoningDone?.(fullReasoning);
        },
        onTextDelta: (delta, accumulated) => {
            for (const set of sets) set.onTextDelta?.(delta, accumulated);
        },
        onTextDone: (fullText) => {
            for (const set of sets) set.onTextDone?.(fullText);
        },
        onThinking: (content) => {
            for (const set of sets) set.onThinking?.(content);
        },
        onAction: (code) => {
            for (const set of sets) set.onAction?.(code);
        },
        onCli: (command) => {
            for (const set of sets) set.onCli?.(command);
        },
        onFile: (filename, content) => {
            for (const set of sets) set.onFile?.(filename, content);
        },
        onObservation: (output) => {
            for (const set of sets) set.onObservation?.(output);
        },
        onResponse: (content) => {
            for (const set of sets) set.onResponse?.(content);
        },
        onError: (error) => {
            for (const set of sets) set.onError?.(error);
        },
        onBeforeProviderCall: (messages, config, actualRequest) => {
            for (const set of sets) set.onBeforeProviderCall?.(messages, config, actualRequest);
        },
        onSkillsRetrieved: (content, score) => {
            for (const set of sets) set.onSkillsRetrieved?.(content, score);
        },
        onSkillsSearched: (topScore) => {
            for (const set of sets) set.onSkillsSearched?.(topScore);
        },
        onStreamChunk: (delta, accumulated) => {
            for (const set of sets) set.onStreamChunk?.(delta, accumulated);
        },
    };
}

/**
 * Options for running an agent
 */
export interface RunAgentOptions {
    /** Agent name (must exist in agents/ directory) OR a LoadedAgent object */
    agent: string | LoadedAgent;
    /** User message to send to the agent */
    message: string;
    /** Shared sandbox from the calling agent */
    sandbox: ISandbox;
    /** Current nesting depth of the caller (default: 0) */
    parentDepth?: number;
    /** Extra text prepended to the agent's system prompt (for subAgents) */
    extraSystemPrompt?: string;
    /** Whether to use streaming (inherited from parent, default: true) */
    stream?: boolean;
    /** Override model for the agent (used by subAgent with model switching) */
    modelOverride?: string;
    /** Completely replace system prompt (for sub-agents) */
    systemPromptOverride?: string;
    /** Whether this agent is being run as a sub-agent (disables skills to prevent infinite loops) */
    isSubagent?: boolean;
}

/**
 * Run an agent with the exact same Session→Executor→Display pipeline as the CLI.
 *
 * @param options - Configuration for the agent run
 * @returns The raw response from the agent (not stripped/cleaned)
 */
export async function runAgent(options: RunAgentOptions): Promise<string> {
    const {
        message,
        sandbox,
        parentDepth = 0,
        extraSystemPrompt,
        systemPromptOverride,
        stream = true,
        modelOverride,
    } = options;

    const childDepth = parentDepth + 1;
    const display = getGlobalDisplay() || new StreamDisplay();

    // ── 1. Load agent ──────────────────────────────────────────────────
    let loadedAgent: LoadedAgent;
    let agentName: string;

    if (typeof options.agent === 'string') {
        agentName = options.agent;

        // Show call header
        display.showAgentCall(agentName, message, parentDepth);

        const loader = new AgentLoader();
        const loaded = await loader.loadByName(agentName);
        if (!loaded) {
            // Try case-insensitive search
            const allAgents = await loader.getAvailableAgents();
            const match = allAgents.find(a => a.toLowerCase() === agentName.toLowerCase());
            if (match) {
                const retryLoaded = await loader.loadByName(match);
                if (retryLoaded) {
                    loadedAgent = retryLoaded;
                    agentName = match;
                } else {
                    throw new Error(`Agent "${agentName}" not found. Available: ${allAgents.join(', ')}`);
                }
            } else {
                throw new Error(`Agent "${agentName}" not found. Available: ${allAgents.join(', ')}`);
            }
        } else {
            loadedAgent = loaded;
        }
    } else {
        loadedAgent = options.agent;
        agentName = loadedAgent.config.name;

        // Show call header
        display.showAgentCall(agentName, message, parentDepth);
    }

    // ── 2. Apply modifications ─────────────────────────────────────────

    // Deep-clone the agent to avoid mutating the cached version
    const agentForSession: LoadedAgent = {
        config: { ...loadedAgent.config },
        systemPromptContent: loadedAgent.systemPromptContent,
        directory: loadedAgent.directory,
    };

    // Apply system prompt overrides
    if (systemPromptOverride) {
        agentForSession.systemPromptContent = systemPromptOverride;
    }

    // Apply extra system prompt (for subAgents) - appended even if overridden
    if (extraSystemPrompt) {
        agentForSession.systemPromptContent =
            `[Sub-agent additional context]\n${extraSystemPrompt}\n\n---\n\n${agentForSession.systemPromptContent}`;
    }

    // Apply model override (for subAgents with model switching)
    if (modelOverride) {
        agentForSession.config = { ...agentForSession.config, model: modelOverride };
    }

    // Disable ALL skills systems for subagents to prevent infinite recursive loops.
    // This covers BOTH:
    //   1. The `skills` tool (manual calls to skills.search()/skills.add())
    //   2. The SkillsService (automatic skill injection into LLM context via Executor)
    // The SkillsService is created in Session constructor when skillsTable is set,
    // so we must clear it from the config BEFORE creating the Session.
    if (options.isSubagent) {
        agentForSession.config = { ...agentForSession.config, skillsTable: undefined };
    }

    // ── 3. Resolve components ──────────────────────────────────────────

    const provider = getProvider(agentForSession.config.provider || 'openrouter');
    const syntax = getSyntax(agentForSession.config.syntax);
    const loop = getLoop(agentForSession.config.loop);

    // Load tools (same logic as chat.ts)
    let toolNames = [...(agentForSession.config.tools || [])];
    if (!toolNames.includes('files')) toolNames.push('files');
    if (agentForSession.config.skillsTable && !toolNames.includes('skills')) {
        toolNames.push('skills');
    }
    if (agentForSession.config.memory && agentForSession.config.memory.enabled !== false && !toolNames.includes('memory')) {
        toolNames.push('memory');
    }

    const tools = await toolLoader.loadByNames(toolNames);

    // ── 4. Create session with SHARED sandbox ──────────────────────────

    const session = new Session({
        agent: agentForSession,
        provider,
        syntax,
        loop,
        tools,
        sandbox, // SHARED — same filesystem as the caller
    });

    await session.initialize();

    // ── 5. Create executor with display callbacks ──────────────────────
    // These callbacks are IDENTICAL to what chat.ts uses — so the CLI
    // output looks exactly the same for called agents as for the root agent.

    display.setDepth(childDepth);

    const localCallbacks: ExecutorCallbacks = {
        onReasoningDelta: (delta: string) => {
            display.startReasoning();
            display.writeReasoning(delta);
        },
        onReasoningDone: () => {
            display.endReasoning();
        },
        onTextDelta: (delta: string) => {
            display.startText();
            display.writeText(delta);
        },
        onTextDone: () => {
            display.endText();
        },
        onAction: (code: string) => {
            display.showAction(code);
        },
        onObservation: (output: string) => {
            display.showObservation(output);
        },
        onBeforeProviderCall: () => {
            display.reset();
        },
        onSkillsRetrieved: (content: string, score: number) => {
            const prefix = getLineContinuation(childDepth);
            console.error(prefix + COLORS.skills(`${SYMBOLS.skills} Skills retrieved (${(score * 100).toFixed(0)}% match)`));
        },
    };
    const bridgeCallbacks = createTelegramUiBridge(`subagent:${agentName}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`, agentName);
    const callbacks = composeCallbacks(localCallbacks, bridgeCallbacks);

    display.showAgentStart(agentName, childDepth);

    const executor = new Executor(session, {
        maxIterations: 500,
        stream,
        callbacks,
        requireFinish: agentForSession.config.requireFinish,
    });

    // ── 6. Execute in agent context ────────────────────────────────────

    try {
        const response = await runWithAgentContext(
            agentName,
            async () => executor.execute(message),
            callbacks,
            stream,
            sandbox,
            agentForSession.config.modelSwitching,
            agentForSession
        );

        // Show completion
        const preview = response.length > 200 ? response.slice(0, 200) + '...' : response;
        display.showAgentComplete(agentName, preview, childDepth);

        // Restore parent depth on display
        display.setDepth(parentDepth);

        return response;

    } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        display.showAgentError(agentName, errorMsg, childDepth);
        display.setDepth(parentDepth);
        throw error;
    }
}

/**
 * List all available agent names
 */
export async function listAgents(): Promise<string[]> {
    return new AgentLoader().getAvailableAgents();
}

/**
 * Load an agent by name (for inspection or advanced usage)
 */
export async function loadAgent(name: string): Promise<LoadedAgent | null> {
    return new AgentLoader().loadByName(name);
}
