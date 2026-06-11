import type { ModelSwitchingConfig } from '../../types/index.js';

export interface ModelAliasResolution {
  provider: string;
  model: string;
  changed: boolean;
}

function normalize(value: unknown): string {
  return String(value || '').trim();
}

function normalizeKey(value: unknown): string {
  return normalize(value).toLowerCase();
}

function parseProviderModel(value: string): { provider: string; model: string } | null {
  const text = normalize(value);
  const slash = text.indexOf('/');
  if (slash <= 0 || slash >= text.length - 1) {
    return null;
  }
  return {
    provider: text.slice(0, slash),
    model: text.slice(slash + 1),
  };
}

function resolveAliasTarget(
  target: string | { provider?: string; model?: string },
  sourceProvider: string,
  sourceModel: string
): { provider: string; model: string } | null {
  if (typeof target === 'string') {
    const parsed = parseProviderModel(target);
    return parsed || { provider: sourceProvider, model: normalize(target) || sourceModel };
  }

  if (!target || typeof target !== 'object') {
    return null;
  }

  const provider = normalize(target.provider) || sourceProvider;
  const model = normalize(target.model) || sourceModel;
  return model ? { provider, model } : null;
}

export function resolveModelAlias(
  switchingConfig: ModelSwitchingConfig | undefined,
  provider: string,
  model: string
): ModelAliasResolution {
  const sourceProvider = normalize(provider) || 'openrouter';
  const sourceModel = normalize(model);
  const aliases = switchingConfig?.aliases;

  if (!aliases || !sourceModel) {
    return { provider: sourceProvider, model: sourceModel, changed: false };
  }

  const fullKey = `${sourceProvider}/${sourceModel}`;
  const entries = Object.entries(aliases);
  const match = entries.find(([key]) => normalizeKey(key) === normalizeKey(fullKey))
    || entries.find(([key]) => normalizeKey(key) === normalizeKey(sourceModel));

  if (!match) {
    return { provider: sourceProvider, model: sourceModel, changed: false };
  }

  const target = resolveAliasTarget(match[1], sourceProvider, sourceModel);
  if (!target) {
    return { provider: sourceProvider, model: sourceModel, changed: false };
  }

  return {
    provider: target.provider,
    model: target.model,
    changed: normalizeKey(target.provider) !== normalizeKey(sourceProvider)
      || normalizeKey(target.model) !== normalizeKey(sourceModel),
  };
}
