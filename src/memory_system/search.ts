import type { PhraseType, WeightedQueryPhrase } from './phrases.js';
import type {
  CandidateSelectionOptions,
  FactRecord,
  LinkRecord,
  MemoryRuntimeConfig,
  PhraseAggregationMode,
  RetrievalHintRecord,
  SearchOptions,
  SeedFactScore,
} from './types.js';

export interface IndexedFactRecord {
  fact: FactRecord;
  hints: RetrievalHintRecord[];
  globalSearchEmbeddings?: number[][];
  phraseSearchEmbeddings?: Record<PhraseType, number[][]>;
}

export interface EmbeddedWeightedQueryPhrase extends WeightedQueryPhrase {
  embedding: number[];
}

export interface SearchQueryVectors {
  globalEmbedding: number[];
  phrases: EmbeddedWeightedQueryPhrase[];
}

export interface GraphSearchConfig {
  maxDepth: number;
  maxChains: number;
  beamWidth: number;
}

export interface GraphChainResult {
  text: string;
  factIds: string[];
}

export interface AutoCandidateSelectionAnalysis {
  analysisFloor: number;
  consideredCount: number;
  limitedCount: number;
  minCandidates: number;
  maxCandidates: number;
  headSuppressionCount: number;
  chosenThreshold: number;
  chosenCount: number;
  chosenCutIndex: number;
  candidateMetrics: Array<{
    cutIndex: number;
    score: number;
    nextScore: number;
    gap: number;
    prevGapMean: number;
    nextGapMean: number;
    elbowDistance: number;
    headPenalty: number;
    composite: number;
  }>;
}

export interface AnchorRescueAnalysis {
  anchorPhrases: Array<{
    text: string;
    weight: number;
    type: PhraseType;
  }>;
  lexicalScoreFloor: number;
  rescuedFacts: Array<{
    factId: string;
    score: number;
    anchorScore: number;
    matchedPhrases: string[];
  }>;
}

interface PathState {
  factIds: string[];
  links: LinkRecord[];
  score: number;
}

function clampSimilarity(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, value);
}

function dotSimilarity(a: number[] | ArrayLike<number>, b: number[] | ArrayLike<number>): number {
  if (!a || !b || a.length === 0 || b.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  for (let index = 0; index < a.length; index++) {
    dot += (a[index] as number) * (b[index] as number);
  }
  return Number.isFinite(dot) ? dot : 0;
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
  }
  return sorted[middle] ?? 0;
}

function normalizeLexicalText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[_\-./\\]+/g, ' ')
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function lexicalTokens(text: string): string[] {
  const normalized = normalizeLexicalText(text);
  return normalized ? normalized.split(' ') : [];
}

function isIdentifierLikeAnchor(text: string): boolean {
  const normalized = normalizeLexicalText(text);
  if (!normalized) return false;
  if (/^\d+$/.test(normalized)) return true;
  if (/^(subject|subj|person|entity|id)\s+\d+$/i.test(normalized)) return true;
  return false;
}

function containsTokenSequence(haystack: string[], needle: string[]): boolean {
  if (needle.length === 0 || haystack.length < needle.length) return false;
  for (let start = 0; start <= haystack.length - needle.length; start++) {
    let matched = true;
    for (let offset = 0; offset < needle.length; offset++) {
      if (haystack[start + offset] !== needle[offset]) {
        matched = false;
        break;
      }
    }
    if (matched) return true;
  }
  return false;
}

function lexicalAnchorMatch(queryText: string, candidateText: string): number {
  const queryTokens = lexicalTokens(queryText);
  const candidateTokens = lexicalTokens(candidateText);
  if (queryTokens.length === 0 || candidateTokens.length === 0) return 0;

  const normalizedQuery = queryTokens.join(' ');
  const normalizedCandidate = candidateTokens.join(' ');
  if (normalizedQuery === normalizedCandidate) {
    return 1;
  }

  if (containsTokenSequence(candidateTokens, queryTokens)) {
    return queryTokens.length === 1 ? 0.97 : 0.95;
  }

  if (/^\d+$/.test(normalizedQuery) && candidateTokens.includes(normalizedQuery)) {
    return 0.93;
  }

  return 0;
}

