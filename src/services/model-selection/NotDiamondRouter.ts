import { readFile } from 'fs/promises';
import { join, resolve } from 'path';
import type { ModelSwitchingConfig } from '../../types/index.js';

type SwitchingMode = 'whitelist' | 'allow_all' | 'blacklist';

interface NotDiamondModelEntry {
  id?: string;
  provider?: string;
  model?: string;
  openrouter_model?: string | null;
}

interface RoutingCandidate {
  name: string;
  notDiamondId: string;
  provider: string;
  model: string;
  executionProvider: string;
  executionModel: string;
}

export interface NotDiamondRoutingResult {
  requestedModel: string;
  notDiamondModel: string;
  notDiamondSessionId?: string;
  executionProvider: string;
  executionModel: string;
  changed: boolean;
  reason: string;
}

export interface SelectNotDiamondModelInput {
  requestedModel?: string;
  baseProvider: string;
  switchingConfig?: ModelSwitchingConfig;
  fullSystemPrompt: string;
  additionalSystemPrompt?: string;
  userMessage: string;
}

const DEFAULT_REQUESTED_MODEL = 'auto';
const DEFAULT_MODE: SwitchingMode = 'whitelist';
const PROJECT_ROOT = process.env.PROJECT_ROOT || process.cwd();
const DATA_DIR = join(PROJECT_ROOT, 'data', 'model-switching');
const MODELS_PATH = join(DATA_DIR, 'notdiamond-models.json');
const ALIASES_PATH = join(DATA_DIR, 'aliases.json');

function normalizeText(value: unknown): string {
  return String(value || '').trim();
}

function normalizeKey(value: unknown): string {
  return normalizeText(value).toLowerCase();
}

function normalizeMode(mode: unknown): SwitchingMode {
  const normalized = normalizeKey(mode).replace('-', '_');
  if (normalized === 'allow_all' || normalized === 'blacklist' || normalized === 'whitelist') {
    return normalized;
  }
  return DEFAULT_MODE;
}

function normalizeList(value: unknown): string[] {
  if (!value) return [];
  if (Array.isArray(value)) return value.map(item => normalizeText(item)).filter(Boolean);
  const single = normalizeText(value);
  return single ? [single] : [];
}

function parseConfiguredModelEntry(raw: string): { name: string; alias?: string } {
  const text = normalizeText(raw);
  const match = text.match(/^(.*?)\s*\[([^\]]+)\]\s*$/);
  if (!match) {
    return { name: text };
  }
  return {
    name: normalizeText(match[1]),
    alias: normalizeText(match[2]),
  };
}

function splitProviderModel(id: string): { provider: string; model: string } | null {
  const slash = id.indexOf('/');
  if (slash <= 0 || slash >= id.length - 1) {
    return null;
  }
  return {
    provider: id.slice(0, slash),
    model: id.slice(slash + 1),
  };
}

async function readJson(path: string, fallback: unknown): Promise<any> {
  try {
    return JSON.parse(await readFile(resolve(path), 'utf-8'));
  } catch (error: any) {
    if (error?.code === 'ENOENT') return fallback;
    throw error;
  }
}

async function loadNotDiamondModels(): Promise<NotDiamondModelEntry[]> {
  const data = await readJson(MODELS_PATH, { models: [] });
  const models = Array.isArray(data) ? data : data.models;
  return Array.isArray(models) ? models : [];
}

async function loadProviderAliases(provider: string): Promise<Record<string, string>> {
  const data = await readJson(ALIASES_PATH, { providers: {} });
  const providers = data?.providers && typeof data.providers === 'object' ? data.providers : {};
  const aliases = providers[provider] && typeof providers[provider] === 'object' ? providers[provider] : {};
  return { ...aliases };
}

function modelEntryId(entry: NotDiamondModelEntry): string {
  if (entry.id) return entry.id;
  if (entry.provider && entry.model) return `${entry.provider}/${entry.model}`;
  if (entry.openrouter_model) return entry.openrouter_model;
  return '';
}

