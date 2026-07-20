import type {
  ReasoningEffort,
  TelosAgentDescriptor,
  TelosCatalog,
  TelosModelPage,
  TelosProviderDescriptor,
  TelosProviderModel,
} from '@telos/code-contracts/telos';

import { AgentLoader } from '../../loaders/AgentLoader.js';
import { getProvider } from '../../providers/base.js';
import { OPENAI_CODEX_MODELS } from '../../providers/openai-codex/models.js';

const DEFAULT_PAGE_SIZE = 10;
const MAX_PAGE_SIZE = 50;
const MODEL_CACHE_TTL_MS = 60_000;
const REQUEST_TIMEOUT_MS = 5_000;

interface ProviderDefinition {
  descriptor: TelosProviderDescriptor;
  available(): Promise<boolean>;
  models(): Promise<TelosProviderModel[]>;
}

interface CachedModels {
  expiresAt: number;
  items: TelosProviderModel[];
}

export class TelosCodeCatalogService {
  private readonly agentLoader: AgentLoader;
  private readonly fetchImpl: typeof fetch;
  private readonly modelCache = new Map<string, CachedModels>();

  public constructor(options: { agentLoader?: AgentLoader; fetchImpl?: typeof fetch } = {}) {
    this.agentLoader = options.agentLoader || new AgentLoader();
    this.fetchImpl = options.fetchImpl || fetch;
  }

  public async getCatalog(): Promise<TelosCatalog> {
    const [loadedAgents, providerAvailability] = await Promise.all([
      this.agentLoader.loadAll(),
      Promise.all(this.providerDefinitions().map(async (definition) => ({
        definition,
        available: await definition.available().catch(() => false),
      }))),
    ]);
    const agents: TelosAgentDescriptor[] = loadedAgents
      .filter((agent) => (agent.config.modality || 'text') === 'text')
      .map((agent) => ({
        name: agent.config.name,
        description: agent.config.description,
        defaultProviderId: agent.config.provider || 'openrouter',
        defaultModelId: agent.config.model,
        defaultReasoning: normalizeReasoning(agent.config.reasoning),
      }))
      .sort((left, right) => left.name.localeCompare(right.name));
    const providers = providerAvailability
      .filter((item) => item.available)
      .map((item) => item.definition.descriptor);
    return { agents, providers };
  }

  public async listModels(input: {
    providerId: string;
    query?: string;
    cursor?: string;
    limit?: number;
  }): Promise<TelosModelPage> {
    const definition = this.providerDefinitions().find((item) => item.descriptor.id === input.providerId);
    if (!definition) throw new Error(`Provider is not executable: ${input.providerId}`);
    if (!(await definition.available())) throw new Error(`Provider is unavailable: ${input.providerId}`);
    const models = await this.cachedModels(definition);
    const query = input.query?.trim().toLocaleLowerCase() || '';
    const filtered = query
      ? models.filter((model) => `${model.id}\n${model.displayName}\n${model.description || ''}`.toLocaleLowerCase().includes(query))
      : models;
    const offset = decodeCursor(input.cursor);
    const limit = Math.max(1, Math.min(input.limit || DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE));
    const items = filtered.slice(offset, offset + limit);
    const nextOffset = offset + items.length;
    return {
      items,
      ...(nextOffset < filtered.length ? { nextCursor: encodeCursor(nextOffset) } : {}),
    };
  }

  public invalidate(providerId?: string): void {
    if (providerId) this.modelCache.delete(providerId);
    else this.modelCache.clear();
  }

  private async cachedModels(definition: ProviderDefinition): Promise<TelosProviderModel[]> {
    const providerId = definition.descriptor.id;
    const cached = this.modelCache.get(providerId);
    if (cached && cached.expiresAt > Date.now()) return cached.items;
    const items = deduplicateModels(await definition.models());
    this.modelCache.set(providerId, { items, expiresAt: Date.now() + MODEL_CACHE_TTL_MS });
    return items;
  }

