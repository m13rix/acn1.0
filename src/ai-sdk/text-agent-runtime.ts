import {
  generateText,
  hasToolCall,
  jsonSchema,
  stepCountIs,
  streamText,
  tool,
  ToolLoopAgent,
} from 'ai';
import type { ModelMessage, StepResult, ToolSet } from 'ai';
import type { ProviderOptions } from '@ai-sdk/provider-utils';
import type { Session, SessionSnapshot } from '../core/Session.js';
import type { ExecutorCheckpointMetadata, ExecutorOptions } from '../core/Executor.js';
import type { ToolExecutionEngine, ToolExecutionResult } from '../core/ToolExecutionEngine.js';
import {
  buildCompletionContinuationMessage,
  buildCompletionWarning,
  PRIMARY_COMPLETION_FUNCTION,
} from '../core/completion.js';
import { buildProviderToolRequest } from '../core/providerTools.js';
import { buildPromptCacheKey, recordCostLedgerEntry } from '../core/CostLedger.js';
import { getAdaptiveStepContextService } from '../adaptive-step-context/Service.js';
import { getInstructionAlgorithmService } from '../instruction-algorithm/Service.js';
import { mapTextModelSettings, resolveTextLanguageModel } from './model-registry.js';
import { resolveModelAlias } from '../services/model-selection/ModelAliases.js';
import { selectNotDiamondModelForSubagent } from '../services/model-selection/NotDiamondRouter.js';
import {
  splitSystemMessages,
  telosMessagesToModelMessages,
} from './message-mapper.js';
import type { Message, ProviderConfig, ProviderToolCall, ProviderToolDefinition } from '../types/index.js';

const DEFAULT_MAX_ITERATIONS = 500;
const MAX_NO_PROGRESS_TURNS = 3;

export interface AiSdkTextAgentRuntimeContext {
  session: Session;
  options: ExecutorOptions;
  processFileMessages: () => Promise<void>;
  processMemoryMessages: () => Promise<void>;
  toolEngine: ToolExecutionEngine;
}

interface RuntimeState {
  iteration: number;
  noProgressTurns: number;
  finishMessage?: string;
}

function lastUserMessage(session: Session): string {
  const messages = session.getMessages();
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message?.role === 'user') {
      return message.content;
    }
  }
  return '';
}

function checkpoint(
  session: Session,
  options: ExecutorOptions,
  reason: string
): Promise<void> {
  if (!options.onCheckpoint) {
    return Promise.resolve();
  }

  return Promise.resolve(options.onCheckpoint(session.exportSnapshot(), { reason } satisfies ExecutorCheckpointMetadata));
}

function providerConfigForSession(session: Session, stream: boolean | undefined): ProviderConfig {
  const baseConfig = session.getProviderConfig();
  const promptCacheKey = buildPromptCacheKey(session, {
    ...baseConfig,
    stream,
    stopSequences: [],
  });
  const existingOptions = (baseConfig.providerOptions || {}) as Record<string, unknown>;
  const existingOpenAi = existingOptions['openai'] && typeof existingOptions['openai'] === 'object' && !Array.isArray(existingOptions['openai'])
    ? existingOptions['openai'] as Record<string, unknown>
    : {};

  return {
    ...baseConfig,
    provider: session.agent.config.provider || session.provider.name,
    providerOptions: {
      ...existingOptions,
      openai: {
        ...existingOpenAi,
        promptCacheKey: existingOpenAi['promptCacheKey'] || promptCacheKey,
        promptCacheRetention: existingOpenAi['promptCacheRetention'] || '24h',
      },
    },
    stream,
    stopSequences: [],
  };
}

function resolveProviderConfigAliases(session: Session, config: ProviderConfig): ProviderConfig {
  const provider = config.provider || session.agent.config.provider || session.provider.name || 'openrouter';
  const resolved = resolveModelAlias(session.agent.config.modelSwitching, provider, config.model);
  return {
    ...config,
    provider: resolved.provider,
    model: resolved.model,
  };
}

function toProviderToolCall(name: string, input: unknown, toolCallId: string): ProviderToolCall {
  return {
    id: toolCallId,
    name,
    arguments: input && typeof input === 'object' && !Array.isArray(input)
      ? { ...(input as Record<string, unknown>) }
      : {},
  };
}

