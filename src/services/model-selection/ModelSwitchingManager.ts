
import chalk from 'chalk';
import { selectModel, SelectorConfig } from './ModelSelector.js';
import { loadModelRegistry, ModelDefinition } from './ModelRegistry.js';

function ensureSystemPrompt(text: string | undefined, fallback: string): string {
    if (typeof text === 'string' && text.trim().length > 0) {
        return text;
    }
    return fallback;
}

function mergeCustomParams(baseParams: any = {}, overrideParams: any = {}): any {
    return {
        ...baseParams,
        ...overrideParams
    };
}

export interface RuntimeModelConfig extends ModelDefinition {
    apiKey?: string;
    systemPrompt: string;
    temperature?: number;
    customParams?: any;
    provider: string; // Ensure provider is present
}

export interface BaseExecutorConfig {
    model: string;
    provider: string; // provider is actually name in ProviderConfig, but here we need provider type name like 'gemini'
    systemPrompt: string;
    temperature?: number;
    customParams?: any;
    apiKey?: string;
}

export interface SwitchingConfig extends SelectorConfig {
    defaultModelId?: string;
}

async function resolveInitialModel(switchingConfig: SwitchingConfig, baseExecutorConfig: BaseExecutorConfig): Promise<any | null> {
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
        const override = overrides[defaultModelId] || (match.name ? overrides[match.name] : {});
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
    private baseExecutorConfig: BaseExecutorConfig;
    private switchingConfig: SwitchingConfig;
    private logger: ((msg: string, scope?: string) => void) | null;
    private currentModel: RuntimeModelConfig | null = null;
    private paramInitialised = false;

    constructor(baseExecutorConfig: BaseExecutorConfig, switchingConfig: SwitchingConfig, logger: ((msg: string, scope?: string) => void) | null = null) {
        this.baseExecutorConfig = baseExecutorConfig;
        this.switchingConfig = switchingConfig;
        this.logger = logger;
    }

    private log(message: string) {
        if (this.logger) {
            this.logger(message, 'model-switch');
        }
    }

    get selectorConfig(): SelectorConfig {
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
        if (this.paramInitialised) {
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

        this.paramInitialised = true;
    }

    buildRuntimeModelConfig(selection: any): RuntimeModelConfig {
        const provider = selection.provider || this.baseExecutorConfig.provider;
        const model = selection.model || selection.id || this.baseExecutorConfig.model;
        const systemPrompt = ensureSystemPrompt(selection.systemPrompt, this.baseExecutorConfig.systemPrompt);
        const temperature = selection.temperature ?? this.baseExecutorConfig.temperature;
        const customParams = mergeCustomParams(this.baseExecutorConfig.customParams, selection.customParams);
        const apiKey = selection.apiKey || this.baseExecutorConfig.apiKey;

        return {
            ...selection,
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

    async switchModel(description: string, extraOptions: any = {}): Promise<RuntimeModelConfig> {
        await this.ensureInitialised();

        this.log(chalk.gray(`[model-switch] Request to switch model: "${description}"`));

        const selection = await selectModel(description, this.selectorConfig, {
            logger: (message: string) => this.log(message),
            selectorLogger: extraOptions.selectorLogger || ((msg: string) => this.log(msg)),
            onUsage: extraOptions.onUsage || null
        });

        this.currentModel = this.buildRuntimeModelConfig(selection);
        this.log(chalk.green(`[model-switch] Active model: ${this.currentModel?.id} (${this.currentModel?.provider})`));
        return this.currentModel!;
    }

    getActiveModelConfig(): RuntimeModelConfig | null {
        return this.currentModel;
    }
}
