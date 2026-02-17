import {
  MemoryService,
  type AddFactInput,
  type AddFactResult,
  type AddFactsInput,
  type AddFactsResult,
  type AddDocResult,
  type AddLinksInput,
  type AddLinksResult,
  type MemoryRuntimeConfig,
  type SearchOptions,
} from '../../src/memory_system/index.js';

let memoryService: MemoryService | null = null;
let configKey: string | null = null;

function parseNumber(name: string): number | undefined {
  const raw = process.env[name];
  if (!raw || !raw.trim()) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

function readConfigFromEnv(): Partial<MemoryRuntimeConfig> {
  return {
    table: process.env.MEMORY_TABLE,
    linkerProvider: process.env.MEMORY_LINKER_PROVIDER,
    linkerModel: process.env.MEMORY_LINKER_MODEL,
    linkerTemperature: parseNumber('MEMORY_LINKER_TEMPERATURE'),
    linkerMaxTokens: parseNumber('MEMORY_LINKER_MAX_TOKENS'),
    docParserProvider: process.env.MEMORY_DOC_PARSER_PROVIDER,
    docParserModel: process.env.MEMORY_DOC_PARSER_MODEL,
    docParserTemperature: parseNumber('MEMORY_DOC_PARSER_TEMPERATURE'),
    docParserMaxTokens: parseNumber('MEMORY_DOC_PARSER_MAX_TOKENS'),
    docCrossLinkMax: parseNumber('MEMORY_DOC_CROSSLINK_MAX'),
    docEnricherProvider: process.env.MEMORY_DOC_ENRICHER_PROVIDER,
    docEnricherModel: process.env.MEMORY_DOC_ENRICHER_MODEL,
    docEnricherTemperature: parseNumber('MEMORY_DOC_ENRICHER_TEMPERATURE'),
    docEnricherMaxTokens: parseNumber('MEMORY_DOC_ENRICHER_MAX_TOKENS'),
    docFactConfidenceFallback: parseNumber('MEMORY_DOC_FACT_CONFIDENCE_FALLBACK'),
    docTopicFallback: process.env.MEMORY_DOC_TOPIC_FALLBACK,
    embeddingModel: process.env.MEMORY_EMBEDDING_MODEL,
    candidateFactsPerTopic: parseNumber('MEMORY_CANDIDATE_FACTS_PER_TOPIC'),
    candidatePoolMax: parseNumber('MEMORY_CANDIDATE_POOL_MAX'),
    maxAutoLinksPerFact: parseNumber('MEMORY_MAX_AUTO_LINKS_PER_FACT'),
    dedupeThreshold: parseNumber('MEMORY_DEDUPE_THRESHOLD'),
    searchMaxDepth: parseNumber('MEMORY_SEARCH_MAX_DEPTH'),
    searchMaxStartFacts: parseNumber('MEMORY_SEARCH_MAX_START_FACTS'),
    searchMaxChains: parseNumber('MEMORY_SEARCH_MAX_CHAINS'),
  };
}

async function getService(): Promise<MemoryService> {
  const config = readConfigFromEnv();
  const nextKey = JSON.stringify(config);

  if (!memoryService || nextKey !== configKey) {
    memoryService = new MemoryService(config);
    await memoryService.initialize();
    configKey = nextKey;
  }

  return memoryService;
}

export async function addFact(input: AddFactInput): Promise<AddFactResult> {
  const service = await getService();
  return service.addFact(input);
}

export async function addFacts(input: AddFactsInput): Promise<AddFactsResult> {
  const service = await getService();
  return service.addFacts(input);
}

export async function addLinks(input: AddLinksInput): Promise<AddLinksResult> {
  const service = await getService();
  return service.addLinks(input);
}

export async function addDoc(path: string): Promise<AddDocResult> {
  const service = await getService();
  return service.addDoc(path);
}

export async function search(query: string, options?: SearchOptions): Promise<string> {
  const service = await getService();
  return service.search(query, options);
}
