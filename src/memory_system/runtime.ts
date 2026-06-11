import type { AgentMemoryConfig } from '../types/index.js';
import { MemoryService } from './MemoryService.js';
import { MemoryQueueService } from './MemoryQueueService.js';
import type { MemoryRuntimeConfig } from './types.js';
import { MemoryNotesSyncService } from '../memory_notes/index.js';

interface MemoryRuntime {
  key: string;
  service: MemoryService;
  queue: MemoryQueueService;
  notesSync: MemoryNotesSyncService;
}

let runtime: MemoryRuntime | null = null;

function getQueueSpacingSeconds(config?: Partial<MemoryRuntimeConfig> | AgentMemoryConfig): number | undefined {
  return config && 'queue' in config ? config.queue?.spacingSeconds : undefined;
}

function getNotesSyncConfig(config?: Partial<MemoryRuntimeConfig> | AgentMemoryConfig) {
  return config && 'notesSync' in config ? config.notesSync : undefined;
}

function configToRuntimeConfig(config?: Partial<MemoryRuntimeConfig> | AgentMemoryConfig): Partial<MemoryRuntimeConfig> {
  if (!config) {
    return {};
  }

  return {
    table: config.table,
    mercuryProvider: config.mercuryProvider ?? config.linkerProvider,
    mercuryModel: config.mercuryModel ?? config.linkerModel,
    mercuryTemperature: config.mercuryTemperature ?? config.linkerTemperature,
    mercuryMaxTokens: config.mercuryMaxTokens ?? config.linkerMaxTokens,
    embeddingModel: config.embeddingModel,
    linkCandidatePoolMax: config.linkCandidatePoolMax ?? config.candidatePoolMax,
    maxAutoLinksPerFact: config.maxAutoLinksPerFact,
    semanticMergeThreshold: config.semanticMergeThreshold ?? config.dedupeThreshold,
    overallEmbeddingWeight: config.overallEmbeddingWeight,
    searchDefaultAggregationMode: config.searchDefaultAggregationMode,
    searchDefaultPhraseWeightingMode: config.searchDefaultPhraseWeightingMode,
    searchDefaultCandidateMode: config.searchDefaultCandidateMode,
    searchDefaultTopK: config.searchDefaultTopK,
    searchDefaultThreshold: config.searchDefaultThreshold,
    searchDefaultRangeMin: config.searchDefaultRangeMin,
    searchDefaultRangeMax: config.searchDefaultRangeMax,
    searchMaxDepth: config.searchMaxDepth,
    searchBeamWidth: config.searchBeamWidth,
    searchMaxChains: config.searchMaxChains,
  };
}

export async function getMemoryRuntime(config?: Partial<MemoryRuntimeConfig> | AgentMemoryConfig): Promise<MemoryRuntime> {
  const runtimeConfig = configToRuntimeConfig(config);
  const key = JSON.stringify({
    runtimeConfig,
    spacingSeconds: getQueueSpacingSeconds(config),
  });

  if (runtime && runtime.key === key) {
    return runtime;
  }

  const service = new MemoryService(runtimeConfig);
  await service.initialize();

  const queue = new MemoryQueueService(service, getQueueSpacingSeconds(config));
  await queue.initialize();
  const notesSync = new MemoryNotesSyncService(service, queue);
  const notesSyncConfig = getNotesSyncConfig(config);
  if (notesSyncConfig?.enabled !== false) {
    await notesSync.initialize(notesSyncConfig);
  }

  runtime = {
    key,
    service,
    queue,
    notesSync,
  };
  return runtime;
}

export async function ensureMemoryBackgroundRuntime(config?: Partial<MemoryRuntimeConfig> | AgentMemoryConfig): Promise<void> {
  await getMemoryRuntime(config);
}
