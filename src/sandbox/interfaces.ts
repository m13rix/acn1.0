
import type { ExecutionResult, LoadedTool } from '../types/index.js';

export interface ISandbox {
    readonly id: string;
    readonly directory: string;

    /**
     * Initialize the sandbox with the given tools
     */
    initialize(tools: LoadedTool[], skillsTable?: string): Promise<void>;

    /**
     * Execute code in the sandbox
     */
    execute(code: string): Promise<ExecutionResult>;

    /**
     * Execute a CLI command in the sandbox directory
     */
    executeCli(command: string): Promise<ExecutionResult>;

    /**
     * Clean up the sandbox (close browser, delete files, etc)
     */
    cleanup(): Promise<void>;

    /**
     * Get description for system prompt
     */
    getDescription(): string;
}