  private providerDefinitions(): ProviderDefinition[] {
    return [
      this.openRouter(),
      this.gemini(),
      this.ollama(),
      this.vllm(),
      this.staticProvider('inception', 'Inception', 'INCEPTION_API_KEY', [
        model('inception', 'mercury-2', 'Mercury 2'),
        model('inception', 'mercury-coder-small', 'Mercury Coder Small'),
      ]),
      this.staticProvider('kimi-code', 'Kimi Code', 'KIMI_API_CODE', [
        model('kimi-code', 'kimi-for-coding', 'Kimi for Coding'),
        model('kimi-code', 'moonshot-v1-auto', 'Moonshot v1 Auto'),
      ]),
      this.openAiCodex(),
      this.staticProvider('opencode', 'OpenCode', 'OPENCODE_API_KEY', [
        model('opencode', 'kimi-k3', 'Kimi K3'),
        model('opencode', 'kimi-k2.6', 'Kimi K2.6'),
        model('opencode', 'glm-5.2', 'GLM 5.2'),
        model('opencode', 'deepseek-v4-flash', 'DeepSeek V4 Flash'),
      ]),
    ];
  }

  private openRouter(): ProviderDefinition {
    const providerId = 'openrouter';
    return {
      descriptor: descriptor(providerId, 'OpenRouter', { vision: true }),
      available: async () => Boolean(process.env.OPENROUTER_API_KEY),
      models: async () => {
        const response = await this.fetchJson('https://openrouter.ai/api/v1/models', {
          headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY || ''}` },
        });
        const data = asArray(asRecord(response)?.data);
        return data.flatMap((entry) => {
          const value = asRecord(entry);
          if (!value || typeof value.id !== 'string') return [];
          const architecture = asRecord(value.architecture);
          const modalities = asArray(architecture?.input_modalities).filter((item): item is string => typeof item === 'string');
          return [model(providerId, value.id, typeof value.name === 'string' ? value.name : value.id, {
            description: typeof value.description === 'string' ? value.description : undefined,
            contextWindow: positiveInteger(value.context_length),
            vision: modalities.includes('image'),
          })];
        });
      },
    };
  }

  private gemini(): ProviderDefinition {
    const providerId = 'gemini';
    return {
      descriptor: descriptor(providerId, 'Gemini', { vision: true }),
      available: async () => Boolean(process.env.GEMINI_KEY || process.env.GOOGLE_GENERATIVE_AI_API_KEY),
      models: async () => {
        const key = process.env.GEMINI_KEY || process.env.GOOGLE_GENERATIVE_AI_API_KEY || '';
        const response = await this.fetchJson(`https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(key)}&pageSize=1000`);
        return asArray(asRecord(response)?.models).flatMap((entry) => {
          const value = asRecord(entry);
          const rawName = typeof value?.name === 'string' ? value.name : '';
          if (!rawName || !asArray(value?.supportedGenerationMethods).includes('generateContent')) return [];
          const id = rawName.replace(/^models\//u, '');
          return [model(providerId, id, typeof value?.displayName === 'string' ? value.displayName : id, {
            description: typeof value?.description === 'string' ? value.description : undefined,
            contextWindow: positiveInteger(value?.inputTokenLimit),
            vision: true,
          })];
        });
      },
    };
  }

  private ollama(): ProviderDefinition {
    const providerId = 'ollama';
    const baseUrl = (process.env.OLLAMA_HOST || 'http://127.0.0.1:11434').replace(/\/+$/u, '');
    const load = async () => {
      const response = await this.fetchJson(`${baseUrl}/api/tags`);
      return asArray(asRecord(response)?.models).flatMap((entry) => {
        const value = asRecord(entry);
        const id = typeof value?.name === 'string' ? value.name : typeof value?.model === 'string' ? value.model : '';
        return id ? [model(providerId, id, id)] : [];
      });
    };
    return {
      descriptor: descriptor(providerId, 'Ollama'),
      available: async () => (await load()).length > 0,
      models: load,
    };
  }

  private vllm(): ProviderDefinition {
    const providerId = 'vllm';
    const baseUrl = (process.env.VLLM_BASE_URL || 'http://127.0.0.1:8000/v1').replace(/\/+$/u, '');
    const load = async () => {
      const response = await this.fetchJson(`${baseUrl}/models`, {
        headers: process.env.VLLM_API_KEY ? { Authorization: `Bearer ${process.env.VLLM_API_KEY}` } : undefined,
      });
      return asArray(asRecord(response)?.data).flatMap((entry) => {
        const value = asRecord(entry);
        return typeof value?.id === 'string' ? [model(providerId, value.id, value.id)] : [];
      });
    };
    return {
      descriptor: descriptor(providerId, 'vLLM'),
      available: async () => (await load()).length > 0,
      models: load,
    };
  }

  private openAiCodex(): ProviderDefinition {
    const providerId = 'openai-codex';
    return {
      descriptor: descriptor(providerId, 'OpenAI Codex', { nativeXHigh: true, vision: true }),
      available: async () => Boolean((await getProvider(providerId).getAuthStatus?.())?.authenticated),
      models: async () => OPENAI_CODEX_MODELS.map((item) => model(providerId, item.ref, item.displayName, { vision: true })),
    };
  }

  private staticProvider(
    providerId: string,
    displayName: string,
    environmentKey: string,
    models: TelosProviderModel[],
  ): ProviderDefinition {
    return {
      descriptor: descriptor(providerId, displayName),
      available: async () => Boolean(process.env[environmentKey]),
      models: async () => models,
    };
  }

  private async fetchJson(url: string, init?: RequestInit): Promise<unknown> {
    const response = await this.fetchImpl(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    if (!response.ok) throw new Error(`Provider catalog request failed (${response.status}).`);
    return response.json();
  }
}

function descriptor(
  id: string,
  displayName: string,
  overrides: Partial<TelosProviderDescriptor['capabilities']> = {},
): TelosProviderDescriptor {
  return {
    id,
    displayName,
    icon: knownIcon(id),
    capabilities: {
      reasoning: true,
      nativeXHigh: false,
      tools: true,
      vision: false,
      ...overrides,
    },
  };
}

function model(
  providerId: string,
  id: string,
  displayName: string,
  options: { description?: string; contextWindow?: number; vision?: boolean } = {},
): TelosProviderModel {
  return {
    id,
    displayName,
    providerId,
    ...(options.description ? { description: options.description } : {}),
    ...(options.contextWindow ? { contextWindow: options.contextWindow } : {}),
    capabilities: { reasoning: true, vision: Boolean(options.vision) },
  };
}

function normalizeReasoning(value: string | undefined): ReasoningEffort {
  return value === 'off' || value === 'low' || value === 'medium' || value === 'high' || value === 'xhigh'
    ? value
    : 'medium';
}

function knownIcon(id: string): TelosProviderDescriptor['icon'] {
  return id === 'openrouter' || id === 'gemini' || id === 'ollama' || id === 'vllm'
    || id === 'inception' || id === 'kimi-code' || id === 'openai-codex' || id === 'opencode'
    ? id
    : 'generic';
}

function deduplicateModels(items: TelosProviderModel[]): TelosProviderModel[] {
  return [...new Map(items.map((item) => [item.id, item])).values()];
}

function encodeCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ offset }), 'utf8').toString('base64url');
}

function decodeCursor(cursor: string | undefined): number {
  if (!cursor) return 0;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { offset?: unknown };
    if (!Number.isInteger(parsed.offset) || Number(parsed.offset) < 0) throw new Error('invalid');
    return Number(parsed.offset);
  } catch {
    throw new Error('Invalid model catalog cursor.');
  }
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
