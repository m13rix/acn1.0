import chalk from 'chalk';

// UI Constants
export const COLORS = {
    primary: chalk.hex('#7C3AED'),    // Purple
    secondary: chalk.hex('#10B981'),   // Emerald
    muted: chalk.hex('#6B7280'),       // Gray
    reasoning: chalk.hex('#F59E0B'),   // Amber
    action: chalk.hex('#3B82F6'),      // Blue
    observation: chalk.hex('#06B6D4'), // Cyan
    error: chalk.hex('#EF4444'),       // Red
    text: chalk.hex('#E5E7EB'),        // Light gray
    skills: chalk.hex('#8B5CF6'),      // Purple for skills
    embed: chalk.hex('#10B981'),       // Green for embedding
    agent: chalk.hex('#F472B6'),       // Pink for agents
    subagent: chalk.hex('#A78BFA'),    // Purple for subagents
    hierarchy: chalk.hex('#4B5563'),   // Dark gray for hierarchy lines
};

export const SYMBOLS = {
    thinking: '◐',
    streaming: '▸',
    complete: '●',
    action: '⚡',
    observation: '◆',
    user: '›',
    assistant: '◀',
    skills: '🔮',
    embed: '⚡',
    agent: '⬡',
    call: '→',
    branch: '├─',
    last: '└─',
    line: '│',
};

/**
 * Generate hierarchy prefix based on depth
 */
export function getHierarchyPrefix(depth: number, isLast: boolean = false): string {
    if (depth === 0) return '';

    const lines = COLORS.hierarchy(SYMBOLS.line + ' ').repeat(depth - 1);
    const connector = isLast ? COLORS.hierarchy(SYMBOLS.last + ' ') : COLORS.hierarchy(SYMBOLS.branch + ' ');
    return lines + connector;
}

/**
 * Generate continuation line prefix for multi-line content
 */
export function getLineContinuation(depth: number): string {
    if (depth === 0) return '';
    return COLORS.hierarchy(SYMBOLS.line + ' ').repeat(depth);
}

/**
 * Manages the streaming display state with hierarchical agent support
 */
export class StreamDisplay {
    private isShowingReasoning = false;
    private isShowingText = false;
    private reasoningLineCount = 0;
    private currentDepth = 0;

    constructor() {
        // Initialize depth from environment variable if present (for child processes)
        if (process.env.AGENT_DEPTH) {
            const envDepth = parseInt(process.env.AGENT_DEPTH, 10);
            if (!isNaN(envDepth)) {
                this.currentDepth = envDepth;
            }
        }
    }

    /**
     * Set current display depth for hierarchy
     */
    setDepth(depth: number): void {
        this.currentDepth = depth;
    }

    /**
     * Get line prefix for current depth
     */
    private getPrefix(): string {
        return getLineContinuation(this.currentDepth);
    }

    /**
     * Write with hierarchy prefix
     */
    private writeWithPrefix(text: string, usePrefix: boolean = true): void {
        if (usePrefix && this.currentDepth > 0) {
            // Replace newlines with newline + prefix for multi-line content
            const prefixed = text.replace(/\n/g, '\n' + this.getPrefix());
            process.stderr.write(prefixed);
        } else {
            process.stderr.write(text);
        }
    }

    /**
     * console.error with hierarchy prefix
     */
    private logWithPrefix(text: string): void {
        const prefix = this.getPrefix();
        console.error(prefix + text);
    }

    // ═══════════════════════════════════════════════════════════════════
    // Agent Hierarchy Display
    // ═══════════════════════════════════════════════════════════════════

    /**
     * Show agent creation/spawn
     */
    showAgentCreation(name: string, model: string, systemPromptPreview?: string, depth: number = 0): void {
        const prefix = getLineContinuation(depth);
        console.error('');
        console.error(prefix + COLORS.agent(`${SYMBOLS.agent} Creating agent "${name}"`));
        console.error(prefix + COLORS.muted(`  Model: ${model}`));
        if (systemPromptPreview) {
            const preview = systemPromptPreview.length > 80
                ? systemPromptPreview.slice(0, 80) + '...'
                : systemPromptPreview;
            console.error(prefix + COLORS.muted(`  Prompt: ${preview}`));
        }
    }

    /**
     * Show agent call start
     */
    showAgentCall(name: string, request: string, depth: number = 0): void {
        const prefix = getLineContinuation(depth);
        console.error('');
        console.error(prefix + COLORS.agent(`${SYMBOLS.agent} ${SYMBOLS.call} Calling "${name}"`));

        // Show truncated request
        const reqPreview = request.length > 100 ? request.slice(0, 100) + '...' : request;
        console.error(prefix + COLORS.muted(`  Request: ${reqPreview}`));
        console.error(prefix + COLORS.hierarchy(SYMBOLS.line));
    }

    /**
     * Show agent response start (when agent starts processing)
     */
    showAgentStart(name: string, depth: number = 0): void {
        const prefix = getLineContinuation(depth);
        console.error(prefix + COLORS.subagent(`${SYMBOLS.assistant} ${name} processing...`));
    }

