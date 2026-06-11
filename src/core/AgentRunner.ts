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
import { resolveTextAgentRuntime } from './SessionFactory.js';
import { runWithAgentContext } from './AgentContext.js';
import { getGlobalDisplay } from './GlobalDisplay.js';
import { StreamDisplay, COLORS, SYMBOLS, getLineContinuation } from '../cli/display.js';
import type { ISandbox } from '../sandbox/interfaces.js';
import type { AgentInstructionAlgorithmConfig, LoadedAgent } from '../types/index.js';
import { appendAgentTextLog, readAgentTextLog } from './agentTextLog.js';
import { actionContext } from './ActionContext.js';
import type { SessionSnapshot } from './Session.js';
import { selectNotDiamondModelForSubagent, type NotDiamondRoutingResult } from '../services/model-selection/NotDiamondRouter.js';

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

function getLastUserMessagePreview(snapshot?: SessionSnapshot, maxLength = 160): string | null {
    const messages = snapshot?.messages || [];
    for (let i = messages.length - 1; i >= 0; i--) {
        const message = messages[i];
        if (message?.role !== 'user') {
            continue;
        }

        const normalized = String(message.content || '').replace(/\s+/g, ' ').trim();
        if (!normalized) {
            continue;
        }

        return normalized.length > maxLength
            ? `${normalized.slice(0, maxLength - 3)}...`
            : normalized;
    }

    return null;
}

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
    const apiUrl = process.env.TELOS_API_URL;
    const chatId = process.env.TELOS_CHAT_ID;

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
        onModelSelected: (model, provider, reason) => post({
            event: 'executor.observation',
            content: `[model-switch] Selected ${provider}/${model}${reason ? ` (${reason})` : ''}`,
        }),
        onResponse: (content) => post({ event: 'executor.response', content }),
    };
}

