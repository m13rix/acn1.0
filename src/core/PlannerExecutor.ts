
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import chalk from 'chalk';
import vm from 'vm';
import { Session } from './Session.js';
import { Executor } from './Executor.js';
import { PlanParser } from '../utils/PlanParser.js';
import { createSandbox } from '../sandbox/index.js';
import { ModelSwitchingManager } from '../services/model-selection/ModelSwitchingManager.js';
import { getProvider } from '../providers/base.js';
import { getSyntax } from '../syntax/base.js';
import { getLoop } from '../loops/base.js';
import { ToolLoader } from '../loaders/ToolLoader.js'; // We might need to load tools for sub-agents
import { LoadedAgent, AgentConfig, PlannerConfig, ExecutorConfig } from '../types/index.js';
import { getAvailableProviders } from '../providers/base.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..', '..');

export class PlannerExecutor {
    private plannerSession: Session;
    private currentExecutorSession: Session | null = null;
    private currentExecutor: Executor | null = null;
    private subAgents: Map<string, Session> = new Map();
    private modelSwitchingManager: ModelSwitchingManager | null = null;
    private toolLoader: ToolLoader;
    private options: any;

    constructor(session: Session, options: any = {}) {
        this.plannerSession = session;
        this.options = options;
        this.toolLoader = new ToolLoader(); // New loader for dynamic tools

        // Initialize Model Switching if configured
        const agentConfig = session.agent.config;
        if (agentConfig.executor?.modelSwitching) {
            // Base executor config for fallback/reference
            const baseExecConfig = {
                model: agentConfig.executor.model,
                provider: agentConfig.executor.provider || 'gemini',
                systemPrompt: agentConfig.executor.systemPrompt,
                temperature: agentConfig.executor.temperature,
                // ... keys
            };

            // We need a logger for the manager
            const logger = (msg: string) => console.log(msg); // Simple logger

            const switchingConfig = { ...agentConfig.executor.modelSwitching };
            if (!switchingConfig.registryPath) {
                switchingConfig.registryPath = join(PROJECT_ROOT, 'data', 'models.json');
            }

            this.modelSwitchingManager = new ModelSwitchingManager(baseExecConfig, switchingConfig, logger);
        }
    }

    /**
     * Main entry point for the text-based chat interface.
     * Runs the Planner Loop.
     */
    async execute(userInput: string): Promise<string> {
        // 1. Add user input to Planner History
        this.plannerSession.addUserMessage(userInput);

        // 2. Start Planner Loop
        let finalResponse = '';
        let iterations = 0;
        const MAX_ITERATIONS = 20;

        while (iterations < MAX_ITERATIONS) {
            iterations++;

            const messages = this.plannerSession.getAllMessages();
            const providerConfig = this.plannerSession.getProviderConfig();

            // Use Planner config overrides
            if (this.plannerSession.agent.config.planner) {
                const p = this.plannerSession.agent.config.planner;
                providerConfig.model = p.model;
                if (p.temperature) providerConfig.temperature = p.temperature;
            }

            providerConfig.stream = this.options.stream;

            this.log(chalk.magenta(`\n[Planner] Thinking...`));
            const { text, interrupted } = await this.executePlannerStreaming(messages, providerConfig);
            finalResponse = text;

            // Parse Plan using assistant message
            const parsed = PlanParser.parse(text, this.plannerSession.syntax);

            if (interrupted) {
                // Execute immediate actions found in the text so far
                // We trust the streaming loop to stop exactly after the tag
                const immediateAction = this.plannerSession.syntax.getAction(text);
                const immediateCli = this.plannerSession.syntax.getCli(text);

                if (immediateAction) await this.executePlanAction(immediateAction);
                if (immediateCli) await this.executePlanCli(immediateCli);

                this.plannerSession.addUserMessage("Actions executed successfully.");
                continue; // Return to planner
            }

            // Handle any immediate items found by PlanParser (e.g. at end of stream)
            if (parsed.immediateActions.length > 0 || parsed.immediateCli.length > 0) {
                for (const action of parsed.immediateActions) await this.executePlanAction(action);
                for (const cli of parsed.immediateCli) await this.executePlanCli(cli);

                this.plannerSession.addUserMessage("Actions executed successfully.");
                continue;
            }

            const hasSteps = parsed.steps.length > 0;

            // Execute Steps
            if (hasSteps) {
                this.log(chalk.cyan(`[Planner] Executing plan with ${parsed.steps.length} steps...`));

                const stepResults: string[] = [];

                for (let i = 0; i < parsed.steps.length; i++) {
                    const step = parsed.steps[i];
                    if (!step) continue;
                    this.log(chalk.yellow(`\n[Planner] Step ${i + 1}: ${step.instruction.substring(0, 50)}...`));

                    // Execute Queued Actions/CLI
                    for (const actionCode of step.actions) await this.executePlanAction(actionCode);
                    for (const cliCommand of step.cli) await this.executePlanCli(cliCommand);

                    // Execute Instruction
                    if (!this.currentExecutor) await this.ensureDefaultExecutor();
                    if (this.currentExecutor) {
                        const result = await this.currentExecutor.execute(step.instruction);
                        stepResults.push(`Step ${i + 1} Result: ${result}`);
                    } else {
                        stepResults.push(`Step ${i + 1} Error: No active executor.`);
                    }
                }

                const observation = `All steps completed.\n\nResults:\n${stepResults.join('\n\n')}`;
                this.plannerSession.addUserMessage(observation);
                continue; // Return to planner
            }

            // No steps, no interruption -> Done.
            return text;
        }

        return finalResponse;
    }

