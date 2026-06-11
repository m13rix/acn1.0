import type { PhraseType, ParserMode, WeightedQueryPhrase } from './phrases.js';
import type { StanzaDependencyWord } from './stanzaRuntime.js';

export interface IngestTextInput {
  text: string;
  retrievalHints?: string[];
  exclusiveToAgentName?: string;
  sourceId?: string | null;
  sourceLabel?: string | null;
}

export interface IngestTextResult {
  factIds: string[];
  factCount: number;
  hintCount: number;
  linkCount: number;
  warnings?: string[];
}

export type PhraseAggregationMode = 'max' | 'sum';
export type CandidateSelectionMode = 'top-k' | 'threshold' | 'range' | 'auto';
export type QueryPhraseWeightingMode = 'llm' | 'embedding';

export interface CandidateSelectionOptions {
  mode?: CandidateSelectionMode;
  topK?: number;
  threshold?: number;
  minCandidates?: number;
  maxCandidates?: number;
}

export interface SearchOptions {
  maxDepth?: number;
  maxChains?: number;
  beamWidth?: number;
  phraseAggregationMode?: PhraseAggregationMode;
  candidateSelection?: CandidateSelectionOptions;
  overallEmbeddingWeight?: number;
  agentName?: string;
  categories?: string[];
  includeUncategorized?: boolean;
  fallbackCategory?: string;
  categoryMultipliers?: Record<string, number>;
  excludeFactIds?: string[];
  queryPhraseWeightingMode?: QueryPhraseWeightingMode;
}

export interface SeedFactScore {
  factId: string;
  score: number;
}

export interface SearchResult {
  text: string;
  chains: string[];
  seedFacts: SeedFactScore[];
  surfacedFactIds: string[];
  queryPhrases: WeightedQueryPhrase[];
  phraseAggregationMode: PhraseAggregationMode;
  candidateSelection: Required<CandidateSelectionOptions>;
  overallEmbeddingWeight: number;
}

export interface EmbeddedPhraseRecord {
  text: string;
  embedding: number[];
}

export interface PhraseRecordSet {
  np: EmbeddedPhraseRecord[];
  vp: EmbeddedPhraseRecord[];
  adjp: EmbeddedPhraseRecord[];
}

export interface FactRecord {
  id: string;
  text: string;
  language: 'en' | 'ru';
  parserMode: ParserMode;
  globalEmbedding: number[];
  constituency: string | null;
  dependencies: StanzaDependencyWord[];
  phrases: PhraseRecordSet;
  exclusiveToAgentName: string | null;
  sourceId?: string | null;
  sourceLabel?: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface RetrievalHintRecord {
  id: string;
  factId: string;
  text: string;
  language: 'en' | 'ru';
  parserMode: ParserMode;
  globalEmbedding: number[];
  constituency: string | null;
  dependencies: StanzaDependencyWord[];
  phrases: PhraseRecordSet;
  exclusiveToAgentName: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface LinkRecord {
  id: string;
  fromFactId: string;
  toFactId: string;
  relation: string;
  confidence: number;
  relationEmbedding: number[];
  directionEmbedding: number[];
  exclusiveToAgentName: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface MemoryLinkSuggestion {
  fromFactId: string;
  toFactId: string;
  relation: string;
  confidence?: number;
}

export interface LinkGenerationInput {
  newFacts: Array<{
    id: string;
    text: string;
  }>;
  candidateFacts: Array<{
    id: string;
    text: string;
  }>;
  maxAutoLinksPerFact: number;
}

export interface QueryPhraseCandidate {
  type: PhraseType;
  text: string;
}

export interface MemoryRuntimeConfig {
  table: string;
  mercuryProvider: string;
  mercuryModel: string;
  mercuryTemperature: number;
  mercuryMaxTokens: number;
  embeddingModel: string;
  linkCandidatePoolMax: number;
  maxAutoLinksPerFact: number;
  semanticMergeThreshold: number;
  overallEmbeddingWeight: number;
  searchDefaultAggregationMode: PhraseAggregationMode;
  searchDefaultPhraseWeightingMode: QueryPhraseWeightingMode;
  searchDefaultCandidateMode: CandidateSelectionMode;
  searchDefaultTopK: number;
  searchDefaultThreshold: number;
  searchDefaultRangeMin: number;
  searchDefaultRangeMax: number;
  searchMaxDepth: number;
  searchBeamWidth: number;
  searchMaxChains: number;

  // Deprecated legacy fields kept optional so older repo files still type-check
  linkerProvider?: string;
  linkerModel?: string;
  linkerTemperature?: number;
  linkerMaxTokens?: number;
  docParserProvider?: string;
  docParserModel?: string;
  docParserTemperature?: number;
  docParserMaxTokens?: number;
  docCrossLinkMax?: number;
  docEnricherProvider?: string;
  docEnricherModel?: string;
  docEnricherTemperature?: number;
  docEnricherMaxTokens?: number;
  docFactConfidenceFallback?: number;
  docTopicFallback?: string;
  candidateFactsPerTopic?: number;
  candidatePoolMax?: number;
  dedupeThreshold?: number;
  searchMaxStartFacts?: number;
}

export const DEFAULT_MEMORY_CONFIG: MemoryRuntimeConfig = {
  table: 'global_memory_v2',
  mercuryProvider: 'inception',
  mercuryModel: 'mercury-2',
  mercuryTemperature: 0,
  mercuryMaxTokens: 4000,
  embeddingModel: 'qwen3-embedding:8b',
  linkCandidatePoolMax: 40,
  maxAutoLinksPerFact: 4,
  semanticMergeThreshold: 0.92,
  overallEmbeddingWeight: 0.35,
  searchDefaultAggregationMode: 'max',
  searchDefaultPhraseWeightingMode: 'llm',
  searchDefaultCandidateMode: 'top-k',
  searchDefaultTopK: 5,
  searchDefaultThreshold: 0.35,
  searchDefaultRangeMin: 3,
  searchDefaultRangeMax: 8,
  searchMaxDepth: 2,
  searchBeamWidth: 10,
  searchMaxChains: 5,
};
