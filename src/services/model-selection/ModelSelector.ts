
import chalk from 'chalk';
import { createProvider, ProviderName } from '../../providers/factory.js';
import { embedQuery } from './EmbeddingService.js';
import { attachEmbeddings, loadEmbeddingIndex, loadModelRegistry, ModelDefinition } from './ModelRegistry.js';
import { rankBySimilarity, ScoredModel } from './VectorSearch.js';
import { ProviderConfig, Message } from '../../types/index.js';

const DEFAULT_MODE = 'whitelist';
const VALID_MODES = new Set(['whitelist', 'allow_all', 'blacklist']);

type SelectorMode = 'whitelist' | 'allow_all' | 'blacklist';

export interface SelectorConfig {
    registryPath: string;
    embeddingIndexPath?: string;
    mode?: SelectorMode;
    whitelist?: string[];
    blacklist?: string[];
    topK?: number;
    overrides?: Record<string, any>;
    selector?: {
        provider: ProviderName;
        model: string;
        temperature?: number;
        systemPrompt?: string;
        customParams?: Record<string, any>;
        apiKey?: string;
        onUsage?: (usage: any) => void;
    };
    embedding?: {
        model?: string;
        apiKey?: string;
    }
}

function normaliseMode(mode?: string): SelectorMode {
    if (!mode) {
        return DEFAULT_MODE as SelectorMode;
    }
    const normalised = String(mode).toLowerCase().replace('-', '_');
    return VALID_MODES.has(normalised) ? (normalised as SelectorMode) : (DEFAULT_MODE as SelectorMode);
}

function normaliseList(value: any): string[] {
    if (!value) {
        return [];
    }
    if (Array.isArray(value)) {
        return value.map(item => String(item));
    }
    return [String(value)];
}

function matchByNameOrId(candidates: ModelDefinition[], query: string): ModelDefinition | null {
    if (!query) return null;
    const normalised = String(query).trim().toLowerCase();
    return candidates.find(candidate => {
        const id = String(candidate.id ?? '').toLowerCase();
        const name = String(candidate.name ?? '').toLowerCase();
        return id === normalised || name === normalised;
    }) || null;
}

function mergeOverride(base: ModelDefinition, override: any = {}): ModelDefinition {
    if (!override) {
        return { ...base };
    }

    const merged = {
        ...base,
        ...override
    };

    if (override.systemPrompt) {
        merged.systemPrompt = override.systemPrompt;
    }
    if (override.temperature !== undefined) {
        merged.temperature = override.temperature;
    }
    if (override.customParams) {
        merged.customParams = {
            ...(base.customParams || {}),
            ...override.customParams
        };
    }

    return merged;
}

function prepareSelectorPrompt(description: string, candidates: ModelDefinition[], locale = 'en-US'): string {
    const list = candidates.map((candidate, index) => {
        const provider = candidate.provider || 'unknown';
        const desc = candidate.description || 'No description provided.';
        return `${index + 1}. ${candidate.id} (provider: ${provider})\n   ${desc}`;
    }).join('\n\n');

    return `Request locale: ${locale}
Requested capabilities/description: ${description}

Candidate models:
${list}

Rules:
- Select exactly one model id from the candidate list that best matches the request.
- Answer with the model id only, no additional words or formatting.
- If multiple models fit equally well, prefer the one specialising in reasoning or accuracy.
- If nothing matches, pick the closest candidate anyway.`;
}

async function chooseWithSelector(
    description: string,
    candidates: ModelDefinition[],
    selectorConfig: SelectorConfig['selector'],
    logger: (msg: string) => void
): Promise<string> {
    if (!selectorConfig || !selectorConfig.provider || !selectorConfig.model) {
        throw new Error('Selector configuration missing provider/model.');
    }
    const {
        provider,
        model,
        temperature = 0,
        systemPrompt = '',
        customParams = {},
        apiKey
    } = selectorConfig;

    const messageText = prepareSelectorPrompt(description, candidates);
    const messages: Message[] = [{ role: 'user', content: messageText }];

    const providerInstance = createProvider(provider, apiKey || process.env[`${provider.toUpperCase()}_API_KEY`]);

    // ProviderConfig for our existing provider system
    const providerConfig: ProviderConfig = {
        model: model,
        temperature: temperature,
        // Pass custom params via internal logic if supported, mostly stored in config
        // But our internal provider interface takes params in config object
        // We might need to extend ProviderConfig to allow arbitrary params?
        // BaseProvider doesn't support arbitrary params easily in existing interface definition
        // But we can cast or extend.
    };

    const response = await providerInstance.complete(messages, providerConfig);
    // Log usage if callback provided
    if (selectorConfig.onUsage && response.usage) {
        selectorConfig.onUsage(response.usage);
    }

    return String(response.content || '').trim();
}

