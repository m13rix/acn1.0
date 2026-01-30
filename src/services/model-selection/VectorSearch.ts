
import similarity from 'compute-cosine-similarity';

export interface ModelWithEmbedding {
    id?: string;
    name?: string;
    embedding?: number[];
    [key: string]: any;
}

export interface ScoredModel extends ModelWithEmbedding {
    similarity: number;
}

/**
 * Rank models by cosine similarity to a query embedding.
 */
export function rankBySimilarity(
    models: ModelWithEmbedding[],
    queryEmbedding: number[],
    topK: number,
    minSimilarity: number = 0
): ScoredModel[] {
    if (!Array.isArray(models) || models.length === 0) {
        return [];
    }
    if (!Array.isArray(queryEmbedding) || queryEmbedding.length === 0) {
        return models.slice(0, topK) as ScoredModel[];
    }

    const scored: ScoredModel[] = models
        .filter(model => model && Array.isArray(model.embedding) && model.embedding.length === queryEmbedding.length)
        .map(model => ({
            ...model,
            similarity: similarity(queryEmbedding, model.embedding!) || 0
        }))
        .filter(item => item.similarity >= minSimilarity)
        .sort((a, b) => b.similarity - a.similarity);

    if (typeof topK === 'number' && topK > 0) {
        return scored.slice(0, topK);
    }

    return scored;
}