function buildAliasMaps(providerAliases: Record<string, string>, configuredLists: string[][]) {
  const localToNotDiamond = new Map<string, string>();
  const notDiamondToLocal = new Map<string, string>();

  for (const [local, notDiamond] of Object.entries(providerAliases)) {
    const localName = normalizeText(local);
    const notDiamondId = normalizeText(notDiamond);
    if (!localName || !notDiamondId) continue;
    localToNotDiamond.set(normalizeKey(localName), notDiamondId);
    notDiamondToLocal.set(normalizeKey(notDiamondId), localName);
  }

  for (const list of configuredLists) {
    for (const raw of list) {
      const parsed = parseConfiguredModelEntry(raw);
      if (!parsed.name || !parsed.alias) continue;
      localToNotDiamond.set(normalizeKey(parsed.name), parsed.alias);
      notDiamondToLocal.set(normalizeKey(parsed.alias), parsed.name);
    }
  }

  return { localToNotDiamond, notDiamondToLocal };
}

function toCandidate(name: string, notDiamondId: string, executionProvider: string, notDiamondToLocal: Map<string, string>): RoutingCandidate | null {
  const parsed = splitProviderModel(notDiamondId);
  if (!parsed) {
    return null;
  }

  const localAlias = notDiamondToLocal.get(normalizeKey(notDiamondId));
  return {
    name,
    notDiamondId,
    provider: parsed.provider,
    model: parsed.model,
    executionProvider: localAlias ? executionProvider : 'openrouter',
    executionModel: localAlias || notDiamondId,
  };
}

function resolveCandidateFromName(
  rawName: string,
  executionProvider: string,
  localToNotDiamond: Map<string, string>,
  notDiamondToLocal: Map<string, string>
): RoutingCandidate | null {
  const parsed = parseConfiguredModelEntry(rawName);
  const notDiamondId = parsed.alias
    || localToNotDiamond.get(normalizeKey(parsed.name))
    || (splitProviderModel(parsed.name) ? parsed.name : '');

  if (!notDiamondId) return null;
  return toCandidate(parsed.name, notDiamondId, executionProvider, notDiamondToLocal);
}

function matchesCandidate(candidate: RoutingCandidate, rawName: string): boolean {
  const parsed = parseConfiguredModelEntry(rawName);
  const values = [
    candidate.name,
    candidate.notDiamondId,
    candidate.executionModel,
    `${candidate.provider}/${candidate.model}`,
  ].map(normalizeKey);
  if (parsed.alias) values.push(normalizeKey(parsed.alias));
  return values.includes(normalizeKey(parsed.name)) || values.includes(normalizeKey(rawName));
}

async function buildCandidates(config: ModelSwitchingConfig | undefined, executionProvider: string): Promise<RoutingCandidate[]> {
  const mode = normalizeMode(config?.mode);
  const whitelist = normalizeList(config?.whitelist);
  const blacklist = normalizeList(config?.blacklist);
  const providerAliases = await loadProviderAliases(executionProvider);
  const { localToNotDiamond, notDiamondToLocal } = buildAliasMaps(providerAliases, [whitelist, blacklist]);

  if (mode === 'whitelist') {
    const candidates = whitelist
      .map(item => resolveCandidateFromName(item, executionProvider, localToNotDiamond, notDiamondToLocal))
      .filter((item): item is RoutingCandidate => Boolean(item));
    return candidates;
  }

  const supportedModels = await loadNotDiamondModels();
  let candidates = supportedModels
    .map(entry => modelEntryId(entry))
    .filter(Boolean)
    .map(id => toCandidate(id, id, executionProvider, notDiamondToLocal))
    .filter((item): item is RoutingCandidate => Boolean(item));

  if (mode === 'blacklist' && blacklist.length > 0) {
    candidates = candidates.filter(candidate => !blacklist.some(item => matchesCandidate(candidate, item)));
  }

  return candidates;
}

function selectPromptForEvaluation(input: SelectNotDiamondModelInput): string {
  const config = input.switchingConfig;
  const explicitScope = config?.evaluationPrompt;
  const useFull = explicitScope
    ? explicitScope !== 'additional'
    : config?.evaluateFullSystemPrompt !== false;
  return useFull
    ? input.fullSystemPrompt
    : (input.additionalSystemPrompt || input.fullSystemPrompt);
}