    /**
     * Internal streaming loop for the planner with interruption logic.
     */
    private async executePlannerStreaming(messages: any[], config: any): Promise<{ text: string, interrupted: boolean }> {
        let accumulatedText = '';
        let accumulatedReasoning = '';
        let interrupted = false;

        const syntax = this.plannerSession.syntax;
        const stepRegex = /(?:^|\n)\d+[\.\)]\s/;

        if (!config.stream || !this.plannerSession.provider.streamEvents) {
            const response = await this.plannerSession.provider.complete(messages, config);
            accumulatedText = response.content;
            accumulatedReasoning = response.reasoning || '';
        } else {
            // Streaming mode
            for await (const event of this.plannerSession.provider.streamEvents!(messages, config)) {
                if (event.type === 'reasoning.delta' && event.delta) {
                    accumulatedReasoning += event.delta;
                    this.options.callbacks?.onReasoningDelta?.(event.delta, accumulatedReasoning);
                } else if (event.type === 'reasoning.done') {
                    this.options.callbacks?.onReasoningDone?.(accumulatedReasoning);
                } else if (event.type === 'text.delta' && event.delta) {
                    accumulatedText += event.delta;
                    this.options.callbacks?.onTextDelta?.(event.delta, accumulatedText);

                    // STREAMING INTERRUPTION LOGIC
                    if (syntax.hasAction(accumulatedText) || syntax.hasCli(accumulatedText)) {
                        const inStep = stepRegex.test(accumulatedText);
                        if (!inStep) {
                            const isActionClosed = syntax.isActionClosed(accumulatedText);
                            const isCliClosed = syntax.isCliClosed(accumulatedText);

                            if (isActionClosed || isCliClosed) {
                                this.log(chalk.cyan(`\n[Planner] Immediate command detected (closed). Interrupting stream...`));
                                interrupted = true;
                                break;
                            }
                        }
                    }
                } else if (event.type === 'text.done') {
                    this.options.callbacks?.onTextDone?.(accumulatedText);
                }
            }
        }

        // Save to history
        let assistantMessage = accumulatedText;
        if (accumulatedReasoning) {
            assistantMessage = syntax.wrapThinking(accumulatedReasoning) + '\n' + accumulatedText;
        }
        this.plannerSession.addAssistantMessage(assistantMessage);