function outputToModelText(result: ToolExecutionResult): string {
  let observation = result.observation;
  if (result.finishParseError) {
    observation += `\nSYSTEM: ${result.finishParseError}`;
  }
  return observation;
}

function buildToolSchema(definition: ProviderToolDefinition): ReturnType<typeof jsonSchema> {
  return jsonSchema((definition.function.parameters || {
    type: 'object',
    properties: {},
  }) as any);
}

function buildAiSdkTools(context: AiSdkTextAgentRuntimeContext, state: RuntimeState): ToolSet {
  const toolRequest = buildProviderToolRequest(context.options.requireFinish ?? true);
  const tools: ToolSet = {};

  // Per-step cache to deduplicate identical tool calls within a single model response.
  // Key: `toolName::contentHash`, Value: cached result promise.
  // This prevents the model from executing the same action/cli twice when it
  // mistakenly emits duplicate tool calls in one step.
  const stepDeduplicationCache = new Map<string, Promise<any>>();

  for (const definition of toolRequest.tools) {
    const name = definition.function.name;
    tools[name] = tool({
      description: definition.function.description,
      inputSchema: buildToolSchema(definition),
      strict: definition.function.strict,
      execute: async (input: unknown, executeOptions: { toolCallId: string }) => {
        const toolCall = toProviderToolCall(name, input, executeOptions.toolCallId);

        // Deduplicate identical tool calls (same tool name + same arguments)
        const contentKey = `${name}::${JSON.stringify(toolCall.arguments)}`;
        const cached = stepDeduplicationCache.get(contentKey);
        if (cached) {
          return cached;
        }

        const executePromise = (async () => {
          const result = await context.toolEngine.executeProviderToolCall(toolCall);
          const observation = outputToModelText(result);

          context.options.callbacks?.onObservation?.(observation);

          if (toolCall.name === 'action') {
            await context.processFileMessages();
            await context.processMemoryMessages();
          }

          const modelObservation = await context.session.enrichToolResponseWithMemoryHints(
            observation,
            context.options.callbacks,
          );

          if (result.finishMessage) {
            state.finishMessage = result.finishMessage;
          }

          return {
            observation: modelObservation,
            filename: result.filename,
            finishMessage: result.finishMessage,
          };
        })();

        stepDeduplicationCache.set(contentKey, executePromise);
        return executePromise;
      },
      toModelOutput: ({ output }: { output: { observation?: unknown } }) => ({
        type: 'text',
        value: String(output?.observation ?? ''),
      }),
    } as any);
  }

  return tools;
}

async function getGenerationMessages(session: Session): Promise<{ system: string; messages: ModelMessage[]; telosMessages: Message[] }> {
  await getAdaptiveStepContextService().waitForPendingEmbeddings();
  const telosMessages = session.getAllMessages();
  const { system, messages } = splitSystemMessages(telosMessages);
  return {
    system,
    messages: telosMessagesToModelMessages(messages),
    telosMessages,
  };
}

function outputToObservation(output: unknown): string {
  if (output && typeof output === 'object' && !Array.isArray(output)) {
    const record = output as Record<string, unknown>;
    if (record['observation'] !== undefined) return String(record['observation'] ?? '');
    if (record['value'] !== undefined) return String(record['value'] ?? '');
  }
  if (typeof output === 'string') return output;
  try {
    return JSON.stringify(output ?? '');
  } catch {
    return String(output ?? '');
  }
}

function stepContentToTelosMessages(step: StepResult<ToolSet>, stepNumber: number = step.stepNumber): Message[] {
  const assistantContent: string[] = [];
  const assistantReasoning: string[] = [];
  const toolCalls: ProviderToolCall[] = [];
  const toolMessages: Message[] = [];

  for (const part of step.content || []) {
    if (part.type === 'reasoning') {
      if (part.text?.trim()) assistantReasoning.push(part.text);
    } else if (part.type === 'text') {
      if (part.text?.trim()) assistantContent.push(part.text);
    } else if (part.type === 'tool-call') {
      toolCalls.push(toProviderToolCall(
        String((part as any).toolName || 'unknown'),
        (part as any).input,
        String((part as any).toolCallId || `tool_${toolCalls.length}`)
      ));
    } else if (part.type === 'tool-result' || part.type === 'tool-error') {
      toolMessages.push({
        role: 'tool',
        content: outputToObservation((part as any).output ?? (part as any).error),
        toolCallId: String((part as any).toolCallId || ''),
        toolName: String((part as any).toolName || ''),
      });
    }
  }

  const messages: Message[] = [];
  if (assistantContent.length > 0 || assistantReasoning.length > 0 || toolCalls.length > 0) {
    messages.push({
      role: 'assistant',
      content: assistantContent.join(''),
      reasoning: assistantReasoning.join('\n'),
      toolCalls,
      adaptiveStepIndex: stepNumber,
    });
  }
  messages.push(...toolMessages.map(message => ({ ...message, adaptiveStepIndex: stepNumber })));
  return messages;
}