async function callNotDiamond(messages: Array<{ role: 'system' | 'user'; content: string }>, candidates: RoutingCandidate[], config?: ModelSwitchingConfig) {
  const apiKey = process.env.NOTDIAMOND_API_KEY;
  if (!apiKey) {
    throw new Error('NOTDIAMOND_API_KEY is required for automatic model routing.');
  }

  const response = await fetch('https://api.notdiamond.ai/v2/modelRouter/modelSelect', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messages,
      llm_providers: candidates.map(candidate => ({
        provider: candidate.provider,
        model: candidate.model,
      })),
      max_model_depth: config?.topK,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `Not Diamond modelSelect failed with HTTP ${response.status}`);
  }

  return response.json() as Promise<any>;
}

function pickCandidateByNotDiamondResponse(candidates: RoutingCandidate[], response: any): RoutingCandidate | null {
  const provider = response?.provider;
  const providerName = normalizeText(provider?.provider || provider?.providerName);
  const modelName = normalizeText(provider?.model || provider?.modelName);
  const fullName = providerName && modelName ? `${providerName}/${modelName}` : normalizeText(provider?.id || response?.model);
  if (!fullName) return null;

  return candidates.find(candidate => normalizeKey(candidate.notDiamondId) === normalizeKey(fullName))
    || candidates.find(candidate => normalizeKey(candidate.model) === normalizeKey(modelName) && normalizeKey(candidate.provider) === normalizeKey(providerName))
    || null;
}

function fallbackResult(input: SelectNotDiamondModelInput, reason: string): NotDiamondRoutingResult {
  const requestedModel = normalizeText(input.requestedModel) || DEFAULT_REQUESTED_MODEL;
  return {
    requestedModel,
    notDiamondModel: requestedModel,
    executionProvider: input.baseProvider,
    executionModel: requestedModel === DEFAULT_REQUESTED_MODEL ? '' : requestedModel,
    changed: false,
    reason,
  };
}

export async function selectNotDiamondModelForSubagent(input: SelectNotDiamondModelInput): Promise<NotDiamondRoutingResult> {
  const requestedModel = normalizeText(input.requestedModel) || DEFAULT_REQUESTED_MODEL;
  const candidates = await buildCandidates(input.switchingConfig, input.baseProvider);

  if (candidates.length === 0) {
    return fallbackResult(input, 'no routing candidates');
  }

  const manual = requestedModel.toLowerCase() !== DEFAULT_REQUESTED_MODEL;
  if (manual) {
    const direct = candidates.find(candidate => matchesCandidate(candidate, requestedModel))
      || candidates.find(candidate => normalizeKey(candidate.executionModel) === normalizeKey(requestedModel));
    if (direct) {
      return {
        requestedModel,
        notDiamondModel: direct.notDiamondId,
        executionProvider: direct.executionProvider,
        executionModel: direct.executionModel,
        changed: true,
        reason: 'manual model',
      };
    }
  }

  if (candidates.length === 1) {
    const only = candidates[0]!;
    return {
      requestedModel,
      notDiamondModel: only.notDiamondId,
      executionProvider: only.executionProvider,
      executionModel: only.executionModel,
      changed: true,
      reason: manual ? 'manual fallback to only allowed model' : 'only allowed model',
    };
  }

  try {
    const systemPrompt = selectPromptForEvaluation(input);
    const response = await callNotDiamond([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: input.userMessage },
    ], candidates, input.switchingConfig);
    const selected = pickCandidateByNotDiamondResponse(candidates, response) || candidates[0]!;

    return {
      requestedModel,
      notDiamondModel: selected.notDiamondId,
      notDiamondSessionId: normalizeText(response?.session_id || response?.sessionId) || undefined,
      executionProvider: selected.executionProvider,
      executionModel: selected.executionModel,
      changed: true,
      reason: 'notdiamond auto router',
    };
  } catch (error) {
    const fallback = candidates[0]!;
    return {
      requestedModel,
      notDiamondModel: fallback.notDiamondId,
      executionProvider: fallback.executionProvider,
      executionModel: fallback.executionModel,
      changed: true,
      reason: `notdiamond fallback: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
