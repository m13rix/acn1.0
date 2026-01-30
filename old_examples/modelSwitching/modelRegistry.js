import fs from 'fs/promises';
import path from 'path';

async function readJsonFile(filePath, fallback) {
  try {
    const content = await fs.readFile(filePath, 'utf8');
    return JSON.parse(content);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return fallback;
    }
    throw new Error(`Не удалось прочитать JSON-файл "${filePath}": ${error.message}`);
  }
}

function normaliseModels(raw) {
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

function resolvePath(basePath, maybeRelative) {
  if (!maybeRelative) {
    return null;
  }
  if (path.isAbsolute(maybeRelative)) {
    return maybeRelative;
  }
  return path.join(basePath, maybeRelative);
}

/**
 * Загрузить базу моделей.
 * @param {string} registryPath - путь до JSON с моделями
 * @returns {Promise<Array>}
 */
export async function loadModelRegistry(registryPath) {
  const filePath = path.resolve(registryPath);
  const data = await readJsonFile(filePath, []);
  return normaliseModels(data);
}

/**
 * Загрузить индекс эмбеддингов.
 * @param {string} indexPath
 * @returns {Promise<Map<string, number[]>>}
 */
export async function loadEmbeddingIndex(indexPath) {
  if (!indexPath) {
    return new Map();
  }

  const filePath = path.resolve(indexPath);
  const data = await readJsonFile(filePath, {});
  const map = new Map();
  for (const [key, value] of Object.entries(data)) {
    if (Array.isArray(value)) {
      map.set(key, value);
    }
  }
  return map;
}

/**
 * Объединить модели и эмбеддинги.
 * @param {Array} models
 * @param {Map<string, number[]>} embeddings
 * @returns {Array}
 */
export function attachEmbeddings(models, embeddings) {
  return models.map(model => {
    const merged = { ...model };
    if (!merged.id) {
      merged.id = merged.name;
    }
    if (merged.id && embeddings.has(merged.id)) {
      merged.embedding = embeddings.get(merged.id);
    }
    return merged;
  });
}

export { resolvePath };