function appendTelosMessages(session: Session, telosMessages: Message[]): void {
  for (const message of telosMessages) {
    session.addMessage(message);
  }
}

async function appendStep(session: Session, options: ExecutorOptions, step: StepResult<ToolSet>, stepNumber: number): Promise<void> {
  const telosMessages = stepContentToTelosMessages(step, stepNumber);
  appendTelosMessages(session, telosMessages);
  getAdaptiveStepContextService().recordStep({
    session,
    messages: telosMessages,
    stepNumber,
  });
  session.setExecutionState({
    mode: 'provider-tools',
    iterations: stepNumber + 1,
    pendingProviderToolCalls: [],
    nextProviderToolIndex: 0,
  });
  await checkpoint(session, options, 'ai-sdk-step-finished');
}

function automaticStopMessage(lastText: string): string {
  const baseMessage = lastText.trim() || '(no content generated)';
  return `${baseMessage}\n\n[Automatic stop: the agent stopped making progress and never called ${PRIMARY_COMPLETION_FUNCTION}.]`;
}

function createAgent(context: AiSdkTextAgentRuntimeContext, state: RuntimeState, config: ProviderConfig) {
  const providerName = config.provider || context.session.agent.config.provider || 'openrouter';
  const { model, providerOptions } = resolveTextLanguageModel(providerName, config);
  const settings = mapTextModelSettings(config);
  const tools = buildAiSdkTools(context, state);
  const maxIterations = context.options.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  const instructionStepMode = getInstructionAlgorithmService().isEnabled(context.session.agent);
  const remainingSteps = instructionStepMode
    ? 1
    : Math.max(1, maxIterations - state.iteration);
  const promptCacheKey = buildPromptCacheKey(context.session, config);
  let lastRequestTelosMessages: Message[] = [];

  const prepareStep = async () => {
    await context.processFileMessages();
    await context.processMemoryMessages();

    const latest = await getGenerationMessages(context.session);
    lastRequestTelosMessages = latest.telosMessages;
    context.options.callbacks?.onBeforeProviderCall?.(
      latest.telosMessages,
      config,
      undefined
    );

    context.session.setExecutionState({
      mode: 'provider-tools',
      iterations: state.iteration,
      noProgressTurns: state.noProgressTurns,
      pendingProviderToolCalls: [],
      nextProviderToolIndex: 0,
    });
    await checkpoint(context.session, context.options, 'ai-sdk-before-provider-call');

    return {
      system: latest.system || undefined,
      messages: latest.messages,
    };
  };

  const onStepFinish = async (step: StepResult<ToolSet>) => {
    const globalStepNumber = state.iteration;
    state.iteration += 1;
    await recordCostLedgerEntry({
      session: context.session,
      config,
      messages: lastRequestTelosMessages,
      usage: (step as any).usage || (step as any).response?.usage,
      reason: 'ai-sdk-step-finished',
      stepNumber: globalStepNumber,
      promptCacheKey,
    });
    await appendStep(context.session, context.options, step as StepResult<ToolSet>, globalStepNumber);
  };

  const agent = new ToolLoopAgent({
    model,
    tools,
    toolChoice: 'auto',
    stopWhen: [
      stepCountIs(remainingSteps),
      hasToolCall(PRIMARY_COMPLETION_FUNCTION),
    ],
    providerOptions: providerOptions as ProviderOptions | undefined,
    ...settings,
    prepareStep,
    onStepFinish,
  } as any);

  (agent as any).__telosDirectConfig = {
    model,
    tools,
    settings,
    providerOptions: providerOptions as ProviderOptions | undefined,
    remainingSteps,
    prepareStep,
    onStepFinish,
  };

  return agent;
}