function getEntryLexicalTexts(entry: IndexedFactRecord): string[] {
  const texts = new Set<string>();
  texts.add(entry.fact.text);
  for (const phrase of entry.fact.phrases.np) {
    texts.add(phrase.text);
  }
  for (const hint of entry.hints) {
    texts.add(hint.text);
    for (const phrase of hint.phrases.np) {
      texts.add(phrase.text);
    }
  }
  return Array.from(texts);
}

function getPhraseEmbeddings(
  entry: IndexedFactRecord,
  type: PhraseType,
): number[][] {
  if (entry.phraseSearchEmbeddings?.[type]) {
    return entry.phraseSearchEmbeddings[type];
  }
  const vectors: number[][] = [];
  const factPhrases = entry.fact.phrases[type];
  for (const phrase of factPhrases) {
    vectors.push(phrase.embedding);
  }
  for (const hint of entry.hints) {
    for (const phrase of hint.phrases[type]) {
      vectors.push(phrase.embedding);
    }
  }
  return vectors;
}

function getGlobalEmbeddings(entry: IndexedFactRecord): number[][] {
  if (entry.globalSearchEmbeddings) {
    return entry.globalSearchEmbeddings;
  }
  return [
    entry.fact.globalEmbedding,
    ...entry.hints.map(hint => hint.globalEmbedding),
  ].filter((vector) => vector.length > 0);
}

function scoreSpace(
  queryEmbedding: number[],
  candidateEmbeddings: number[][],
  mode: PhraseAggregationMode,
): number {
  if (queryEmbedding.length === 0 || candidateEmbeddings.length === 0) {
    return 0;
  }

  if (mode === 'sum') {
    let total = 0;
    for (const candidateEmbedding of candidateEmbeddings) {
      total += clampSimilarity(dotSimilarity(queryEmbedding, candidateEmbedding));
    }
    return total;
  }

  let best = 0;
  for (const candidateEmbedding of candidateEmbeddings) {
    best = Math.max(best, clampSimilarity(dotSimilarity(queryEmbedding, candidateEmbedding)));
  }
  return best;
}

export function scoreSeedFacts(
  entries: IndexedFactRecord[],
  query: SearchQueryVectors,
  phraseAggregationMode: PhraseAggregationMode,
  overallEmbeddingWeight: number,
  categoryMultipliers?: Record<string, number>,
): SeedFactScore[] {
  const defaultMultiplier = 1;
  return entries
    .map((entry) => {
      let score = scoreSpace(query.globalEmbedding, getGlobalEmbeddings(entry), 'max') * overallEmbeddingWeight;

      for (const phrase of query.phrases) {
        const embeddings = getPhraseEmbeddings(entry, phrase.type);
        const phraseScore = scoreSpace(phrase.embedding, embeddings, phraseAggregationMode);
        score += phraseScore * phrase.weight;
      }

      const category = entry.fact.exclusiveToAgentName ?? '';
      const multiplier = category ? (categoryMultipliers?.[category] ?? defaultMultiplier) : defaultMultiplier;
      score *= multiplier;

      return {
        factId: entry.fact.id,
        score,
      };
    })
    .sort((a, b) => b.score - a.score);
}

