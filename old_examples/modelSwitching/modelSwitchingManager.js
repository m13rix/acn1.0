import chalk from 'chalk';
import { selectModel } from './modelSelector.js';
import { loadModelRegistry } from './modelRegistry.js';

function ensureSystemPrompt(text, fallback) {
  if (typeof text === 'string' && text.trim().length > 0) {
    return text;
  }
  return fallback;
}

function mergeCustomParams(baseParams = {}, overrideParams = {}) {
  return {
    ...baseParams,
    ...overrideParams
  };
}

async function resolveInitialModel(switchingConfig, baseExecutorConfig) {
  const { defaultModelId, registryPath, overrides = {} } = switchingConfig;
  if (!defaultModelId) {
    return null;
  }

  try {
    const models = await loadModelRegistry(registryPath);
    const match = models.find(item => {
      const id = item.id || item.name;
      return id === defaultModelId;
    });
    if (!match) {
      return null;
    }
    const override = overrides[defaultModelId] || overrides[match.name];
    return {
      ...match,
      ...(override || {}),
      systemPrompt: ensureSystemPrompt(override?.systemPrompt, baseExecutorConfig.systemPrompt),
      temperature: override?.temperature ?? baseExecutorConfig.temperature,
      customParams: mergeCustomParams(baseExecutorConfig.customParams, override?.customParams),
      apiKey: override?.apiKey
    };
  } catch {
    return null;
  }
}

export class ModelSwitchingManager {
  constructor(baseExecutorConfig, switchingConfig, logger = null) {
    this.baseExecutorConfig = baseExecutorConfig;
    this.switchingConfig = switchingConfig;
    this.logger = logger;
    this.currentModel = null;
    this.initialised = false;
  }

  log(message) {
    if (this.logger) {
      this.logger(message, 'model-switch');
    }
  }

  get selectorConfig() {
    return {
      registryPath: this.switchingConfig.registryPath,
      embeddingIndexPath: this.switchingConfig.embeddingIndexPath,
      mode: this.switchingConfig.mode,
      whitelist: this.switchingConfig.whitelist,
      blacklist: this.switchingConfig.blacklist,
      topK: this.switchingConfig.topK,
      overrides: this.switchingConfig.overrides,
      selector: this.switchingConfig.selector,
      embedding: this.switchingConfig.embedding
    };
  }

  async ensureInitialised() {
    if (this.initialised) {
      return;
    }

    if (this.switchingConfig.defaultModelId) {
      const resolved = await resolveInitialModel(this.switchingConfig, this.baseExecutorConfig);
      if (resolved) {
        this.currentModel = this.buildRuntimeModelConfig(resolved);
      }
    }

    if (!this.currentModel) {
      this.currentModel = this.buildRuntimeModelConfig({
        id: this.baseExecutorConfig.model,
        name: this.baseExecutorConfig.model,
        provider: this.baseExecutorConfig.provider,
        model: this.baseExecutorConfig.model,
        systemPrompt: this.baseExecutorConfig.systemPrompt,
        temperature: this.baseExecutorConfig.temperature,
        customParams: this.baseExecutorConfig.customParams
      });
    }

    this.initialised = true;
  }

  buildRuntimeModelConfig(selection) {
    const provider = selection.provider || this.baseExecutorConfig.provider;
    const model = selection.model || selection.id || this.baseExecutorConfig.model;
    const systemPrompt = ensureSystemPrompt(selection.systemPrompt, this.baseExecutorConfig.systemPrompt);
    const temperature = selection.temperature ?? this.baseExecutorConfig.temperature;
    const customParams = mergeCustomParams(this.baseExecutorConfig.customParams, selection.customParams);
    const apiKey = selection.apiKey || this.baseExecutorConfig.apiKey;

    return {
      id: selection.id || selection.name || model,
      name: selection.name || selection.id || model,
      provider,
      model,
      systemPrompt,
      temperature,
      customParams,
      apiKey
    };
  }

  async switchModel(description, extraOptions = {}) {
    await this.ensureInitialised();

    this.log(chalk.gray(`[model-switch] Получен запрос переключения модели: "${description}"`));

    const selection = await selectModel(description, this.selectorConfig, {
      logger: (message) => this.log(message),
      selectorLogger: extraOptions.selectorLogger || ((msg) => this.log(msg)),
      onUsage: extraOptions.onUsage || null
    });

    this.currentModel = this.buildRuntimeModelConfig(selection);
    this.log(chalk.green(`[model-switch] Активная модель: ${this.currentModel.id} (${this.currentModel.provider})`));
    return this.currentModel;
  }

  getActiveModelConfig() {
    return this.currentModel;
  }
}


