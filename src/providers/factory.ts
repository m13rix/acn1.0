
import { Provider } from '../types/index.js';
import { GeminiProvider } from './gemini.js';
import { InceptionProvider } from './inception.js';
import { OpenRouterProvider } from './openrouter.js';
import { OllamaProvider } from './ollama.js';
import { OpenAICodexProvider } from './openai-codex/index.js';
import { AiSdkTextProvider } from './ai-sdk-text.js';

export type ProviderName = 'gemini' | 'inception' | 'openrouter' | 'ollama' | 'openai-codex' | string;

export function createProvider(name: ProviderName, apiKey?: string): Provider {
    const normalized = name.toLowerCase();

    if (['gemini', 'inception', 'openrouter', 'ollama', 'kimi-code', 'openai-codex'].includes(normalized)) {
        return new AiSdkTextProvider(normalized, apiKey);
    }

    if (normalized === 'gemini') {
        return new GeminiProvider(apiKey);
    }

    if (normalized === 'inception') {
        return new InceptionProvider(apiKey);
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
