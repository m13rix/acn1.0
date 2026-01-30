import similarity from 'compute-cosine-similarity';

/**
 * Выполнить сортировку моделей по косинусной близости.
 * @param {Array} models - модели с полем embedding
 * @param {number[]} queryEmbedding - эмбеддинг запроса
 * @param {number} topK - ограничение на количество результатов
 * @param {number} [minSimilarity=0] - минимальная схожесть
 * @returns {Array}
 */
export function rankBySimilarity(models, queryEmbedding, topK, minSimilarity = 0) {
  if (!Array.isArray(models) || models.length === 0) {
    return [];
  }
  if (!Array.isArray(queryEmbedding) || queryEmbedding.length === 0) {
    return models.slice(0, topK);
  }

  const scored = models
    .filter(model => Array.isArray(model.embedding) && model.embedding.length === queryEmbedding.length)
    .map(model => ({
      ...model,
      similarity: similarity(queryEmbedding, model.embedding)
    }))
    .filter(item => item.similarity >= minSimilarity)
    .sort((a, b) => b.similarity - a.similarity);

  if (typeof topK === 'number' && topK > 0) {
    return scored.slice(0, topK);
  }

  return scored;
}