function createAgentTextLogCallbacks(logPath?: string): ExecutorCallbacks | null {
    if (!logPath) {
        return null;
    }

    return {
        onTextDone: (text) => {
            appendAgentTextLog(logPath, 'assistant_text', text);
        },
        onResponse: (content) => {
            appendAgentTextLog(logPath, 'response', content);
        },
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
        onModelSelected: (model, provider, reason) => {
            for (const set of sets) set.onModelSelected?.(model, provider, reason);
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
        onMemoryHintsRetrieved: (content, score) => {
            for (const set of sets) set.onMemoryHintsRetrieved?.(content, score);
        },
        onMemoryHintsSearched: (topScore) => {
            for (const set of sets) set.onMemoryHintsSearched?.(topScore);
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
    /** Override provider for the agent (used by Not Diamond model routing) */
    providerOverride?: string;
    /** Completely replace system prompt (for sub-agents) */
    systemPromptOverride?: string;
    /** Override or disable the active instruction algorithm for this run */
    instructionAlgorithmOverride?: AgentInstructionAlgorithmConfig | false;
    /** Whether this agent is being run as a sub-agent (disables skills to prevent infinite loops) */
    isSubagent?: boolean;
    /** Restore a previous text session history before executing the new request */
    restoreSnapshot?: SessionSnapshot;
    /** Persist the updated session snapshot after execution */
    onSessionSnapshot?: (snapshot: SessionSnapshot, agent: LoadedAgent) => void | Promise<void>;
    /** Called after a sub-agent first request is routed to a concrete model */
    onModelRouted?: (result: NotDiamondRoutingResult, agent: LoadedAgent) => void | Promise<void>;
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
        providerOverride,
        instructionAlgorithmOverride,
        restoreSnapshot,
        onSessionSnapshot,
        onModelRouted,
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
    if (modelOverride && modelOverride.trim().toLowerCase() !== 'auto') {
        agentForSession.config = { ...agentForSession.config, model: modelOverride };
    }
    if (providerOverride) {
        agentForSession.config = { ...agentForSession.config, provider: providerOverride };
    }

    if (options.isSubagent) {
        agentForSession.config = { ...agentForSession.config, memory: { ...agentForSession.config.memory, autoHints: { enabled: false } } };
    }
    if (typeof instructionAlgorithmOverride !== 'undefined') {
        agentForSession.config = {
            ...agentForSession.config,
            instructionAlgorithm: instructionAlgorithmOverride === false
                ? { enabled: false }
                : instructionAlgorithmOverride,
        };
    } else if (options.isSubagent && extraSystemPrompt) {
        agentForSession.config = {
            ...agentForSession.config,
            instructionAlgorithm: agentForSession.config.subagentInstructionAlgorithm?.enabled
                ? agentForSession.config.subagentInstructionAlgorithm
                : { enabled: false },
        };
    }

    // ── 3. Resolve components ──────────────────────────────────────────

    let runtime = resolveTextAgentRuntime(agentForSession);

    // Load tools (same logic as chat.ts)
    let toolNames = [...(agentForSession.config.tools || [])];
    if (!toolNames.includes('files')) toolNames.push('files');
    if (agentForSession.config.memory?.enabled !== false && !toolNames.includes('memory')) {
        toolNames.push('memory');
    }

    const tools = await toolLoader.loadByNames(toolNames);

    // ── 4. Create session with SHARED sandbox ──────────────────────────

    const session = new Session({
        agent: agentForSession,
        provider: runtime.provider,
        syntax: runtime.syntax,
        loop: runtime.loop,
        tools,
        sandbox, // SHARED — same filesystem as the caller
    });

    await session.initialize();
    if (restoreSnapshot) {
        session.applySnapshot(restoreSnapshot);
        const lastUserMessage = getLastUserMessagePreview(restoreSnapshot);
        if (lastUserMessage) {
            const prefix = getLineContinuation(childDepth);
            console.error(prefix + COLORS.muted(`[session] Restored previous session. Last user message: ${lastUserMessage}`));
        } else {
            const prefix = getLineContinuation(childDepth);
            console.error(prefix + COLORS.muted('[session] Restored previous session.'));
        }
    }
    const continuingActiveTurn = session.hasActiveTurn();
    const executionMessage = continuingActiveTurn
        ? (session.getActiveTurnUserMessage() || message)
        : message;
    if (!continuingActiveTurn) {
        session.beginTurn(message, process.env.TELOS_CHAT_ID === 'HEARTBEAT_ROUTE' ? 'heartbeat' : 'user');
    }

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
        onTextDone: (fullText: string) => {
            display.endText();
            session.recordVisibleAssistantOutput(fullText);
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
        onMemoryHintsRetrieved: (_content: string, score: number) => {
            const prefix = getLineContinuation(childDepth);
            console.error(prefix + COLORS.skills(`${SYMBOLS.skills} Memory hints retrieved (${(score * 100).toFixed(0)}% match)`));
        },
        onResponse: (content: string) => {
            session.recordVisibleAssistantOutput(content);
        },
    };
    const bridgeCallbacks = createTelegramUiBridge(`subagent:${agentName}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`, agentName);
    const textLogPath = actionContext.getStore()?.env?.TELOS_TEXT_LOG_PATH;
    const textLogCallbacks = createAgentTextLogCallbacks(textLogPath);
    const callbacks = composeCallbacks(localCallbacks, bridgeCallbacks, textLogCallbacks);

    if (options.isSubagent && modelOverride !== undefined && !providerOverride && !continuingActiveTurn) {
        const routingResult = await selectNotDiamondModelForSubagent({
            requestedModel: modelOverride,
            baseProvider: agentForSession.config.provider || 'openrouter',
            switchingConfig: agentForSession.config.modelSwitching,
            fullSystemPrompt: session.getSystemPrompt(),
            additionalSystemPrompt: extraSystemPrompt,
            userMessage: executionMessage,
        });

        if (routingResult.changed) {
            agentForSession.config = {
                ...agentForSession.config,
                model: routingResult.executionModel,
                provider: routingResult.executionProvider,
            };
            runtime = resolveTextAgentRuntime(agentForSession);
            session.rebuildPrompt(agentForSession, runtime.provider, runtime.syntax, runtime.loop, tools);
        }

        console.error(COLORS.muted(`[model-switch] ${agentName}: ${routingResult.executionProvider}/${routingResult.executionModel}${routingResult.reason ? ` (${routingResult.reason})` : ''}`));
        callbacks.onModelSelected?.(routingResult.executionModel, routingResult.executionProvider, routingResult.reason);

        if (onModelRouted) {
            await onModelRouted(routingResult, agentForSession);
        }
    }

    display.showAgentStart(agentName, childDepth);

    const executor = new Executor(session, {
        maxIterations: 500,
        stream,
        callbacks,
        onCheckpoint: async (snapshot) => {
            if (onSessionSnapshot) {
                await onSessionSnapshot(snapshot, agentForSession);
            }
        },
        requireFinish: process.env.TELOS_CHAT_ID === 'HEARTBEAT_ROUTE'
            ? (agentForSession.config.requireFinishHeartbeat ?? agentForSession.config.requireFinish)
            : agentForSession.config.requireFinish,
    });

    // ── 6. Execute in agent context ────────────────────────────────────

    try {
        const response = await runWithAgentContext(
            agentName,
            async () => executor.execute(executionMessage, { continueActiveTurn: continuingActiveTurn }),
            callbacks,
            stream,
            sandbox,
            agentForSession.config.modelSwitching,
            agentForSession
        );

        const textEntries = await readAgentTextLog(textLogPath);
        for (const entry of textEntries) {
            if (entry.source === 'sent_text') {
                session.recordVisibleAssistantOutput(entry.text);
            }
        }
        session.endTurn();

        if (onSessionSnapshot) {
            await onSessionSnapshot(session.exportSnapshot(), agentForSession);
        }

        // Show completion
        const preview = response.length > 200 ? response.slice(0, 200) + '...' : response;
        display.showAgentComplete(agentName, preview, childDepth);

        // Restore parent depth on display
        display.setDepth(parentDepth);

        return response;

    } catch (error) {
        try {
            const textEntries = await readAgentTextLog(textLogPath);
            for (const entry of textEntries) {
                if (entry.source === 'sent_text') {
                    session.recordVisibleAssistantOutput(entry.text);
                }
            }
        } catch {
            // Best-effort log recovery only.
        }
        session.endTurn();
        if (onSessionSnapshot) {
            await onSessionSnapshot(session.exportSnapshot(), agentForSession);
        }
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
