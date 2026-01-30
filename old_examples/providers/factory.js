import { OpenRouterProvider } from './openrouter.js';
import { GeminiProvider } from './gemini.js';
import { CerebrasProvider } from './cerebras.js';
import { SambaNovaProvider } from './sambanova.js';

const PROVIDER_MAP = {
  openrouter: OpenRouterProvider,
  gemini: GeminiProvider,
  cerebras: CerebrasProvider,
  sambanova: SambaNovaProvider
};

/**
 * Создать экземпляр провайдера по имени.
 * @param {string} providerName
 * @param {string} apiKey
 * @param {string} model
 * @param {Function|null} logger
 * @param {object} customParams
 * @returns {BaseProvider}
 */
export function createProviderInstance(providerName, apiKey, model, logger = null, customParams = {}) {
  if (!providerName) {
    throw new Error('Не указан провайдер модели.');
  }
  const normalized = providerName.toLowerCase();
  const ProviderClass = PROVIDER_MAP[normalized];
  if (!ProviderClass) {
    throw new Error(`Неизвестный провайдер: ${providerName}`);
  }
  return new ProviderClass(apiKey, model, logger, customParams);
}