async function resolveInstructionProviderConfig(
  session: Session,
  options: ExecutorOptions,
  baseConfig: ProviderConfig
): Promise<ProviderConfig> {
  const instructionModel = getInstructionAlgorithmService().getActiveModelOverride(session);
  if (!instructionModel?.model) {
    return resolveProviderConfigAliases(session, baseConfig);
  }

  const requestedModel = instructionModel.model;
  const routingResult = await selectNotDiamondModelForSubagent({
    requestedModel,
    baseProvider: baseConfig.provider || session.agent.config.provider || session.provider.name || 'openrouter',
    switchingConfig: session.agent.config.modelSwitching,
    fullSystemPrompt: session.getSystemPrompt(),
    userMessage: lastUserMessage(session),
  });

  if (routingResult.executionModel) {
    options.callbacks?.onModelSelected?.(
      routingResult.executionModel,
      routingResult.executionProvider,
      `instruction step: ${routingResult.reason}`
    );
    return resolveProviderConfigAliases(session, {
      ...baseConfig,
      provider: routingResult.executionProvider,
      model: routingResult.executionModel,
    });
  }

  return resolveProviderConfigAliases(session, {
    ...baseConfig,
    ...instructionModel,
  });
}

async function runStreamingAgent(agent: ToolLoopAgent<any, ToolSet, any>, messages: ModelMessage[], context: AiSdkTextAgentRuntimeContext) {
  const directConfig = (agent as any).__telosDirectConfig;
  const provider = context.session.agent.config.provider;

  if (provider === 'kimi-code' && directConfig) {
    const result = streamText({
      model: directConfig.model,
      tools: directConfig.tools,
      toolChoice: 'auto',
      stopWhen: [
        stepCountIs(directConfig.remainingSteps),
        hasToolCall(PRIMARY_COMPLETION_FUNCTION),
      ],
      providerOptions: directConfig.providerOptions,
      ...directConfig.settings,
      messages,
      prepareStep: directConfig.prepareStep,
      onStepFinish: directConfig.onStepFinish,
    });

    let text = '';
    let reasoning = '';

    for await (const part of result.fullStream) {
      if (part.type === 'reasoning-delta') {
        reasoning += part.text;
        context.options.callbacks?.onReasoningDelta?.(part.text, reasoning);
      } else if (part.type === 'reasoning-end') {
        context.options.callbacks?.onReasoningDone?.(reasoning);
      } else if (part.type === 'text-delta') {
        text += part.text;
        context.options.callbacks?.onTextDelta?.(part.text, text);
        context.options.callbacks?.onStreamChunk?.(part.text, text);
      } else if (part.type === 'text-end') {
        context.options.callbacks?.onTextDone?.(text);
      } else if (part.type === 'error') {
        throw part.error instanceof Error ? part.error : new Error(String(part.error));
      }
    }

    return {
      text: await result.text,
      reasoningText: reasoning,
      usage: (result as any).usage,
    };
  }

  const result = await agent.stream({ messages } as any);
  let text = '';
  let reasoning = '';

  for await (const part of result.fullStream) {
    if (part.type === 'reasoning-delta') {
      reasoning += part.text;
      context.options.callbacks?.onReasoningDelta?.(part.text, reasoning);
    } else if (part.type === 'reasoning-end') {
      context.options.callbacks?.onReasoningDone?.(reasoning);
    } else if (part.type === 'text-delta') {
      text += part.text;
      context.options.callbacks?.onTextDelta?.(part.text, text);
      context.options.callbacks?.onStreamChunk?.(part.text, text);
    } else if (part.type === 'text-end') {
      context.options.callbacks?.onTextDone?.(text);
    } else if (part.type === 'error') {
      throw part.error instanceof Error ? part.error : new Error(String(part.error));
    }
  }

  return {
    text: await result.text,
    reasoningText: await result.reasoningText,
    usage: (result as any).usage,
  };
}

