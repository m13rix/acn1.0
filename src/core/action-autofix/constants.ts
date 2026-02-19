import type { ActionAutoFixConfig } from '../../types/index.js';

export interface ResolvedActionAutoFixConfig {
  enabled: boolean;
  maxAttempts: number;
  visibility: 'brief' | 'silent' | 'verbose';
  deterministic: {
    enabled: boolean;
    autoInstallMissingPackages: boolean;
  };
  modelRepair: {
    enabled: boolean;
    provider: string;
    model: string;
    temperature: number;
    maxTokens: number;
  };
}

export const DEFAULT_ACTION_AUTOFIX_CONFIG: ResolvedActionAutoFixConfig = {
  enabled: true,
  maxAttempts: 2,
  visibility: 'brief',
  deterministic: {
    enabled: true,
    autoInstallMissingPackages: true,
  },
  modelRepair: {
    enabled: true,
    provider: 'openrouter',
    model: 'openai/gpt-oss-20b',
    temperature: 0.1,
    maxTokens: 4000,
  },
};

export const BUILTIN_IDENTIFIER_TO_MODULE: Record<string, string> = {
  assert: 'assert',
  buffer: 'buffer',
  child_process: 'child_process',
  crypto: 'crypto',
  events: 'events',
  fs: 'fs',
  http: 'http',
  https: 'https',
  os: 'os',
  path: 'path',
  stream: 'stream',
  url: 'url',
  util: 'util',
  zlib: 'zlib',
};

export function resolveActionAutoFixConfig(config?: ActionAutoFixConfig): ResolvedActionAutoFixConfig {
  const merged: ResolvedActionAutoFixConfig = {
    enabled: config?.enabled ?? DEFAULT_ACTION_AUTOFIX_CONFIG.enabled,
    maxAttempts: config?.maxAttempts ?? DEFAULT_ACTION_AUTOFIX_CONFIG.maxAttempts,
    visibility: config?.visibility ?? DEFAULT_ACTION_AUTOFIX_CONFIG.visibility,
    deterministic: {
      enabled: config?.deterministic?.enabled ?? DEFAULT_ACTION_AUTOFIX_CONFIG.deterministic.enabled,
      autoInstallMissingPackages:
        config?.deterministic?.autoInstallMissingPackages
        ?? DEFAULT_ACTION_AUTOFIX_CONFIG.deterministic.autoInstallMissingPackages,
    },
    modelRepair: {
      enabled: config?.modelRepair?.enabled ?? DEFAULT_ACTION_AUTOFIX_CONFIG.modelRepair.enabled,
      provider: config?.modelRepair?.provider ?? DEFAULT_ACTION_AUTOFIX_CONFIG.modelRepair.provider,
      model: config?.modelRepair?.model ?? DEFAULT_ACTION_AUTOFIX_CONFIG.modelRepair.model,
      temperature: config?.modelRepair?.temperature ?? DEFAULT_ACTION_AUTOFIX_CONFIG.modelRepair.temperature,
      maxTokens: config?.modelRepair?.maxTokens ?? DEFAULT_ACTION_AUTOFIX_CONFIG.modelRepair.maxTokens,
    },
  };

  if (!Number.isFinite(merged.maxAttempts) || merged.maxAttempts < 0) {
    merged.maxAttempts = DEFAULT_ACTION_AUTOFIX_CONFIG.maxAttempts;
  } else {
    merged.maxAttempts = Math.floor(merged.maxAttempts);
  }

  return merged;
}
