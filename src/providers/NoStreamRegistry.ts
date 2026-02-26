/**
 * NoStreamRegistry — Auto-learning registry of models that should skip streaming.
 *
 * Some providers (notably OpenRouter) have models that return malformed streaming
 * chunks for tool calls (e.g. `null` instead of a string for function arguments),
 * causing ZodError. The current fallback re-sends the entire request non-streaming,
 * doubling cost and latency.
 *
 * This registry:
 * - Persists a JSON file at `config/no-stream-models.json`
 * - Auto-records models that fail streaming (with reason + timestamp)
 * - Skips streaming for registered models on subsequent calls
 * - Can be manually edited to pre-blacklist models
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** Entry for a single model in the no-stream registry */
interface NoStreamEntry {
    reason: string;
    addedAt: string;
    failCount?: number;
}

/** Shape of the persisted JSON file */
interface NoStreamData {
    _description?: string;
    [provider: string]: Record<string, NoStreamEntry> | string | undefined;
}

/**
 * Singleton registry for models that must not use streaming with tool calls.
 *
 * @example
 * const registry = NoStreamRegistry.getInstance();
 * if (registry.isNoStream('openrouter', 'some/model')) { ... }
 */
export class NoStreamRegistry {
    private static instance: NoStreamRegistry | null = null;

    private data: NoStreamData = {};
    private loaded = false;
    private configPath: string;

    private constructor() {
        // Resolve config path relative to project root (two dirs up from src/providers/)
        const projectRoot = resolve(__dirname, '..', '..');
        this.configPath = resolve(projectRoot, 'config', 'no-stream-models.json');
    }

    /**
     * Get the singleton instance
     */
    static getInstance(): NoStreamRegistry {
        if (!NoStreamRegistry.instance) {
            NoStreamRegistry.instance = new NoStreamRegistry();
        }
        return NoStreamRegistry.instance;
    }

    /**
     * Check if a model is registered as no-stream for a given provider.
     *
     * @param provider - Provider name (e.g. 'openrouter')
     * @param model - Full model ID (e.g. 'anthropic/claude-3.5-sonnet')
     * @returns true if the model should skip streaming
     */
    isNoStream(provider: string, model: string): boolean {
        this.ensureLoaded();
        const providerMap = this.getProviderMap(provider);
        return providerMap !== null && model in providerMap;
    }

    /**
     * Record a streaming failure for a model, auto-registering it in the no-stream list.
     * Persists the change to disk immediately.
     *
     * @param provider - Provider name
     * @param model - Full model ID
     * @param error - Error message / reason for the failure
     */
    recordFailure(provider: string, model: string, error: string): void {
        this.ensureLoaded();

        // Ensure provider key exists as an object
        if (!this.data[provider] || typeof this.data[provider] === 'string') {
            this.data[provider] = {};
        }

        const providerMap = this.data[provider] as Record<string, NoStreamEntry>;
        const existing = providerMap[model];

        if (existing) {
            // Model already registered — increment fail count
            existing.failCount = (existing.failCount ?? 1) + 1;
            existing.reason = error; // Update with latest error
        } else {
            // New entry
            providerMap[model] = {
                reason: error,
                addedAt: new Date().toISOString(),
                failCount: 1,
            };
            console.log(
                `[NoStreamRegistry] Auto-registered model "${model}" for provider "${provider}" — streaming will be skipped on future calls.`
            );
        }

        this.save();
    }

    /**
     * Get all registered models for a provider.
     *
     * @param provider - Provider name
     * @returns Map of model ID → entry, or empty object
     */
    getModels(provider: string): Record<string, NoStreamEntry> {
        this.ensureLoaded();
        const providerMap = this.getProviderMap(provider);
        return providerMap ?? {};
    }

    /**
     * Remove a model from the no-stream registry (e.g. if the bug is fixed upstream).
     *
     * @param provider - Provider name
     * @param model - Full model ID
     * @returns true if the model was found and removed
     */
    removeModel(provider: string, model: string): boolean {
        this.ensureLoaded();
        const providerMap = this.getProviderMap(provider);
        if (providerMap && model in providerMap) {
            delete providerMap[model];
            this.save();
            console.log(`[NoStreamRegistry] Removed model "${model}" from no-stream list for "${provider}".`);
            return true;
        }
        return false;
    }

    // ---------------------------------------------------------------------------
    // Private helpers
    // ---------------------------------------------------------------------------

    /** Lazy-load the config file on first access */
    private ensureLoaded(): void {
        if (this.loaded) return;

        if (existsSync(this.configPath)) {
            try {
                const raw = readFileSync(this.configPath, 'utf-8');
                this.data = JSON.parse(raw) as NoStreamData;
            } catch (err) {
                console.warn(`[NoStreamRegistry] Failed to parse ${this.configPath}, starting fresh.`, err);
                this.data = {};
            }
        } else {
            // Create a default config file
            this.data = {
                _description:
                    'Models listed here will always use non-streaming mode for tool calls. ' +
                    'Auto-populated when streaming fails. You can also add models manually.',
                openrouter: {},
            };
            this.save();
        }

        this.loaded = true;
    }

    /** Safely get the provider map (object), returning null for missing/invalid entries */
    private getProviderMap(provider: string): Record<string, NoStreamEntry> | null {
        const entry = this.data[provider];
        if (entry && typeof entry === 'object') {
            return entry as Record<string, NoStreamEntry>;
        }
        return null;
    }

    /** Persist current state to disk */
    private save(): void {
        try {
            const dir = dirname(this.configPath);
            if (!existsSync(dir)) {
                mkdirSync(dir, { recursive: true });
            }
            writeFileSync(this.configPath, JSON.stringify(this.data, null, 2) + '\n', 'utf-8');
        } catch (err) {
            console.error(`[NoStreamRegistry] Failed to save ${this.configPath}:`, err);
        }
    }
}

export default NoStreamRegistry;
