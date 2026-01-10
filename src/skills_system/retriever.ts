/**
 * Skill Retriever
 * 
 * The main retrieval algorithm that scores skill entries based on
 * weighted keyword similarity.
 */

import { extractKeywords, ExtractionResult, ExtractedKeyword } from './extractor.js';
import { computeWeights, ScoringParams, DEFAULT_PARAMS } from './scorer.js';
import { cosineSimilarity, embed } from './embeddings.js';

/**
 * A message in the conversation history
 */
export interface MessageHistory {
  id: string;
  query: string;
  queryVector: number[];
  extraction: ExtractionResult;
  timestamp: number;
}

/**
 * A skill entry from the database
 */
export interface SkillEntry {
  id: string;
  content: string;
  vector: number[];
}

/**
 * Detailed scoring breakdown for a single keyword
 */
export interface KeywordMatch {
  keyword: string;
  keywordRank: number;
  keywordScore: number;     // Keyword's importance to query
  weight: number;           // Weight from decay curve
  similarity: number;       // Cosine similarity to entry
  weightedScore: number;    // weight * similarity
}

/**
 * Full scoring result for a skill entry
 */
export interface ScoredEntry {
  entry: SkillEntry;
  totalScore: number;
  normalizedScore: number;  // 0-1 range
  matches: KeywordMatch[];
  querySimilarity: number;  // Direct similarity between query and entry
  querySimilarityScore: number;  // Weighted query similarity contribution
  keywordScore: number;  // Score from keyword-based matching
}

/**
 * Full retrieval result with debug info
 */
export interface RetrievalResult {
  query: string;
  extraction: ExtractionResult;
  weights: number[];
  params: ScoringParams;
  entries: ScoredEntry[];
  timing: {
    extractionMs: number;
    scoringMs: number;
    totalMs: number;
  };
}

/**
 * Score a single entry against extracted keywords, full query, and message history
 */
function scoreEntry(
  entry: SkillEntry,
  keywords: ExtractedKeyword[],
  weights: number[],
  queryVector: number[],
  querySimilarityWeight: number,
  messageHistory: MessageHistory[],
  historyDecay: number
): ScoredEntry {
  const matches: KeywordMatch[] = [];
  let keywordScore = 0;
  let maxPossibleKeywordScore = 0;
  
  // Score based on keyword similarities (current query)
  for (let i = 0; i < keywords.length; i++) {
    const kw = keywords[i];
    const weight = weights[i] || 0;
    
    // Compute similarity between entry and keyword
    const similarity = cosineSimilarity(entry.vector, kw.vector);
    const weightedScore = weight * similarity;
    
    matches.push({
      keyword: kw.word,
      keywordRank: kw.rank,
      keywordScore: kw.score,
      weight,
      similarity,
      weightedScore,
    });
    
    keywordScore += weightedScore;
    maxPossibleKeywordScore += weight; // Max similarity is 1.0
  }
  
  // Add scores from message history with decay
  let historyKeywordScore = 0;
  let historyQuerySimilarityScore = 0;
  let maxHistoryScore = 0;
  
  for (let i = 0; i < messageHistory.length; i++) {
    const message = messageHistory[i];
    const decayFactor = Math.pow(historyDecay, i + 1); // Previous message = decay^1, one before = decay^2, etc.
    
    // Score keywords from history message
    const historyWeights = computeWeights(message.extraction.keywords.length, { baseWeight: 1.0 });
    for (let j = 0; j < message.extraction.keywords.length; j++) {
      const kw = message.extraction.keywords[j];
      const weight = historyWeights[j] || 0;
      const similarity = cosineSimilarity(entry.vector, kw.vector);
      const weightedScore = weight * similarity * decayFactor;
      historyKeywordScore += weightedScore;
      maxHistoryScore += weight * decayFactor;
    }
    
    // Score query similarity from history message
    const historyQuerySimilarity = cosineSimilarity(message.queryVector, entry.vector);
    const weightedHistoryQuerySimilarity = querySimilarityWeight * historyQuerySimilarity * decayFactor;
    historyQuerySimilarityScore += weightedHistoryQuerySimilarity;
    maxHistoryScore += querySimilarityWeight * decayFactor;
  }
  
  // Compute direct query-to-entry similarity (current query)
  const querySimilarity = cosineSimilarity(queryVector, entry.vector);
  const querySimilarityScore = querySimilarityWeight * querySimilarity;
  
  // Combine all scores: current keyword score + current query similarity + history scores
  const totalScore = keywordScore + querySimilarityScore + historyKeywordScore + historyQuerySimilarityScore;
  
  // Normalize to 0-1 range
  // Max possible score = max keyword score + query similarity weight + history scores
  const maxPossibleScore = maxPossibleKeywordScore + querySimilarityWeight + maxHistoryScore;
  const normalizedScore = maxPossibleScore > 0 
    ? totalScore / maxPossibleScore 
    : 0;
  
  return {
    entry,
    totalScore,
    normalizedScore,
    matches,
    querySimilarity,
    querySimilarityScore,
    keywordScore,
  };
}

/**
 * Retrieve and score skill entries
 * 
 * @param query - User's query
 * @param entries - Skill entries to search
 * @param params - Scoring parameters
 * @param limit - Max entries to return (0 = all)
 * @param messageHistory - Previous messages in the conversation (optional)
 * @param historyDecay - Decay factor for message history (default: 0.7)
 */
export async function retrieve(
  query: string,
  entries: SkillEntry[],
  params: Partial<ScoringParams> = {},
  limit: number = 0,
  messageHistory: MessageHistory[] = [],
  historyDecay: number = 0.7
): Promise<RetrievalResult> {
  const startTime = performance.now();
  
  // Extract keywords and embed query
  const extractionStart = performance.now();
  const [extraction, queryVector] = await Promise.all([
    extractKeywords(query),
    embed(query)
  ]);
  const extractionMs = performance.now() - extractionStart;
  
  // Compute weights
  const fullParams = { ...DEFAULT_PARAMS, ...params };
  const weights = computeWeights(extraction.keywords.length, fullParams);
  
  // Score all entries (including message history)
  const scoringStart = performance.now();
  const scoredEntries = entries.map(entry => 
    scoreEntry(
      entry, 
      extraction.keywords, 
      weights, 
      queryVector, 
      fullParams.querySimilarityWeight,
      messageHistory,
      historyDecay
    )
  );
  
  // Sort by score descending
  scoredEntries.sort((a, b) => b.totalScore - a.totalScore);
  
  // Apply limit
  const limitedEntries = limit > 0 
    ? scoredEntries.slice(0, limit) 
    : scoredEntries;
  
  const scoringMs = performance.now() - scoringStart;
  const totalMs = performance.now() - startTime;
  
  return {
    query,
    extraction,
    weights,
    params: fullParams,
    entries: limitedEntries,
    timing: {
      extractionMs,
      scoringMs,
      totalMs,
    },
  };
}

/**
 * Quick similarity check between query and single entry
 * Uses direct cosine similarity without keyword extraction
 */
export async function quickMatch(
  query: string,
  entry: SkillEntry
): Promise<number> {
  const queryVector = await embed(query);
  return cosineSimilarity(queryVector, entry.vector);
}
