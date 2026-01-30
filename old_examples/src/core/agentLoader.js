import { readdir, readFile, access, constants } from 'fs/promises';
import { join, dirname, resolve, isAbsolute } from 'path';
import { fileURLToPath } from 'url';
import yaml from 'js-yaml';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const projectRoot = resolve(__dirname, '../..');
const DEFAULT_SELECTOR_PROMPT_PATH = join(__dirname, '../prompts/model_selector_system.txt');

/**
 * Проверяет существование файла
 */
async function fileExists(filePath) {
  try {
    await access(filePath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function resolveAgentPath(agentDir, maybePath) {
  if (!maybePath) {
    return null;
  }
  if (isAbsolute(maybePath)) {
    return maybePath;
  }
  return join(agentDir, maybePath);
}

function resolveProjectPath(maybePath) {
  if (!maybePath) {
    return null;
  }
  if (isAbsolute(maybePath)) {
    return maybePath;
  }
  return join(projectRoot, maybePath);
}

async function loadPromptFile(agentDir, fileName) {
  if (!fileName) {
    return null;
  }
  const filePath = resolveAgentPath(agentDir, fileName);
  if (!filePath) {
    return null;
  }
  const content = await readFile(filePath, 'utf8');
  return content;
}

async function loadSelectorPrompt(agentDir, selectorConfig) {
  if (selectorConfig.systemPrompt) {
    return selectorConfig.systemPrompt;
  }
  if (selectorConfig.system_prompt) {
    return selectorConfig.system_prompt;
  }

  const promptFile = selectorConfig.system_prompt_file || selectorConfig.systemPromptFile;
  if (promptFile) {
    return await loadPromptFile(agentDir, promptFile);
  }

  try {
    const fallback = await readFile(DEFAULT_SELECTOR_PROMPT_PATH, 'utf8');
    return fallback;
  } catch {
    return '';
  }
}

function normaliseArray(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  return [value];
}

function extractCustomParams(raw = {}) {
  return raw.customParams || raw.custom_params || {};
}

function extractApiKey(raw = {}) {
  return raw.apiKey || raw.api_key || undefined;
}

/**
 * Парсит экспериментальные функции из конфигурации
 * @param {Object} config - Конфигурация агента
 * @returns {Object} Объект с экспериментальными настройками
 */
function buildExperimentalConfig(config) {
  const experimental = config.experimental || {};
  const result = {};

  // === Gemini File Search ===
  // Позволяет загружать большие документы из ./context для RAG
  const geminiFileSearch = experimental.gemini_file_search || experimental.geminiFileSearch;
  if (geminiFileSearch) {
    result.geminiFileSearch = {
      enabled: geminiFileSearch.enabled !== false,
      contextPath: geminiFileSearch.context_path || geminiFileSearch.contextPath || null,
      storeName: geminiFileSearch.store_name || geminiFileSearch.storeName || null,
      // Опциональные настройки чанкинга
      chunkingConfig: geminiFileSearch.chunking_config || geminiFileSearch.chunkingConfig || null
    };
  }

  return result;
}

async function buildModelSwitchingConfig(agentDir, executorRaw) {
  const msRaw = executorRaw.model_switching || executorRaw.modelSwitching;
  if (!msRaw || msRaw.enabled === false) {
    return null;
  }

  const registryPath = resolveProjectPath(msRaw.registry_path || msRaw.registryPath || 'data/models/models.json');
  const embeddingIndexPath = resolveProjectPath(msRaw.embedding_index_path || msRaw.embeddingIndexPath || 'data/models/embeddings.json');

  const selectorRaw = msRaw.selector || {};
  const selectorPrompt = await loadSelectorPrompt(agentDir, selectorRaw);

  const selector = {
    provider: selectorRaw.provider || 'cerebras',
    model: selectorRaw.model || 'gpt-oss-120b',
    temperature: selectorRaw.temperature ?? 0,
    systemPrompt: selectorPrompt,
    customParams: extractCustomParams(selectorRaw),
    apiKey: extractApiKey(selectorRaw) || undefined
  };

  const overrides = {};
  if (msRaw.overrides && typeof msRaw.overrides === 'object') {
    for (const [modelId, raw] of Object.entries(msRaw.overrides)) {
      if (!raw) continue;
      let systemPrompt = raw.systemPrompt || raw.system_prompt || null;
      const systemPromptFile = raw.system_prompt_file || raw.systemPromptFile;
      if (!systemPrompt && systemPromptFile) {
        systemPrompt = await loadPromptFile(agentDir, systemPromptFile);
      }

      overrides[String(modelId)] = {
        provider: raw.provider,
        model: raw.model,
        temperature: raw.temperature,
        customParams: extractCustomParams(raw),
        apiKey: extractApiKey(raw),
        systemPrompt
      };
    }
  }

  const embeddingRaw = msRaw.embedding || {};
  const embedding = {};
  if (embeddingRaw.model || embeddingRaw.embedding_model) {
    embedding.model = embeddingRaw.model || embeddingRaw.embedding_model;
  }
  if (embeddingRaw.apiKey || embeddingRaw.api_key) {
    embedding.apiKey = embeddingRaw.apiKey || embeddingRaw.api_key;
  }

  return {
    enabled: msRaw.enabled !== false,
    mode: msRaw.mode || 'whitelist',
    whitelist: normaliseArray(msRaw.whitelist).map(String),
    blacklist: normaliseArray(msRaw.blacklist).map(String),
    topK: msRaw.topK ?? msRaw.top_k ?? 10,
    defaultModelId: msRaw.default_model || msRaw.default_model_id || msRaw.defaultModel || msRaw.defaultModelId || executorRaw.model,
    registryPath,
    embeddingIndexPath,
    selector,
    overrides,
    embedding: Object.keys(embedding).length ? embedding : undefined
  };
}

/**
 * Загружает конфигурацию кастомного агента
 * @param {string} agentName - Имя директории агента
 * @param {string} agentDir - Путь к директории агента
 * @param {Object} config - Загруженный YAML конфиг
 * @returns {Object} Конфигурация кастомного агента
 */
async function loadCustomAgentConfig(agentName, agentDir, config) {
  // Получаем путь к entry файлу
  const entryFile = config.entry || config.entry_file || './index.js';
  const entryPath = isAbsolute(entryFile) ? entryFile : join(agentDir, entryFile);
  
  // Проверяем существование entry файла
  if (!(await fileExists(entryPath))) {
    throw new Error(`Custom agent entry file not found: ${entryPath}`);
  }
  
  return {
    name: config.name || agentName,
    isCustom: true,
    entryPath: entryPath,
    agentDir: agentDir,
    
    // Кастомная конфигурация для передачи в агента
    customConfig: config.config || {},
    
    // Список агентов, которых может вызывать этот кастомный агент
    callableAgents: Array.isArray(config.agents) 
      ? config.agents 
      : (Array.isArray(config.callable_agents) ? config.callable_agents : []),
    
    // Задержка между вызовами агентов
    interAgentDelaySeconds: typeof config.inter_agent_delay_seconds === 'number'
      ? config.inter_agent_delay_seconds
      : 5,
    
    // Описание для документации
    description: config.description || null
  };
}

/**
 * Load all available agents from the agents directory
 * @returns {Promise<Object>} Map of agent name to agent config
 */
export async function loadAgents() {
  const agentsDir = join(__dirname, '../../agents');
  const agents = {};

  try {
    const entries = await readdir(agentsDir, { withFileTypes: true });

    for (const entry of entries) {
      if (entry.isDirectory()) {
        const agentName = entry.name;
        const agentDir = join(agentsDir, agentName);
        const configPath = join(agentDir, 'config.yaml');

        try {
          const configContent = await readFile(configPath, 'utf8');
          const config = yaml.load(configContent);

          // === CUSTOM AGENT ===
          // Проверяем, является ли агент кастомным
          if (config.custom === true || config.isCustom === true) {
            agents[agentName] = await loadCustomAgentConfig(agentName, agentDir, config);
            continue;
          }

          // === STANDARD AGENT ===
          // Load system prompts
          const plannerPromptPath = join(agentDir, config.planner.system_prompt_file);
          const executorPromptPath = join(agentDir, config.executor.system_prompt_file);

          const plannerPrompt = await readFile(plannerPromptPath, 'utf8');
          const executorPrompt = await readFile(executorPromptPath, 'utf8');

          const plannerConfig = {
            ...config.planner,
            customParams: extractCustomParams(config.planner),
            apiKey: extractApiKey(config.planner),
            systemPrompt: plannerPrompt
          };
          delete plannerConfig.system_prompt_file;
          delete plannerConfig.systemPromptFile;

          const executorModelSwitching = await buildModelSwitchingConfig(agentDir, config.executor);

          const executorConfig = {
            ...config.executor,
            customParams: extractCustomParams(config.executor),
            apiKey: extractApiKey(config.executor),
            systemPrompt: executorPrompt
          };
          delete executorConfig.system_prompt_file;
          delete executorConfig.systemPromptFile;
          delete executorConfig.model_switching;
          delete executorConfig.modelSwitching;

          if (executorModelSwitching) {
            executorConfig.modelSwitching = executorModelSwitching;
          }

          // === EXPERIMENTAL FEATURES ===
          // Парсим экспериментальные функции
          const experimentalConfig = buildExperimentalConfig(config);

          agents[agentName] = {
            name: config.name,
            isCustom: false,
            planner: {
              ...plannerConfig
            },
            executor: {
              ...executorConfig
            },
            tools: config.tools || [],
            // Optional: list of other agents this agent is allowed to call
            callableAgents: Array.isArray(config.agents) ? config.agents : [],
            // Optional: delay (in seconds) before this agent is invoked by another agent
            interAgentDelaySeconds: typeof config.inter_agent_delay_seconds === 'number'
              ? config.inter_agent_delay_seconds
              : 5,
            // Experimental features configuration
            experimental: experimentalConfig
          };
        } catch (error) {
          console.error(`Error loading agent "${agentName}":`, error.message);
        }
      }
    }

    return agents;
  } catch (error) {
    console.error('Error reading agents directory:', error.message);
    return {};
  }
}

/**
 * Get a specific agent by name
 * @param {string} agentName - Name of the agent
 * @returns {Promise<Object>} Agent configuration
 */
export async function getAgent(agentName) {
  const agents = await loadAgents();
  return agents[agentName];
}

