import chalk from 'chalk';
import { createProviderInstance } from '../providers/factory.js';
import { embedQuery } from '../utils/embeddingService.js';
import { attachEmbeddings, loadEmbeddingIndex, loadModelRegistry } from './modelRegistry.js';
import { rankBySimilarity } from './vectorSearch.js';

const DEFAULT_MODE = 'whitelist';
const VALID_MODES = new Set(['whitelist', 'allow_all', 'blacklist']);

function normaliseMode(mode) {
  if (!mode) {
    return DEFAULT_MODE;
  }
  const normalised = String(mode).toLowerCase().replace('-', '_');
  return VALID_MODES.has(normalised) ? normalised : DEFAULT_MODE;
}

function normaliseList(value) {
  if (!value) {
    return [];
  }
  if (Array.isArray(value)) {
    return value.map(item => String(item));
  }
  return [String(value)];
}

function matchByNameOrId(candidates, query) {
  if (!query) return null;
  const normalised = String(query).trim().toLowerCase();
  return candidates.find(candidate => {
    const id = String(candidate.id ?? '').toLowerCase();
    const name = String(candidate.name ?? '').toLowerCase();
    return id === normalised || name === normalised;
  }) || null;
}

function mergeOverride(base, override = {}) {
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

function prepareSelectorPrompt(description, candidates, locale = 'en-US') {
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

async function chooseWithSelector(description, candidates, selectorConfig, logger) {
  if (!selectorConfig || !selectorConfig.provider || !selectorConfig.model) {
    throw new Error('Конфигурация selector не содержит provider/model.');
  }
  const {
    provider,
    model,
    temperature = 1,
    systemPrompt = '',
    customParams = {},
    apiKey
  } = selectorConfig;

  const message = prepareSelectorPrompt(description, candidates);
  const messages = [{ role: 'user', content: message }];

  const providerInstance = createProviderInstance(provider, apiKey || process.env[`${provider.toUpperCase()}_API_KEY`], model, logger, customParams);

  const response = await providerInstance.chat(messages, {
    temperature,
    systemPrompt,
    onUsage: selectorConfig?.onUsage || null
  });

  return String(response || '').trim();
}

function pickCandidateById(candidates, answer) {
  if (!answer) {
    return null;
  }
  const cleaned = answer.replace(/[`"'\\]/g, '').trim();
  const normalized = cleaned.toLowerCase();
  return candidates.find(candidate => {
    const id = String(candidate.id || '').toLowerCase();
    const name = String(candidate.name || '').toLowerCase();
    return id === normalized || name === normalized;
  }) || null;
}

function limitCandidates(list, limit) {
  if (typeof limit !== 'number' || limit <= 0) {
    return list;
  }
  return list.slice(0, limit);
}

function buildOverrideMap(overridesRaw = {}) {
  const map = new Map();
  for (const [key, value] of Object.entries(overridesRaw)) {
    if (!value) continue;
    const normalizedKey = String(key);
    map.set(normalizedKey, { ...value });
  }
  return map;
}

/**
 * Главная функция выбора модели.
 * @param {string} description
 * @param {object} config
 * @param {object} [options]
 * @param {Function} [options.logger]
 * @returns {Promise<object>}
 */
export async function selectModel(description, config, options = {}) {
  const logger = options.logger || (() => {});
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

  // Allow cost tracking for selector calls (OpenRouter usage.cost)
  if (options.onUsage && selector) {
    selector.onUsage = options.onUsage;
  }

  if (!registryPath) {
    throw new Error('Не указан путь к базе моделей (registryPath).');
  }

  const resolvedMode = normaliseMode(mode);
  const whitelistIds = normaliseList(whitelist);
  const blacklistIds = normaliseList(blacklist);
  const overrideMap = buildOverrideMap(overrides);

  const models = await loadModelRegistry(registryPath);
  if (models.length === 0) {
    throw new Error(`База моделей пуста по пути ${registryPath}`);
  }

  let candidates = models.map(model => ({
    ...model,
    id: model.id || model.name
  }));

  if (resolvedMode === 'whitelist') {
    if (whitelistIds.length === 0) {
      throw new Error('Режим whitelist требует указания списка моделей.');
    }
    candidates = candidates.filter(candidate => {
      const id = String(candidate.id || '').toLowerCase();
      return whitelistIds.some(item => item.toLowerCase() === id);
    });
  } else if (resolvedMode === 'blacklist') {
    if (blacklistIds.length > 0) {
      const blacklistSet = new Set(blacklistIds.map(item => item.toLowerCase()));
      candidates = candidates.filter(candidate => !blacklistSet.has(String(candidate.id || '').toLowerCase()));
    }
  }

  if (candidates.length === 0) {
    throw new Error('После применения фильтров не осталось доступных моделей.');
  }

  // Быстрый путь: прямое совпадение
  const directMatch = matchByNameOrId(candidates, description);
  if (directMatch) {
    logger(chalk.gray(`[model-switch] Найдено прямое совпадение: ${directMatch.id}`));
    const override = overrideMap.get(directMatch.id) || overrideMap.get(directMatch.name);
    return mergeOverride(directMatch, override);
  }

  let reducedCandidates = candidates;

  if (resolvedMode !== 'whitelist') {
    const embeddingIndex = await loadEmbeddingIndex(embeddingIndexPath);
    const withEmbeddings = attachEmbeddings(candidates, embeddingIndex);
    let queryEmbedding = null;
    try {
      queryEmbedding = await embedQuery(description, embedding);
    } catch (error) {
      logger(chalk.red(`[model-switch] Ошибка при вычислении эмбеддинга запроса: ${error.message}`));
    }

    if (queryEmbedding) {
      const ranked = rankBySimilarity(withEmbeddings, queryEmbedding, topK, 0.4);
      if (ranked.length > 0) {
        reducedCandidates = ranked;
        logger(chalk.gray(`[model-switch] Отобрано ${ranked.length} кандидатов по схожести.`));
      }
    }
  }

  reducedCandidates = limitCandidates(reducedCandidates, topK);

  if (reducedCandidates.length === 1) {
    logger(chalk.gray('[model-switch] Единственный кандидат, выбор без селектора.'));
    const onlyCandidate = reducedCandidates[0];
    const override = overrideMap.get(onlyCandidate.id) || overrideMap.get(onlyCandidate.name);
    return mergeOverride(onlyCandidate, override);
  }

  if (!selector) {
    throw new Error('Не указана конфигурация selector, необходимая для выбора модели.');
  }

  const answer = await chooseWithSelector(description, reducedCandidates, selector, options.selectorLogger || logger);
  const selected = pickCandidateById(reducedCandidates, answer) || reducedCandidates[0];
  const override = overrideMap.get(selected.id) || overrideMap.get(selected.name);

  if (!selected) {
    throw new Error('Selector не вернул подходящую модель.');
  }

  logger(chalk.gray(`[model-switch] Selector выбрал модель: ${selected.id}`));
  return mergeOverride(selected, override);
}


