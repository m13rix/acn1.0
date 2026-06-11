import { generateMemoryLinks, generateProceduralMemoryLinks } from './mercury.js';
import type { MemoryDebugLogger } from './debug.js';
import type { LinkGenerationInput, MemoryLinkSuggestion, MemoryRuntimeConfig } from './types.js';

export async function generateAutoLinks(
  input: LinkGenerationInput,
  config: MemoryRuntimeConfig,
  debug?: MemoryDebugLogger,
): Promise<MemoryLinkSuggestion[]> {
  return generateMemoryLinks(input, config, debug);
}

export async function generateProceduralLinks(
  input: Pick<LinkGenerationInput, 'newFacts' | 'maxAutoLinksPerFact'>,
  config: MemoryRuntimeConfig,
  debug?: MemoryDebugLogger,
): Promise<MemoryLinkSuggestion[]> {
  return generateProceduralMemoryLinks(input, config, debug);
}