export function resolveCandidateSelection(
  config: MemoryRuntimeConfig,
  options?: SearchOptions,
): Required<CandidateSelectionOptions> {
  const incoming = options?.candidateSelection;
  const mode = incoming?.mode === 'threshold' || incoming?.mode === 'range' || incoming?.mode === 'auto' || incoming?.mode === 'top-k'
    ? incoming.mode
    : config.searchDefaultCandidateMode;
  const topK = Math.max(1, Math.floor(incoming?.topK ?? config.searchDefaultTopK));
  const threshold = Number.isFinite(incoming?.threshold)
    ? Number(incoming?.threshold)
    : config.searchDefaultThreshold;
  const minCandidates = Math.max(1, Math.floor(incoming?.minCandidates ?? config.searchDefaultRangeMin));
  const maxCandidates = Math.max(minCandidates, Math.floor(incoming?.maxCandidates ?? config.searchDefaultRangeMax));

  return {
    mode,
    topK,
    threshold,
    minCandidates,
    maxCandidates,
  };
}

export function analyzeAutoCandidateSelection(
  scores: SeedFactScore[],
  selection: Required<CandidateSelectionOptions>,
): AutoCandidateSelectionAnalysis {
  const analysisFloor = Math.max(0.6, selection.threshold);
  const considered = scores.filter((score) => score.score >= analysisFloor);
  const maxCandidates = Math.max(selection.maxCandidates, selection.minCandidates + 12, 24);
  const limited = considered.slice(0, Math.min(considered.length, maxCandidates));
  const limitedScores = limited.map((item) => item.score);
  const gaps = limitedScores.slice(0, -1).map((score, index) => score - (limitedScores[index + 1] ?? score));
  const gapMedian = Math.max(1e-6, median(gaps));
  const headSuppressionCount = Math.max(4, Math.ceil(limited.length * 0.25));

  if (limited.length === 0) {
    return {
      analysisFloor,
      consideredCount: 0,
      limitedCount: 0,
      minCandidates: selection.minCandidates,
      maxCandidates,
      headSuppressionCount,
      chosenThreshold: selection.threshold,
      chosenCount: 0,
      chosenCutIndex: -1,
      candidateMetrics: [],
    };
  }

  if (limited.length <= selection.minCandidates) {
    const chosenThreshold = limited[limited.length - 1]?.score ?? analysisFloor;
    return {
      analysisFloor,
      consideredCount: considered.length,
      limitedCount: limited.length,
      minCandidates: selection.minCandidates,
      maxCandidates,
      headSuppressionCount,
      chosenThreshold,
      chosenCount: limited.length,
      chosenCutIndex: limited.length - 1,
      candidateMetrics: [],
    };
  }

  const head = limitedScores[0] ?? 0;
  const tail = limitedScores[limitedScores.length - 1] ?? head;
  const scoreRange = Math.max(1e-6, head - tail);
  const candidateMetrics: AutoCandidateSelectionAnalysis['candidateMetrics'] = [];

  for (let cutIndex = Math.max(0, selection.minCandidates - 1); cutIndex < limited.length - 1; cutIndex++) {
    const gap = gaps[cutIndex] ?? 0;
    const prevGapMean = mean(gaps.slice(Math.max(0, cutIndex - 3), cutIndex)) || gapMedian;
    const nextGapMean = mean(gaps.slice(cutIndex + 1, Math.min(gaps.length, cutIndex + 4))) || gapMedian;
    const x = limited.length <= 1 ? 1 : cutIndex / (limited.length - 1);
    const y = ((limitedScores[cutIndex] ?? tail) - tail) / scoreRange;
    const lineY = 1 - x;
    const elbowDistance = Math.max(0, lineY - y);
    const headPenalty = Math.min(1, (cutIndex + 1) / headSuppressionCount);
    const sharpness = gap / Math.max(gapMedian * 0.5, prevGapMean, 1e-6);
    const tailBreak = gap / Math.max(gapMedian * 0.5, nextGapMean, 1e-6);
    const composite = gap
      * Math.sqrt(Math.max(1, sharpness) * Math.max(1, tailBreak))
      * (0.35 + 0.65 * headPenalty)
      * (1 + elbowDistance);

    candidateMetrics.push({
      cutIndex,
      score: limitedScores[cutIndex] ?? 0,
      nextScore: limitedScores[cutIndex + 1] ?? 0,
      gap,
      prevGapMean,
      nextGapMean,
      elbowDistance,
      headPenalty,
      composite,
    });
  }

  const best = candidateMetrics
    .sort((a, b) => b.composite - a.composite || b.cutIndex - a.cutIndex)[0];
  const chosenCutIndex = best?.cutIndex ?? Math.min(limited.length - 1, selection.minCandidates - 1);
  const chosenThreshold = limited[chosenCutIndex + 1]?.score ?? limited[chosenCutIndex]?.score ?? analysisFloor;
  const chosenCount = scores.filter((score) => score.score >= chosenThreshold).length;

  return {
    analysisFloor,
    consideredCount: considered.length,
    limitedCount: limited.length,
    minCandidates: selection.minCandidates,
    maxCandidates,
    headSuppressionCount,
    chosenThreshold,
    chosenCount,
    chosenCutIndex,
    candidateMetrics,
  };
}

