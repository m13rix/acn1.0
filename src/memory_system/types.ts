export interface ManualLinkEndpointInput {
  id?: string;
  ref?: string;
}

export interface ManualLinkInput {
  from: ManualLinkEndpointInput;
  to: ManualLinkEndpointInput;
  relation: string;
  confidence?: number;
}

export interface FactDraftInput {
  ref?: string;
  text: string;
  confidence: number;
  topics: string[];
}

export interface AddFactInput {
  fact: string;
  confidence: number;
  topics: string[];
  ref?: string;
}

export interface AddFactsInput {
  facts: FactDraftInput[];
}

export interface AddLinksInput {
  links: ManualLinkInput[];
  refMap?: Record<string, string>;
}

export interface AddLinksResult {
  created: number;
  skipped: number;
  total: number;
}

export interface AddedFactInfo {
  factId: string;
  ref?: string;
  text: string;
}

export interface AddFactsResult {
  facts: AddedFactInfo[];
  refMap: Record<string, string>;
  autoLinks: number;
  softMergeLinks: number;
  totalLinks: number;
}

export interface AddFactResult extends AddFactsResult {
  factId: string;
  ref?: string;
}

export interface SearchOptions {
  maxDepth?: number;
  maxStartFacts?: number;
  maxChains?: number;
  beamWidth?: number;
}

export interface MemoryRuntimeConfig {
  table: string;
  linkerProvider: string;
  linkerModel: string;
  linkerTemperature: number;
  linkerMaxTokens: number;
  embeddingModel: string;
  candidateFactsPerTopic: number;
  candidatePoolMax: number;
  maxAutoLinksPerFact: number;
  dedupeThreshold: number;
  searchMaxDepth: number;
  searchMaxStartFacts: number;
  searchMaxChains: number;
}

export const DEFAULT_MEMORY_CONFIG: MemoryRuntimeConfig = {
  table: 'global_memory',
  linkerProvider: 'ollama',
  linkerModel: 'gpt-oss:20b',
  linkerTemperature: 0.1,
  linkerMaxTokens: 900,
  embeddingModel: 'bge-m3',
  candidateFactsPerTopic: 15,
  candidatePoolMax: 40,
  maxAutoLinksPerFact: 4,
  dedupeThreshold: 0.92,
  searchMaxDepth: 2,
  searchMaxStartFacts: 5,
  searchMaxChains: 5,
};

export interface FactRecord {
  id: string;
  text: string;
  confidence: number;
  embedding: number[];
  topics: string[];
  topicEmbeddings: number[][];
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
  isManual: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface LinkSuggestion {
  fromFactId: string;
  toFactId: string;
  relation: string;
  confidence?: number;
}

export interface LinkerInput {
  newFacts: Array<{
    id: string;
    text: string;
    confidence: number;
    topics: string[];
  }>;
  candidateFacts: Array<{
    id: string;
    text: string;
    confidence: number;
    topics: string[];
  }>;
  manualLinks: Array<{
    fromFactId: string;
    toFactId: string;
    relation: string;
  }>;
  maxAutoLinksPerFact: number;
}
