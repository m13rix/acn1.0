/**
 * AgentContext
 * 
 * Provides async context for tracking agent hierarchy depth
 * and passing callbacks between nested agent calls.
 */

import { AsyncLocalStorage } from 'async_hooks';
import type { ExecutorCallbacks } from './Executor.js';
import type { ISandbox } from '../sandbox/interfaces.js';

import type { ModelSwitchingConfig, LoadedAgent } from '../types/index.js';

export interface AgentContextData {
    /** Current nesting depth (0 = root agent) */
    depth: number;
    /** Parent agent name for reference */
    parentName?: string;
    /** Callbacks to propagate to child agents */
    callbacks?: ExecutorCallbacks;
    /** Whether streaming is enabled */
    stream?: boolean;
    /** Shared sandbox from the calling agent */
    sandbox?: ISandbox;
    /** Agent-specific model switching configuration */
    modelSwitching?: ModelSwitchingConfig;
    /** The running agent instance (for accessing config/prompts) */
    agent?: LoadedAgent;
}

/**
 * AsyncLocalStorage for agent context
 * Allows passing context through async call chains without explicit parameters
 */
export const agentContext = new AsyncLocalStorage<AgentContextData>();

/**
 * Get current agent nesting depth
 */
export function getAgentDepth(): number {
    return agentContext.getStore()?.depth ?? 0;
}

/**
 * Get callbacks from parent context
 */
export function getAgentCallbacks(): ExecutorCallbacks | undefined {
    return agentContext.getStore()?.callbacks;
}

/**
 * Get parent agent name
 */
export function getParentAgentName(): string | undefined {
    return agentContext.getStore()?.parentName;
}

/**
 * Get agent model switching configuration
 */
export function getAgentModelSwitchingConfig(): ModelSwitchingConfig | undefined {
    return agentContext.getStore()?.modelSwitching;
}

/**
 * Get the current running agent instance
 */
export function getCurrentAgent(): LoadedAgent | undefined {
    return agentContext.getStore()?.agent;
}

/**
 * Check if streaming is enabled in context
 */
export function isStreamingEnabled(): boolean {
    return agentContext.getStore()?.stream ?? true;
}

/**
 * Get the shared sandbox from the current agent context
 */
export function getAgentSandbox(): ISandbox | undefined {
    return agentContext.getStore()?.sandbox;
}

/**
 * Run a function with a new agent context (incremented depth)
 */
export function runWithAgentContext<T>(
    agentName: string,
    fn: () => T | Promise<T>,
    callbacks?: ExecutorCallbacks,
    stream?: boolean,
    sandbox?: ISandbox,
    modelSwitching?: ModelSwitchingConfig,
    agent?: LoadedAgent
): T | Promise<T> {
    const parentStore = agentContext.getStore();
    const newDepth = (parentStore?.depth ?? -1) + 1;

    return agentContext.run(
        {
            depth: newDepth,
            parentName: agentName,
            callbacks: callbacks ?? parentStore?.callbacks,
            stream: stream ?? parentStore?.stream ?? true,
            sandbox: sandbox ?? parentStore?.sandbox,
            modelSwitching: modelSwitching ?? parentStore?.modelSwitching,
            agent: agent ?? parentStore?.agent,
        },
        fn
    );
}

export default agentContext;