export function analyzeAnchorRescue(
  entries: IndexedFactRecord[],
  scores: SeedFactScore[],
  queryPhrases: WeightedQueryPhrase[],
): AnchorRescueAnalysis {
  const scoreByFactId = new Map(scores.map((item) => [item.factId, item.score]));
  const lexicalScoreFloor = Math.max(0.45, Math.min(0.72, (scores[0]?.score ?? 0) * 0.65));
  const anchorPhrases = queryPhrases
    .filter((phrase) => phrase.type === 'np')
    .filter((phrase) => phrase.weight >= 0.18 || isIdentifierLikeAnchor(phrase.text))
    .filter((phrase) => isIdentifierLikeAnchor(phrase.text))
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 3)
    .map((phrase) => ({
      text: phrase.text,
      weight: phrase.weight,
      type: phrase.type,
    }));

  if (anchorPhrases.length === 0) {
    return {
      anchorPhrases: [],
      lexicalScoreFloor,
      rescuedFacts: [],
    };
  }

  const rescuedFacts = entries
    .map((entry) => {
      const factScore = scoreByFactId.get(entry.fact.id) ?? 0;
      if (factScore < lexicalScoreFloor) {
        return null;
      }

      const lexicalTexts = getEntryLexicalTexts(entry);
      let bestAnchorScore = 0;
      const matchedPhrases = new Set<string>();
      for (const anchorPhrase of anchorPhrases) {
        for (const lexicalText of lexicalTexts) {
          const matchScore = lexicalAnchorMatch(anchorPhrase.text, lexicalText);
          if (matchScore > 0) {
            bestAnchorScore = Math.max(bestAnchorScore, matchScore * Math.max(0.6, anchorPhrase.weight));
            matchedPhrases.add(anchorPhrase.text);
          }
        }
      }

      if (bestAnchorScore < 0.55) {
        return null;
      }

      return {
        factId: entry.fact.id,
        score: factScore,
        anchorScore: bestAnchorScore,
        matchedPhrases: Array.from(matchedPhrases),
      };
    })
    .filter((item): item is NonNullable<typeof item> => Boolean(item))
    .sort((a, b) => (b.anchorScore + b.score * 0.2) - (a.anchorScore + a.score * 0.2));

  return {
    anchorPhrases,
    lexicalScoreFloor,
    rescuedFacts,
  };
}

export function selectSeedFacts(
  scores: SeedFactScore[],
  selection: Required<CandidateSelectionOptions>,
): SeedFactScore[] {
  if (scores.length === 0) return [];

  if (selection.mode === 'threshold') {
    return scores.filter(score => score.score >= selection.threshold);
  }

  if (selection.mode === 'range') {
    const selected = scores.filter(score => score.score >= selection.threshold);
    if (selected.length >= selection.minCandidates) {
      return selected.slice(0, selection.maxCandidates);
    }

    const selectedIds = new Set(selected.map(score => score.factId));
    const toppedUp = [...selected];
    for (const score of scores) {
      if (selectedIds.has(score.factId)) continue;
      toppedUp.push(score);
      if (toppedUp.length >= selection.minCandidates) {
        break;
      }
    }
    return toppedUp.slice(0, selection.maxCandidates);
  }

  if (selection.mode === 'auto') {
    const analysis = analyzeAutoCandidateSelection(scores, selection);
    return scores.filter((score) => score.score >= analysis.chosenThreshold);
  }

  return scores.slice(0, selection.topK);
}