    /**
     * Show agent completion
     */
    showAgentComplete(name: string, responsePreview?: string, depth: number = 0): void {
        const prefix = depth > 0 ? getLineContinuation(depth - 1) : '';
        console.error(prefix + COLORS.hierarchy(SYMBOLS.line));

        const connector = COLORS.hierarchy(SYMBOLS.last);
        if (responsePreview) {
            const preview = responsePreview.length > 80
                ? responsePreview.slice(0, 80) + '...'
                : responsePreview;
            console.error(prefix + connector + COLORS.agent(` ${name} completed: `) + COLORS.muted(preview));
        } else {
            console.error(prefix + connector + COLORS.agent(` ${name} completed`));
        }
        console.error('');
    }

    /**
     * Show agent error
     */
    showAgentError(name: string, error: string, depth: number = 0): void {
        const prefix = depth > 0 ? getLineContinuation(depth - 1) : '';
        console.error(prefix + COLORS.hierarchy(SYMBOLS.line));
        console.error(prefix + COLORS.hierarchy(SYMBOLS.last) + COLORS.error(` ${name} error: ${error}`));
        console.error('');
    }

    // ═══════════════════════════════════════════════════════════════════
    // Standard Display Methods (now depth-aware)
    // ═══════════════════════════════════════════════════════════════════

    startReasoning(): void {
        if (!this.isShowingReasoning) {
            this.isShowingReasoning = true;
            const prefix = this.getPrefix();
            process.stderr.write(prefix + COLORS.reasoning(`${SYMBOLS.thinking} Reasoning: `));
            this.reasoningLineCount = 0;
        }
    }

    writeReasoning(delta: string): void {
        this.writeWithPrefix(COLORS.muted(delta), true);
    }

    endReasoning(): void {
        if (this.isShowingReasoning) {
            process.stderr.write('\n');
            this.isShowingReasoning = false;
        }
    }

    startText(): void {
        if (!this.isShowingText) {
            this.isShowingText = true;
            const prefix = this.getPrefix();
            process.stderr.write(prefix + COLORS.text(''));
        }
    }

    writeText(delta: string): void {
        this.writeWithPrefix(delta, true);
    }

    endText(): void {
        if (this.isShowingText) {
            this.isShowingText = false;
        }
    }

    showAction(code: string): void {
        this.endReasoning();
        this.endText();
        this.logWithPrefix(COLORS.action(`\n${SYMBOLS.action} Executing action...`));
        // Show truncated code preview
        this.logWithPrefix(COLORS.muted(code));
    }

    showObservation(output: string): void {
        this.logWithPrefix(COLORS.observation(`${SYMBOLS.observation} Result:`));
        // Handle multi-line output
        const lines = output.split('\n');
        for (const line of lines) {
            this.logWithPrefix(COLORS.muted(line));
        }
    }

    reset(): void {
        this.isShowingReasoning = false;
        this.isShowingText = false;
        this.reasoningLineCount = 0;
        // Don't reset depth - it's managed externally
    }

    // ═══════════════════════════════════════════════════════════════════
    // Memory/Skills Display
    // ═══════════════════════════════════════════════════════════════════

    showMemoryLog(message: string): void {
        this.logWithPrefix(COLORS.skills(`${SYMBOLS.skills} Memory: `) + COLORS.text(message));
    }

    showMemoryStep(step: string): void {
        this.logWithPrefix(COLORS.muted(`  ${SYMBOLS.streaming} ${step}`));
    }

    showMemoryEmbedding(text: string): void {
        const preview = text.length > 50 ? text.slice(0, 50) + '...' : text;
        this.logWithPrefix(COLORS.embed(`  ${SYMBOLS.embed} Embedding: `) + COLORS.muted(`"${preview}"`));
    }

    showMemoryRetrieval(query: string, candidates: Array<{ text: string; score: number }>): void {
        this.logWithPrefix(COLORS.secondary(`  ${SYMBOLS.observation} Retrieval for topics:`));
        for (const cand of candidates) {
            const score = (cand.score * 100).toFixed(1);
            const text = cand.text.length > 80 ? cand.text.slice(0, 80) + '...' : cand.text;
            this.logWithPrefix(COLORS.muted(`    - [${score}%] ${text}`));
        }
    }

    showMemoryLLMPrompt(prompt: string): void {
        this.logWithPrefix(COLORS.reasoning(`  ${SYMBOLS.thinking} Linker Prompt:`));
        const lines = prompt.split('\n');
        for (const line of lines) {
            if (line.trim()) {
                this.logWithPrefix(COLORS.muted(`    | ${line}`));
            }
        }
    }

    private isStreamingMemoryLLM = false;

    startMemoryLLMResponse(): void {
        this.isStreamingMemoryLLM = true;
        process.stderr.write(this.getPrefix() + COLORS.secondary(`  ${SYMBOLS.streaming} LLM Response: `));
    }

    writeMemoryLLMDelta(delta: string): void {
        if (this.isStreamingMemoryLLM) {
            process.stderr.write(COLORS.muted(delta));
        }
    }

    endMemoryLLMResponse(): void {
        if (this.isStreamingMemoryLLM) {
            process.stderr.write('\n');
            this.isStreamingMemoryLLM = false;
        }
    }

    finalize(): void {
        this.endReasoning();
        this.endMemoryLLMResponse();
        if (this.isShowingText) {
            process.stderr.write('\n');
        }
        this.reset();
    }
}
