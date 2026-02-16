/**
 * Core Types for ACN Heartbeat System
 */

export interface HeartbeatTask {
    id: string;
    /** Human readable name for the task */
    name: string;

    /** 
     * The trigger event signature.
     * e.g. "clock:every:10m" or "telegram:batch:5"
     * Matches what sensors emit.
     */
    trigger: string;

    /**
     * Optional condition prompt for Micro-LLM.
     * If omitted, Pulse logic treats it as "ALWAYS TRUE" 
     * but still performs variable extraction from context.
     */
    condition?: string;

    /**
     * The instruction prompt for the agent.
     * Can contain {{variables}} extracted by Pulse.
     */
    action: string;

    active: boolean;

    /**
     * Maximum number of times this task can fire.
     * -1 = infinite.
     * > 0 = reduces by 1 on each fire. 
     * When reaches 0, task is DELETED.
     */
    maxRepeats?: number;
    remainingRepeats?: number;

    /** The agent that created this task */
    agentName: string;

    /** The tools available to the agent when task was created */
    tools: string[];
}

export interface SensorConfig {
    name: string;
    description: string;
    minillm: {
        model: string;
        provider: string;
    };
    [key: string]: any; // Allow other config props
}

export interface PulseResult {
    success: boolean;
    variables?: Record<string, string>;
    error?: string;
}

export interface Sensor {
    /** Initialize sensor and start listening/polling */
    start(emit: (event: string, payload?: any) => void): Promise<void>;

    /** Stop sensor and cleanup resources */
    stop(): Promise<void>;

    /** Get current context for Micro-LLM (e.g. valid variables, recent logs) */
    getContext(): Promise<string>;

    /** 
     * Called after a task was successfully executed by an agent.
     * Useful for clearing buffers (Telegram) or resetting states.
     */
    onTaskExecuted?(taskId: string): Promise<void>;

    /**
     * Direct query interface for Agent (RAG, search, etc)
     */
    ask?(query: string): Promise<string>;
}