function formatChain(path: PathState, factById: Map<string, FactRecord>): string {
  const firstFact = factById.get(path.factIds[0] ?? '');
  if (!firstFact) return '';

  let out = firstFact.text;
  for (let i = 0; i < path.links.length; i++) {
    const link = path.links[i];
    if (!link) continue;
    const nextFact = factById.get(path.factIds[i + 1] ?? '');
    if (!nextFact) continue;
    out += ` ->${link.relation.toUpperCase()}-> ${nextFact.text}`;
  }
  return out;
}

export function searchGraphChains(
  queryGlobalEmbedding: number[],
  facts: FactRecord[],
  links: LinkRecord[],
  seeds: SeedFactScore[],
  config: GraphSearchConfig,
): GraphChainResult[] {
  if (facts.length === 0 || seeds.length === 0) return [];

  const factById = new Map(facts.map(fact => [fact.id, fact]));
  const outgoing = new Map<string, LinkRecord[]>();
  for (const link of links) {
    if (!factById.has(link.fromFactId) || !factById.has(link.toFactId)) continue;
    const bucket = outgoing.get(link.fromFactId) ?? [];
    bucket.push(link);
    outgoing.set(link.fromFactId, bucket);
  }

  let beam: PathState[] = seeds
    .filter(seed => factById.has(seed.factId))
    .map(seed => ({
      factIds: [seed.factId],
      links: [],
      score: seed.score,
    }));
  const completed: PathState[] = [];

  for (let depth = 0; depth < Math.max(1, config.maxDepth); depth++) {
    const nextBeam: PathState[] = [];

    for (const state of beam) {
      const currentId = state.factIds[state.factIds.length - 1];
      if (!currentId) continue;
      const candidateLinks = outgoing.get(currentId) ?? [];

      for (const link of candidateLinks) {
        if (state.factIds.includes(link.toFactId)) continue;
        const relationSim = clampSimilarity(dotSimilarity(queryGlobalEmbedding, link.relationEmbedding));
        const alignment = clampSimilarity(dotSimilarity(link.relationEmbedding, link.directionEmbedding));
        const stepScore = relationSim * 0.45 + alignment * 0.15 + Math.max(0, link.confidence) * 0.4;

        const next: PathState = {
          factIds: [...state.factIds, link.toFactId],
          links: [...state.links, link],
          score: state.score + stepScore,
        };

        nextBeam.push(next);
        completed.push(next);
      }
    }

    if (nextBeam.length === 0) break;
    nextBeam.sort((a, b) => b.score - a.score);
    beam = nextBeam.slice(0, Math.max(1, config.beamWidth));
  }

  const seenFactPaths = new Set<string>();
  const seenLines = new Set<string>();
  const usedFactIds = new Set<string>();
  const results: GraphChainResult[] = [];
  const candidates = completed.length > 0 ? completed.sort((a, b) => b.score - a.score) : beam;

  for (const path of candidates) {
    const line = path.links.length > 0
      ? formatChain(path, factById)
      : factById.get(path.factIds[0] ?? '')?.text ?? '';
    if (!line) continue;
    const factPathKey = path.factIds.join('>');
    if (seenFactPaths.has(factPathKey) || seenLines.has(line)) continue;
    if (path.factIds.some((factId) => usedFactIds.has(factId))) continue;
    seenFactPaths.add(factPathKey);
    seenLines.add(line);
    path.factIds.forEach((factId) => usedFactIds.add(factId));
    results.push({
      text: line,
      factIds: [...path.factIds],
    });
    if (results.length >= Math.max(1, config.maxChains)) {
      break;
    }
  }

  return results;
}
