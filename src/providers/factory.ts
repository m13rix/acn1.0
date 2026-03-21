
import { Provider } from '../types/index.js';
import { GeminiProvider } from './gemini.js';
import { OpenRouterProvider } from './openrouter.js';
import { OllamaProvider } from './ollama.js';
import { OpenAICodexProvider } from './openai-codex/index.js';

export type ProviderName = 'gemini' | 'openrouter' | 'ollama' | 'openai-codex' | string;

export function createProvider(name: ProviderName, apiKey?: string): Provider {
    const normalized = name.toLowerCase();

    if (normalized === 'gemini') {
        return new GeminiProvider(apiKey);
    }

    if (normalized === 'openrouter') {
        return new OpenRouterProvider(apiKey);
    }

    if (normalized === 'ollama') {
        return new OllamaProvider(); // Ollama usually doesn't need API key, host is env
    }

    if (normalized === 'openai-codex') {
        return new OpenAICodexProvider();
    }

    throw new Error(`Unknown provider: ${name}`);
}
