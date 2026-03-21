
import fs from 'fs/promises';
import path from 'path';

export interface ModelDefinition {
    id?: string;
    name?: string;
    provider?: string;
    model?: string;
    description?: string;
    oauthOnly?: boolean;
    auth?: string;
    embedding?: number[];
    [key: string]: any;
}

async function readJsonFile(filePath: string, fallback: any): Promise<any> {
    try {
        const content = await fs.readFile(filePath, 'utf8');
        return JSON.parse(content);
    } catch (error: any) {
        if (error.code === 'ENOENT') {
            return fallback;
        }
        throw new Error(`Failed to read JSON file "${filePath}": ${error.message}`);
    }
}

function normaliseModels(raw: any): ModelDefinition[] {
    if (!raw) {
        return [];
    }
    if (Array.isArray(raw)) {
        return raw;
    }
    if (Array.isArray(raw.models)) {
        return raw.models;
    }
    return [];
}

/**
 * Load models from JSON registry.
 */
export async function loadModelRegistry(registryPath: string): Promise<ModelDefinition[]> {
    const filePath = path.resolve(registryPath);
    const data = await readJsonFile(filePath, []);
    return normaliseModels(data);
}

/**
 * Load embedding index.
 */
export async function loadEmbeddingIndex(indexPath: string): Promise<Map<string, number[]>> {
    if (!indexPath) {
        return new Map();
    }

    const filePath = path.resolve(indexPath);
    const data = await readJsonFile(filePath, {});
    const map = new Map<string, number[]>();
    for (const [key, value] of Object.entries(data)) {
        if (Array.isArray(value)) {
            map.set(key, value as number[]);
        }
    }
    return map;
}

/**
 * Attach embeddings to models.
 */
export function attachEmbeddings(models: ModelDefinition[], embeddings: Map<string, number[]>): ModelDefinition[] {
    return models.map(model => {
        const merged = { ...model };
        if (!merged.id) {
            merged.id = merged.name;
        }
        const id = merged.id;
        if (id && embeddings.has(id)) {
            merged.embedding = embeddings.get(id);
        }
        return merged;
    });
}