        return { text: accumulatedText, interrupted };
    }

    /**
     * Execute action code in the host context using vm.
     * Provides `plan` object.
     */
    private async executePlanAction(code: string): Promise<void> {
        if (this.options.callbacks?.onAction) {
            this.options.callbacks.onAction(code);
        }

        const sandbox = {
            plan: {
                createSubAgent: async (name: string, config: any) => this.createSubAgent(name, config),
                switchSubAgent: async (name: string) => this.switchSubAgent(name),
            },
            console: console, // Allow logging
            // Add other safe globals if needed
        };

        const context = vm.createContext(sandbox);

        try {
            // Wrapped in async IIFE to support await
            const wrappedCode = `(async () => { ${code} })()`;
            await vm.runInContext(wrappedCode, context);
        } catch (error: any) {
            console.error(`[Planner] Action Execution Error:`, error);
        }
    }

    /**
     * Execute CLI command in the planner's sandbox.
     */
    private async executePlanCli(command: string): Promise<void> {
        if (this.options.callbacks?.onCli) {
            this.options.callbacks.onCli(command);
        }

        try {
            const result = await this.plannerSession.sandbox.executeCli(command);
            if (!result.success) {
                console.error(`[Planner] CLI Execution Error:`, result.error);
                console.error(result.output);
            }
        } catch (error: any) {
            console.error(`[Planner] CLI Execution Exception:`, error);
        }
    }

    private async createSubAgent(name: string, config: any): Promise<void> {
        this.log(chalk.green(`[Planner] Creating sub-agent: ${name}`)); // Use chalk

        // 1. Resolve Model
        let resolvedConfig = config;
        if (this.modelSwitchingManager) {
            // If config.model is a description, switchModel will handle logic
            // But strict config object usually expects model ID.
            // User said: "using smart system switching... implementation must consider absolutely everything".
            // Example: { model: "fast, cheap..." }
            // We presume config.model contains the description or ID.
            if (config.model && typeof config.model === 'string') {
                const runtimeConfig = await this.modelSwitchingManager.switchModel(config.model);
                resolvedConfig = { ...config, ...runtimeConfig };
                // runtimeConfig has provider, model, systemPrompt(overridden), etc.
            }
        }

        // 2. Create Session for Sub-Agent
        // We need a specific LoadedAgent structure.
        // We can clone the planner's agent config and override.
        // Or create a minimal one.

        const sessionTools = await this.toolLoader.loadByNames(resolvedConfig.tools || ['files']); // Default tools
        // Ensure 'files' is present?

        // We simply assume 'files' is needed for context sharing

        // Construct components
        const provider = getProvider(resolvedConfig.provider || 'gemini');
        const syntax = getSyntax('xml-tags'); // Default syntax
        const loop = getLoop('accumulator'); // Default loop for executor

        // Fake LoadedAgent
        const subAgentLoaded: LoadedAgent = {
            config: {
                name: name,
                model: resolvedConfig.model,
                systemPrompt: 'dynamic', // Placeholder
                loop: 'accumulator',
                syntax: 'xml-tags',
                tools: [],
                planner: undefined,
                executor: undefined
            },
            systemPromptContent: resolvedConfig.systemPrompt || 'You are a helpful assistant.',
            directory: this.plannerSession.agent.directory // Share directory?
        };

        const session = new Session({
            agent: subAgentLoaded,
            provider: provider,
            syntax: syntax,
            loop: loop,
            tools: sessionTools
        });

        await session.initialize();
        this.subAgents.set(name, session);
    }

    private async switchSubAgent(name: string): Promise<void> {
        if (name === 'default' || name === 'base') {
            this.log(chalk.green(`[Planner] Switching to default executor`)); // Use chalk
            await this.ensureDefaultExecutor();
            return;
        }

        const session = this.subAgents.get(name);
        if (session) {
            this.log(chalk.green(`[Planner] Switching to sub-agent: ${name}`)); // Use chalk
            this.currentExecutorSession = session;
            this.currentExecutor = new Executor(session, this.options);
        } else {
            console.warn(`[Planner] Warning: Sub-agent ${name} not found. Keeping current.`);
        }
    }

    private async ensureDefaultExecutor() {
        // Create initial default executor if not exists
        // Using AgentConfig.executor
        // This is effectively the "default" subagent
        if (this.subAgents.has('default')) {
            await this.switchSubAgent('default');
            return;
        }

        // Create 'default' based on config
        const agentConfig = this.plannerSession.agent.config;
        if (agentConfig.executor) {
            await this.createSubAgent('default', {
                model: agentConfig.executor.model,
                provider: agentConfig.executor.provider,
                systemPrompt: this.plannerSession.agent.executorSystemPromptContent || agentConfig.executor.systemPrompt,
                // Inherit or defaults
            });
            await this.switchSubAgent('default');
        } else {
            // Fallback to purely cloning session if no executor config?
            // Or error
            console.error("[Planner] No default executor configuration found.");
        }
    }

    private log(msg: string) {
        if (this.options.callbacks?.onThinking && !this.options.stream) {
            this.options.callbacks.onThinking(msg);
        } else {
            console.log(msg);
        }
    }

    /**
     * Get response from provider (either streaming or complete)
     */
    private async getModelResponse(messages: any[], config: any): Promise<{ text: string; reasoning?: string }> {
        if (config.stream && this.plannerSession.provider.streamEvents) {
            return this.streamWithEvents(messages, config);
        }

        const response = await this.plannerSession.provider.complete(messages, config);
        return {
            text: response.content,
            reasoning: response.reasoning
        };
    }

    /**
     * Stream response with proper event handling
     */
    private async streamWithEvents(messages: any[], config: any): Promise<{ text: string; reasoning: string }> {
        let reasoning = '';
        let text = '';

        for await (const event of this.plannerSession.provider.streamEvents!(messages, config)) {
            switch (event.type) {
                case 'reasoning.delta':
                    if (event.delta) {
                        reasoning += event.delta;
                        this.options.callbacks?.onReasoningDelta?.(event.delta, reasoning);
                    }
                    break;
                case 'reasoning.done':
                    this.options.callbacks?.onReasoningDone?.(reasoning);
                    break;
                case 'text.delta':
                    if (event.delta) {
                        text += event.delta;
                        this.options.callbacks?.onTextDelta?.(event.delta, text);
                    }
                    break;
                case 'text.done':
                    this.options.callbacks?.onTextDone?.(text);
                    break;
            }
        }

        return { text, reasoning };
    }
}
