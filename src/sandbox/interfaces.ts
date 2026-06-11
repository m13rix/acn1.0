
import type { AgentMemoryConfig, ExecutionResult, LoadedTool } from '../types/index.js';

export interface ISandbox {
    readonly id: string;
    readonly directory: string;

    /**
     * Initialize the sandbox with the given tools
     */
    initialize(tools: LoadedTool[], memoryConfig?: AgentMemoryConfig): Promise<void>;

    /**
     * Optional best-effort warm-up for sandboxes with reusable runtimes.
     */
    warmUp?(): Promise<void>;

    /**
     * Execute code in the sandbox
     * @param code - TypeScript code
     * @param language - Optional language identifier
     * @param env - Optional environment variables
     * @param onStderr - Optional callback for streaming stderr (used for real-time display)
     */
    execute(code: string, language?: string, env?: Record<string, string>, onStderr?: (data: string) => void): Promise<ExecutionResult>;

    /**
     * Execute a CLI command in the sandbox directory
     * @param command - Command to execute
     * @param onStdout - Optional callback for streaming stdout
     * @param onStderr - Optional callback for streaming stderr
     */
    executeCli(command: string, onStdout?: (data: string) => void, onStderr?: (data: string) => void): Promise<ExecutionResult>;

    /**
     * Parse Search & Replace content to extract edit operations
     */
    parseSearchReplace(content: string): Array<{ search: string; replace: string }>;

    /**
     * Apply Search & Replace edits to a file
     */
    applySearchReplace(filename: string, edits: Array<{ search: string; replace: string }>): Promise<ExecutionResult>;

    /**
     * Clean up the sandbox (close browser, delete files, etc)
     */
    cleanup(): Promise<void>;

    /**
     * Get description for system prompt
     */
    getDescription(): string;
}
