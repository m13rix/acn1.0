/**
 * Keyword Extractor
 * 
 * Extracts semantically important keywords from user queries.
 * Keywords are ranked by their similarity to the overall query meaning.
 */

import { embed, embedBatch, cosineSimilarity } from './embeddings.js';

export interface ExtractedKeyword {
  word: string;
  vector: number[];
  score: number;  // Similarity to full query (0-1)
  rank: number;   // Position in ranked list (0 = most important)
}

export interface ExtractionResult {
  query: string;
  queryVector: number[];
  keywords: ExtractedKeyword[];
}

/**
 * Extract words from text using Unicode-aware regex
 */
function tokenize(text: string): string[] {
  const matches = text.match(/\p{L}[\p{L}\p{N}_-]*/gu) || [];
  return matches.filter(w => w.length > 1); // Skip single chars
}

/**
 * Deduplicate keywords by similarity threshold
 * Keeps the higher-scoring keyword when two are too similar
 */
function deduplicateKeywords(
  keywords: ExtractedKeyword[], 
  threshold: number = 0.95
): ExtractedKeyword[] {
  const result: ExtractedKeyword[] = [];
  
  for (const kw of keywords) {
    // Check if this is too similar to an existing keyword
    let isDuplicate = false;
    
    for (let i = 0; i < result.length; i++) {
      const existing = result[i];
      const similarity = cosineSimilarity(kw.vector, existing.vector);
      
      if (similarity >= threshold) {
        isDuplicate = true;
        // Keep the one with higher score
        if (kw.score > existing.score) {
          result[i] = kw;
        }
        break;
      }
    }
    
    if (!isDuplicate) {
      result.push(kw);
    }
  }
  
  return result;
}

/**
 * Extract and rank keywords from a query
 * 
 * @param query - The user's query
 * @param dedupeThreshold - Similarity threshold for deduplication (0-1)
 * @returns Extraction result with ranked keywords
 */
export async function extractKeywords(
  query: string,
  dedupeThreshold: number = 0.95
): Promise<ExtractionResult> {
  // Tokenize the query
  const words = tokenize(query);
  const uniqueWords = [...new Set(words.map(w => w.toLowerCase()))];
  
  if (uniqueWords.length === 0) {
    const queryVector = await embed(query);
    return { query, queryVector, keywords: [] };
  }
  
  // Embed query and all words in parallel
  const [queryVector, ...wordVectors] = await Promise.all([
    embed(query),
    ...uniqueWords.map(embed)
  ]);
  
  // Score each word by similarity to query
  const scored: ExtractedKeyword[] = uniqueWords.map((word, i) => ({
    word,
    vector: wordVectors[i],
    score: cosineSimilarity(queryVector, wordVectors[i]),
    rank: 0 // Will be set after sorting
  }));
  
  // Sort by score descending
  scored.sort((a, b) => b.score - a.score);
  
  // Deduplicate similar words
  const deduplicated = deduplicateKeywords(scored, dedupeThreshold);
  
  // Re-sort and assign ranks
  deduplicated.sort((a, b) => b.score - a.score);
  deduplicated.forEach((kw, i) => {
    kw.rank = i;
  });
  
  return { query, queryVector, keywords: deduplicated };
}