function pickCandidateById(candidates: ModelDefinition[], answer: string): ModelDefinition | null {
    if (!answer) {
        return null;
    }
    const cleaned = answer.replace(/[`"'\\]/g, '').trim();
    const normalized = cleaned.toLowerCase();

    // Try exact match
    let found = candidates.find(candidate => {
        const id = String(candidate.id || '').toLowerCase();
        const name = String(candidate.name || '').toLowerCase();
        return id === normalized || name === normalized;
    });

    if (found) return found;

    // Try substring match if exact fail (fallback)
    found = candidates.find(candidate => {
        const id = String(candidate.id || '').toLowerCase();
        return normalized.includes(id);
    });

    return found || null;
}

function limitCandidates(list: ScoredModel[] | ModelDefinition[], limit: number): ModelDefinition[] {
    if (typeof limit !== 'number' || limit <= 0) {
        return list;
    }
    return list.slice(0, limit);
}

function buildOverrideMap(overridesRaw: any = {}) {
    const map = new Map();
    for (const [key, value] of Object.entries(overridesRaw)) {
        if (!value) continue;
        const normalizedKey = String(key);
        map.set(normalizedKey, { ...(value as object) });
    }
    return map;
}

export interface SelectModelOptions {
    logger?: (msg: string) => void;
    selectorLogger?: (msg: string) => void;
    onUsage?: (usage: any) => void;
}

/**
 * Main function to select a model.
 */
export async function selectModel(description: string, config: SelectorConfig, options: SelectModelOptions = {}) {
    const logger = options.logger || (() => { });
    const {
        registryPath,
        embeddingIndexPath,
        mode,
        whitelist,
        blacklist,
        topK = 10,
        overrides,
        selector,
        embedding
    } = config || {};

    if (options.onUsage && selector) {
        selector.onUsage = options.onUsage;
    }

    if (!registryPath) {
        throw new Error('No registry path provided.');
    }

    const resolvedMode = normaliseMode(mode);
    const whitelistIds = normaliseList(whitelist);
    const blacklistIds = normaliseList(blacklist);
    const overrideMap = buildOverrideMap(overrides);

    const models = await loadModelRegistry(registryPath);
    if (models.length === 0) {
        throw new Error(`Model registry empty at ${registryPath}`);
    }

    let candidates: ModelDefinition[] = models.map(model => ({
        ...model,
        id: model.id || model.name
    }));

    if (resolvedMode === 'whitelist') {
        if (whitelistIds.length === 0) {
            throw new Error('Whitelist mode requires a whitelist.');
        }
        candidates = candidates.filter(candidate => {
            const id = String(candidate.id || '').toLowerCase();
            // Allow exact match or if whitelist item is "provider/*" (wildcard support could be added, but user said copy exact logic)
            // The original code uses exact match check:
            return whitelistIds.some(item => item.toLowerCase() === id);
        });
    } else if (resolvedMode === 'blacklist') {
        if (blacklistIds.length > 0) {
            const blacklistSet = new Set(blacklistIds.map(item => item.toLowerCase()));
            candidates = candidates.filter(candidate => !blacklistSet.has(String(candidate.id || '').toLowerCase()));
        }
    }

    if (candidates.length === 0) {
        throw new Error('No models available after filtering.');
    }

    // Fast path: direct match
    const directMatch = matchByNameOrId(candidates, description);
    if (directMatch) {
        logger(chalk.gray(`[model-switch] Direct match found: ${directMatch.id}`));
        const override = overrideMap.get(directMatch.id) || overrideMap.get(directMatch.name);
        return mergeOverride(directMatch, override);
    }

    let reducedCandidates: ModelDefinition[] | ScoredModel[] = candidates;

    if (resolvedMode !== 'whitelist') {
        // Logic from old example: only compute embeddings if not whitelist?
        // Wait, original code: if (resolvedMode !== 'whitelist') { compute embeddings }
        // The assumption is whitelist is small enough?
        // Or maybe because whitelist usually implies specific intent?
        // Yes, original code lines 216.

        const embeddingIndex = await loadEmbeddingIndex(embeddingIndexPath || '');
        // attachEmbeddings returns ModelDefinition[], but we need to check if we can actually score them
        // We need embeddings on candidates.
        const withEmbeddings = attachEmbeddings(candidates, embeddingIndex);

        let queryEmbedding: number[] | null = null;
        try {
            queryEmbedding = await embedQuery(description, embedding);
        } catch (error: any) {
            logger(chalk.red(`[model-switch] Error computing embedding: ${error.message}`));
        }

        if (queryEmbedding) {
            // Cast to ModelWithEmbedding because attached embeddings
            const ranked = rankBySimilarity(withEmbeddings as any, queryEmbedding, topK, 0.4);
            if (ranked.length > 0) {
                reducedCandidates = ranked;
                logger(chalk.gray(`[model-switch] Selected ${ranked.length} candidates by similarity.`));
            }
        }
    }

    reducedCandidates = limitCandidates(reducedCandidates, topK);

    if (reducedCandidates.length === 1) {
        logger(chalk.gray('[model-switch] Single candidate, skipping selector.'));
        const onlyCandidate = reducedCandidates[0];
        const override = overrideMap.get(onlyCandidate!.id || '') || overrideMap.get(onlyCandidate!.name || '');
        return mergeOverride(onlyCandidate!, override);
    }

    if (!selector) {
        // If no selector configured, return best guess (first one)
        logger(chalk.yellow('[model-switch] No selector configured, picking first candidate.'));
        const first = reducedCandidates[0];
        const override = overrideMap.get(first!.id || '') || overrideMap.get(first!.name || '');
        return mergeOverride(first!, override);
    }

    const answer = await chooseWithSelector(description, reducedCandidates, selector, options.selectorLogger || logger);
    const selected = pickCandidateById(reducedCandidates, answer) || reducedCandidates[0];
    const override = overrideMap.get(selected!.id || '') || overrideMap.get(selected!.name || '');

    if (!selected) {
        throw new Error('Selector failed to return a valid model.');
    }

    logger(chalk.gray(`[model-switch] Selector chose: ${selected.id}`));
    return mergeOverride(selected, override);
}
