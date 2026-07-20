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
const LOCAL_VLLM_DEFAULT_CONTEXT_TOKENS = 50000;
const LOCAL_VLLM_DEFAULT_OUTPUT_RESERVE_TOKENS = 4096;
const LOCAL_VLLM_DEFAULT_FILE_CHAR_LIMIT = 16000;
const LOCAL_VLLM_DEFAULT_OBSERVATION_CHAR_LIMIT = 20000;

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
  providerActionTurns: number;
}

const LOCAL_FINISH_FORCE_ACTION_TURNS = 6;

function usesDirectToolLoopRuntime(provider: string | undefined): boolean {
  return provider === 'kimi-code' || provider === 'opencode';
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

function isLocalVllmProvider(providerName: string | undefined): boolean {
  return String(providerName || '').trim().toLowerCase() === 'vllm';
}

function isLocalNativeFinishProvider(providerName: string | undefined): boolean {
  return isLocalVllmProvider(providerName);
}

function estimatePromptTokens(text: string): number {
  return Math.ceil(String(text || '').length / 3.5);
}

function estimateMessageTokens(message: Message): number {
  return estimatePromptTokens(message.content || '') + estimatePromptTokens(message.filename || '') + 8;
}

function readPositiveIntEnv(name: string): number | undefined {
  const raw = process.env[name];
  if (!raw) return undefined;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function truncateMiddle(text: string, maxChars: number, label: string): string {
  if (text.length <= maxChars) return text;
  const half = Math.max(1000, Math.floor((maxChars - 240) / 2));
  const omitted = text.length - (half * 2);
  return [
    text.slice(0, half),
    `\n\n[LOCAL CONTEXT BUDGET: omitted ${omitted} chars from the middle of ${label}. Re-read this file with a focused range if exact omitted code matters.]\n\n`,
    text.slice(-half),
  ].join('');
}

function budgetLocalVllmMessages(telosMessages: Message[], config: ProviderConfig): Message[] {
  const provider = config.provider || 'openrouter';
  if (!isLocalVllmProvider(provider)) {
    return telosMessages;
  }

  const contextTokens = readPositiveIntEnv('LOCAL_VLLM_CONTEXT_TOKENS') || LOCAL_VLLM_DEFAULT_CONTEXT_TOKENS;
  const outputReserveTokens = readPositiveIntEnv('LOCAL_VLLM_OUTPUT_RESERVE_TOKENS')
    || config.maxTokens
    || LOCAL_VLLM_DEFAULT_OUTPUT_RESERVE_TOKENS;
  const budgetTokens = Math.max(4096, contextTokens - outputReserveTokens);
  const fileCharLimit = readPositiveIntEnv('LOCAL_VLLM_FILE_CHAR_LIMIT') || LOCAL_VLLM_DEFAULT_FILE_CHAR_LIMIT;
  const observationCharLimit = readPositiveIntEnv('LOCAL_VLLM_OBSERVATION_CHAR_LIMIT') || LOCAL_VLLM_DEFAULT_OBSERVATION_CHAR_LIMIT;

  const systemMessages = telosMessages.filter(message => message.role === 'system');
  const rawFileMessages = telosMessages.filter(message => message.role === 'file');
  const fileMessages = telosMessages
    .filter(message => message.role === 'file')
    .map(message => {
      const next = {
        ...message,
        content: truncateMiddle(message.content || '', fileCharLimit, message.filename || 'file context'),
      };
      return next;
    });
  const rawHistoryMessages = telosMessages.filter(message => message.role !== 'system' && message.role !== 'file');
  const historyMessages = rawHistoryMessages.map(message => {
    if (message.role !== 'tool' || (message.content || '').length <= observationCharLimit) {
      return message;
    }
    return {
      ...message,
      content: truncateMiddle(message.content || '', observationCharLimit, `${message.toolName || 'tool'} observation`),
    };
  });

  let remaining = budgetTokens - systemMessages.reduce((sum, message) => sum + estimateMessageTokens(message), 0);
  const keptHistory: Message[] = [];
  const keptFiles: Message[] = [];
  let omittedHistory = 0;
  let omittedFiles = 0;
  const truncatedFiles = fileMessages.filter((message, index) => message.content !== rawFileMessages[index]?.content).length;
  const truncatedObservations = historyMessages.filter((message, index) => message.content !== rawHistoryMessages[index]?.content).length;

  for (let index = historyMessages.length - 1; index >= 0; index -= 1) {
    const message = historyMessages[index]!;
    const cost = estimateMessageTokens(message);
    const isMostRecentHistory = keptHistory.length === 0;
    if (cost <= remaining || isMostRecentHistory) {
      keptHistory.push(message);
      remaining -= cost;
    } else {
      omittedHistory += 1;
    }
  }
  keptHistory.reverse();

  for (let index = fileMessages.length - 1; index >= 0; index -= 1) {
    const message = fileMessages[index]!;
    const cost = estimateMessageTokens(message);
    if (cost <= remaining) {
      keptFiles.push(message);
      remaining -= cost;
    } else {
      omittedFiles += 1;
    }
  }
  keptFiles.reverse();

  if (omittedHistory === 0 && omittedFiles === 0 && truncatedFiles === 0 && truncatedObservations === 0) {
    return telosMessages;
  }

  const notice: Message = {
    role: 'user',
    content: [
      'LOCAL CONTEXT BUDGET:',
      `This local vLLM request was compacted to fit about ${budgetTokens} input tokens plus ${outputReserveTokens} reserved output tokens.`,
      omittedHistory > 0 ? `Omitted older conversation messages: ${omittedHistory}.` : '',
      omittedFiles > 0 ? `Omitted persistent file context entries: ${omittedFiles}.` : '',
      truncatedFiles > 0 ? `Truncated large file context entries: ${truncatedFiles}.` : '',
      truncatedObservations > 0 ? `Truncated large tool observations: ${truncatedObservations}.` : '',
      'Use focused files.read/files.search calls to retrieve omitted exact code when needed.',
    ].filter(Boolean).join('\n'),
  };

  return [
    ...systemMessages,
    notice,
    ...keptHistory,
    ...keptFiles,
  ];
}

function buildAiSdkTools(context: AiSdkTextAgentRuntimeContext, state: RuntimeState, providerName?: string): ToolSet {
  const useNativeFinish = isLocalNativeFinishProvider(providerName) && (context.options.requireFinish ?? true);
  const toolRequest = buildProviderToolRequest(context.options.requireFinish ?? true, {
    includeCompletionTool: useNativeFinish,
    strict: useNativeFinish,
  });
  const tools: ToolSet = {};

  // Per-step cache to deduplicate identical tool calls within a single model response.
  // Key: `toolName::contentHash`, Value: cached result promise.
  // This prevents the model from executing the same action/cli twice when it
  // mistakenly emits duplicate tool calls in one step.
  const stepDeduplicationCache = new Map<string, Promise<any>>();
  let stepToolExecutionTail: Promise<void> = Promise.resolve();

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

        const executePromise = stepToolExecutionTail.then(async () => {
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
        });
        stepToolExecutionTail = executePromise.then(() => undefined, () => undefined);

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

async function getGenerationMessages(session: Session, config?: ProviderConfig): Promise<{ system: string; messages: ModelMessage[]; telosMessages: Message[] }> {
  await getAdaptiveStepContextService().waitForPendingEmbeddings();
  const rawTelosMessages = session.getAllMessages();
  const telosMessages = config ? budgetLocalVllmMessages(rawTelosMessages, config) : rawTelosMessages;
  const { system, messages } = splitSystemMessages(telosMessages);
  return {
    system,
    messages: telosMessagesToModelMessages(messages, {
      preserveReasoning: session.agent.config.preserveReasoning === true,
    }),
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
  const tools = buildAiSdkTools(context, state, providerName);
  const localNativeFinish = isLocalNativeFinishProvider(providerName) && (context.options.requireFinish ?? true);
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

    const latest = await getGenerationMessages(context.session, config);
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

    const stepConfig: Record<string, unknown> = {
      system: latest.system || undefined,
      messages: latest.messages,
    };

    if (localNativeFinish) {
      if (
        state.providerActionTurns > 0
        && (state.noProgressTurns > 0 || state.providerActionTurns >= LOCAL_FINISH_FORCE_ACTION_TURNS)
      ) {
        stepConfig.activeTools = [PRIMARY_COMPLETION_FUNCTION];
        stepConfig.toolChoice = { type: 'tool', toolName: PRIMARY_COMPLETION_FUNCTION };
      } else if (state.providerActionTurns > 0) {
        stepConfig.activeTools = ['action', PRIMARY_COMPLETION_FUNCTION];
        stepConfig.toolChoice = 'auto';
      } else {
        stepConfig.activeTools = ['action'];
        stepConfig.toolChoice = 'auto';
      }
    }

    return stepConfig;
  };

  const onStepFinish = async (step: StepResult<ToolSet>) => {
    const globalStepNumber = state.iteration;
    state.iteration += 1;
    for (const part of step.content || []) {
      if (part.type === 'tool-call' && String((part as any).toolName || '').trim() === 'action') {
        state.providerActionTurns += 1;
      }
    }
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
    localNativeFinish,
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
  const emitFinalOutput = context.session.agent.config.suppressFinalOutput !== true;

  if (usesDirectToolLoopRuntime(provider) && directConfig) {
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
      abortSignal: context.options.signal,
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
        if (emitFinalOutput) {
          context.options.callbacks?.onTextDelta?.(part.text, text);
          context.options.callbacks?.onStreamChunk?.(part.text, text);
        }
      } else if (part.type === 'text-end') {
        if (emitFinalOutput) context.options.callbacks?.onTextDone?.(text);
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

  const result = await agent.stream({ messages, abortSignal: context.options.signal } as any);
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
      if (emitFinalOutput) {
        context.options.callbacks?.onTextDelta?.(part.text, text);
        context.options.callbacks?.onStreamChunk?.(part.text, text);
      }
    } else if (part.type === 'text-end') {
      if (emitFinalOutput) context.options.callbacks?.onTextDone?.(text);
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
  const emitFinalOutput = context.session.agent.config.suppressFinalOutput !== true;

  if (usesDirectToolLoopRuntime(provider) && directConfig) {
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
      abortSignal: context.options.signal,
    });

    if (result.reasoningText) {
      context.options.callbacks?.onReasoningDone?.(result.reasoningText);
    }
    if (emitFinalOutput) context.options.callbacks?.onTextDone?.(result.text || '');

    return {
      text: result.text || '',
      reasoningText: result.reasoningText,
      usage: (result as any).usage,
    };
  }

  const result = await agent.generate({ messages, abortSignal: context.options.signal } as any);
  if (result.reasoningText) {
    context.options.callbacks?.onReasoningDone?.(result.reasoningText);
  }
  if (emitFinalOutput) context.options.callbacks?.onTextDone?.(result.text || '');
  return {
    text: result.text || '',
    reasoningText: result.reasoningText,
    usage: (result as any).usage,
  };
}

export async function runAiSdkTextAgent(context: AiSdkTextAgentRuntimeContext): Promise<string> {
  const { session, options } = context;
  const emitFinalOutput = session.agent.config.suppressFinalOutput !== true;
  const maxIterations = options.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  const state: RuntimeState = {
    iteration: session.getExecutionState()?.mode === 'provider-tools'
      ? session.getExecutionState()?.iterations ?? 0
      : 0,
    noProgressTurns: session.getExecutionState()?.mode === 'provider-tools'
      ? session.getExecutionState()?.noProgressTurns ?? 0
      : 0,
    providerActionTurns: 0,
  };
  let lastGeneratedText = '';

  while (state.iteration < maxIterations) {
    const baseConfig = providerConfigForSession(session, options.stream);
    const config = await resolveInstructionProviderConfig(session, options, baseConfig);
    const latest = await getGenerationMessages(session, config);
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
      if (emitFinalOutput) options.callbacks?.onResponse?.(state.finishMessage);
      return emitFinalOutput ? state.finishMessage : '';
    }

    if (!(options.requireFinish ?? true)) {
      const message = result.text || '(no content generated)';
      session.clearExecutionState();
      await checkpoint(session, options, 'ai-sdk-natural-complete');
      if (emitFinalOutput) options.callbacks?.onResponse?.(message);
      return emitFinalOutput ? message : '';
    }

    state.noProgressTurns += 1;
    if (state.noProgressTurns >= MAX_NO_PROGRESS_TURNS && !options.requireFinish) {
      const message = automaticStopMessage(lastGeneratedText);
      session.addAssistantMessage(message);
      session.clearExecutionState();
      await checkpoint(session, options, 'ai-sdk-automatic-stop');
      if (emitFinalOutput) options.callbacks?.onResponse?.(message);
      return emitFinalOutput ? message : '';
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
  if (emitFinalOutput) options.callbacks?.onResponse?.(message);
  return emitFinalOutput ? message : '';
}

export type AiSdkTextRuntimeSnapshot = SessionSnapshot;
