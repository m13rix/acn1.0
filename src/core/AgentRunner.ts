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

    const callbacks: ExecutorCallbacks = {
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
            console.log(prefix + COLORS.skills(`${SYMBOLS.skills} Skills retrieved (${(score * 100).toFixed(0)}% match)`));
        },
    };

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
