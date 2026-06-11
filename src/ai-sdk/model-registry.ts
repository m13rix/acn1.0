import type { LanguageModel } from 'ai';
import type { ProviderOptions } from '@ai-sdk/provider-utils';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import type { ProviderConfig } from '../types/index.js';
import { createOpenAICodexLanguageModel } from './openai-codex-model.js';

export interface TextModelResolution {
  model: LanguageModel;
  providerOptions?: ProviderOptions;
}

export interface TextModelSettings {
  maxOutputTokens?: number;
  temperature?: number;
  topP?: number;
  topK?: number;
  seed?: number;
  frequencyPenalty?: number;
  presencePenalty?: number;
  stopSequences?: string[];
}

function normalizeProviderName(provider?: string): string {
  return String(provider || 'openrouter').trim().toLowerCase();
}

function requireEnv(name: string, message: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(message);
  }
  return value;
}

function ollamaOpenAiBaseUrl(): string {
  const host = (process.env.OLLAMA_HOST || 'http://localhost:11434').replace(/\/+$/, '');
  return host.endsWith('/v1') ? host : `${host}/v1`;
}

function providerOptionKey(provider: string): string {
  if (provider === 'kimi-code') return 'anthropic';
  return provider.replace(/-([a-z])/g, (_match, char: string) => char.toUpperCase());
}

function mapReasoningEffort(reasoning: ProviderConfig['reasoning']): 'none' | 'low' | 'medium' | 'high' {
  switch (reasoning) {
    case 'off':
      return 'none';
    case 'low':
      return 'low';
    case 'high':
      return 'high';
    case 'medium':
    default:
      return 'medium';
  }
}

function mapGoogleThinkingConfig(model: string, reasoning: ProviderConfig['reasoning']): Record<string, unknown> | undefined {
  const level = reasoning ?? 'medium';
  const normalizedModel = model.toLowerCase();
  if (normalizedModel.includes('gemini-3')) {
    if (normalizedModel.includes('gemini-3-pro') && (level === 'off' || level === 'medium')) {
      return { thinkingLevel: 'high' };
    }
    return { thinkingLevel: level === 'off' ? 'minimal' : level };
  }

  if (level === 'off') {
    return { thinkingBudget: normalizedModel.includes('gemini-2.5-pro') ? 128 : 0 };
  }
  if (level === 'low') return { thinkingBudget: 2048 };
  if (level === 'high') return { thinkingBudget: 24576 };
  return { thinkingBudget: -1 };
}

function mergeProviderOptions(
  provider: string,
  model: string,
  config: ProviderConfig
): ProviderOptions | undefined {
  const existing = (config.providerOptions || {}) as Record<string, unknown>;
  const key = providerOptionKey(provider);
  const out: Record<string, unknown> = { ...existing };
  const nested = (out[key] && typeof out[key] === 'object' && !Array.isArray(out[key]))
    ? { ...(out[key] as Record<string, unknown>) }
    : {};

  if (!out[key] && Object.keys(existing).length > 0) {
    Object.assign(nested, existing);
  }

  if (provider === 'openrouter') {
    nested['reasoning'] = {
      effort: mapReasoningEffort(config.reasoning),
      enabled: config.reasoning !== 'off',
    };
    nested['usage'] = { include: true };
  } else if (provider === 'gemini' || provider === 'google') {
    const thinkingConfig = mapGoogleThinkingConfig(model, config.reasoning);
    if (thinkingConfig) {
      nested['thinkingConfig'] = thinkingConfig;
    }
  } else if (provider === 'inception') {
    nested['reasoning_effort'] = config.reasoning === 'off' || !config.reasoning ? 'instant' : config.reasoning;
  } else if (provider === 'kimi-code') {
    if (config.reasoning && config.reasoning !== 'off') {
      const budgetTokens = config.reasoning === 'low' ? 1024 : config.reasoning === 'high' ? 4096 : 2048;
      nested['thinking'] = { type: 'enabled', budgetTokens };
    } else {
      nested['thinking'] = { type: 'disabled' };
    }
  }

  if (Object.keys(nested).length > 0) {
    out[key] = nested;
  }

  return Object.keys(out).length > 0 ? out as ProviderOptions : undefined;
}

export function resolveTextLanguageModel(
  providerName: string | undefined,
  config: ProviderConfig,
  apiKeyOverride?: string
): TextModelResolution {
  const provider = normalizeProviderName(providerName);
  const modelId = config.model;

  if (!modelId) {
    throw new Error('Model is required in provider config');
  }

  let model: LanguageModel;
  if (provider === 'openrouter') {
    const openrouter = createOpenRouter({
      apiKey: apiKeyOverride || requireEnv('OPENROUTER_API_KEY', 'OPENROUTER_API_KEY is required for the OpenRouter provider.'),
    });
    model = openrouter.chat(modelId);
  } else if (provider === 'gemini' || provider === 'google') {
    const google = createGoogleGenerativeAI({
      apiKey: apiKeyOverride || process.env.GEMINI_KEY || process.env.GOOGLE_GENERATIVE_AI_API_KEY,
    });
    model = google.chat(modelId);
  } else if (provider === 'ollama') {
    const ollama = createOpenAICompatible({
      name: 'ollama',
      baseURL: ollamaOpenAiBaseUrl(),
      apiKey: process.env.OLLAMA_API_KEY || 'ollama',
      includeUsage: true,
    });
    model = ollama.chatModel(modelId);
  } else if (provider === 'inception') {
    const inception = createOpenAICompatible({
      name: 'inception',
      baseURL: process.env.INCEPTION_BASE_URL || 'https://api.inceptionlabs.ai/v1',
      apiKey: apiKeyOverride || requireEnv('INCEPTION_API_KEY', 'INCEPTION_API_KEY is required for the Inception provider.'),
      includeUsage: true,
    });
    model = inception.chatModel(modelId);
  } else if (provider === 'kimi-code') {
    const kimiCode = createAnthropic({
      baseURL: process.env.KIMI_CODE_BASE_URL || 'https://api.kimi.com/coding/v1',
      apiKey: apiKeyOverride || requireEnv('KIMI_API_CODE', 'KIMI_API_CODE is required for the Kimi Code provider.'),
    });
    model = kimiCode.chat(modelId);
  } else if (provider === 'openai-codex') {
    model = createOpenAICodexLanguageModel(modelId);
  } else {
    throw new Error(`Unknown text provider: ${providerName}`);
  }

  return {
    model,
    providerOptions: mergeProviderOptions(provider, modelId, config),
  };
}

export function mapTextModelSettings(config: ProviderConfig): TextModelSettings {
  return {
    maxOutputTokens: config.maxTokens,
    temperature: config.temperature,
    topP: config.top_p,
    topK: config.top_k,
    seed: config.seed,
    frequencyPenalty: config.frequency_penalty,
    presencePenalty: config.presence_penalty,
    stopSequences: config.stopSequences && config.stopSequences.length > 0 ? config.stopSequences : undefined,
  };
}