async function runNonStreamingAgent(agent: ToolLoopAgent<any, ToolSet, any>, messages: ModelMessage[], context: AiSdkTextAgentRuntimeContext) {
  const directConfig = (agent as any).__telosDirectConfig;
  const provider = context.session.agent.config.provider;

  if (provider === 'kimi-code' && directConfig) {
    const result = await generateText({
      model: directConfig.model,
      tools: directConfig.tools,
      toolChoice: 'auto',
      stopWhen: [
        stepCountIs(directConfig.remainingSteps),
        hasToolCall(PRIMARY_COMPLETION_FUNCTION),
      ],
      providerOptions: directConfig.providerOptions,
      ...directConfig.settings,
      messages,
      prepareStep: directConfig.prepareStep,
      onStepFinish: directConfig.onStepFinish,
    });

    if (result.reasoningText) {
      context.options.callbacks?.onReasoningDone?.(result.reasoningText);
    }
    context.options.callbacks?.onTextDone?.(result.text || '');

    return {
      text: result.text || '',
      reasoningText: result.reasoningText,
      usage: (result as any).usage,
    };
  }

  const result = await agent.generate({ messages } as any);
  if (result.reasoningText) {
    context.options.callbacks?.onReasoningDone?.(result.reasoningText);
  }
  context.options.callbacks?.onTextDone?.(result.text || '');
  return {
    text: result.text || '',
    reasoningText: result.reasoningText,
    usage: (result as any).usage,
  };
}

export async function runAiSdkTextAgent(context: AiSdkTextAgentRuntimeContext): Promise<string> {
  const { session, options } = context;
  const maxIterations = options.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  const state: RuntimeState = {
    iteration: session.getExecutionState()?.mode === 'provider-tools'
      ? session.getExecutionState()?.iterations ?? 0
      : 0,
    noProgressTurns: session.getExecutionState()?.mode === 'provider-tools'
      ? session.getExecutionState()?.noProgressTurns ?? 0
      : 0,
  };
  let lastGeneratedText = '';

  while (state.iteration < maxIterations) {
    const baseConfig = providerConfigForSession(session, options.stream);
    const config = await resolveInstructionProviderConfig(session, options, baseConfig);
    const latest = await getGenerationMessages(session);
    const agent = createAgent(context, state, config);

    const result = options.stream
      ? await runStreamingAgent(agent as ToolLoopAgent<any, ToolSet, any>, latest.messages, context)
      : await runNonStreamingAgent(agent as ToolLoopAgent<any, ToolSet, any>, latest.messages, context);
    await recordCostLedgerEntry({
      session,
      config,
      messages: latest.telosMessages,
      usage: (result as any).usage,
      reason: 'ai-sdk-run-result',
      promptCacheKey: buildPromptCacheKey(session, config),
    });

    lastGeneratedText = result.text || lastGeneratedText;

    if (state.finishMessage) {
      session.clearExecutionState();
      await checkpoint(session, options, 'ai-sdk-finish-message');
      options.callbacks?.onResponse?.(state.finishMessage);
      return state.finishMessage;
    }

    if (!(options.requireFinish ?? true)) {
      const message = result.text || '(no content generated)';
      session.clearExecutionState();
      await checkpoint(session, options, 'ai-sdk-natural-complete');
      options.callbacks?.onResponse?.(message);
      return message;
    }

    state.noProgressTurns += 1;
    if (state.noProgressTurns >= MAX_NO_PROGRESS_TURNS && !options.requireFinish) {
      const message = automaticStopMessage(lastGeneratedText);
      session.addAssistantMessage(message);
      session.clearExecutionState();
      await checkpoint(session, options, 'ai-sdk-automatic-stop');
      options.callbacks?.onResponse?.(message);
      return message;
    }

    const warningMessage = buildCompletionWarning();
    session.addUserMessage(warningMessage);
    session.setExecutionState({
      mode: 'provider-tools',
      iterations: state.iteration,
      noProgressTurns: state.noProgressTurns,
      continuationUserMessage: buildCompletionContinuationMessage(),
      lastModelTurnContent: lastGeneratedText,
      pendingProviderToolCalls: [],
      nextProviderToolIndex: 0,
    });
    await checkpoint(session, options, 'ai-sdk-completion-warning');
  }

  const message = '[Max iterations reached. Please continue with a new message if needed.]';
  session.clearExecutionState();
  await checkpoint(session, options, 'ai-sdk-max-iterations');
  options.callbacks?.onResponse?.(message);
  return message;
}

export type AiSdkTextRuntimeSnapshot = SessionSnapshot;
