import { cosineSimilarity } from './embeddings.js';
import type { FactRecord, LinkRecord } from './types.js';

export interface GraphSearchConfig {
  maxDepth: number;
  maxStartFacts: number;
  maxChains: number;
  beamWidth: number;
}

interface PathState {
  factIds: string[];
  links: LinkRecord[];
  score: number;
}

function formatChain(path: PathState, factById: Map<string, FactRecord>): string {
  const firstFact = factById.get(path.factIds[0] ?? '');
  if (!firstFact) return '';

  let out = firstFact.text;
  for (let i = 0; i < path.links.length; i++) {
    const link = path.links[i];
    if (!link) continue;
    const nextFactId = path.factIds[i + 1];
    const nextFact = factById.get(nextFactId ?? '');
    if (!nextFact) continue;

    const relation = link.relation.trim().toUpperCase();
    out += ` ->${relation}-> ${nextFact.text}`;
  }
  return out;
}

export function searchGraphChains(
  queryVector: number[],
  facts: FactRecord[],
  links: LinkRecord[],
  config: GraphSearchConfig
): string[] {
  if (facts.length === 0) return [];

  const factById = new Map<string, FactRecord>();
  for (const fact of facts) {
    factById.set(fact.id, fact);
  }

  const outgoing = new Map<string, LinkRecord[]>();
  for (const link of links) {
    if (!factById.has(link.fromFactId) || !factById.has(link.toFactId)) continue;
    const bucket = outgoing.get(link.fromFactId) ?? [];
    bucket.push(link);
    outgoing.set(link.fromFactId, bucket);
  }

  const startStates = facts
    .map(fact => {
      const semantic = cosineSimilarity(queryVector, fact.embedding);
      const score = semantic * 0.75 + fact.confidence * 0.25;
      return { fact, score };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(1, config.maxStartFacts))
    .map(item => ({
      factIds: [item.fact.id],
      links: [] as LinkRecord[],
      score: item.score,
    }));

  let beam: PathState[] = startStates;
  const completed: PathState[] = [];

  for (let depth = 0; depth < Math.max(1, config.maxDepth); depth++) {
    const nextBeam: PathState[] = [];

    for (const state of beam) {
      const currentId = state.factIds[state.factIds.length - 1];
      if (!currentId) continue;
      const candidateLinks = outgoing.get(currentId) ?? [];

      for (const link of candidateLinks) {
        if (state.factIds.includes(link.toFactId)) continue;
        const toFact = factById.get(link.toFactId);
        if (!toFact) continue;

        const relationSim = cosineSimilarity(queryVector, link.relationEmbedding);
        const alignment = cosineSimilarity(link.relationEmbedding, link.directionEmbedding);
        const stepScore =
          relationSim * 0.45 +
          alignment * 0.15 +
          link.confidence * 0.2 +
          toFact.confidence * 0.2;

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

  const lines: string[] = [];
  if (completed.length > 0) {
    completed.sort((a, b) => b.score - a.score);
    for (const path of completed) {
      const line = formatChain(path, factById);
      if (!line) continue;
      if (!lines.includes(line)) {
        lines.push(line);
      }
      if (lines.length >= Math.max(1, config.maxChains)) break;
    }
  }

  if (lines.length > 0) return lines;

  for (const start of startStates.slice(0, Math.max(1, config.maxChains))) {
    const factId = start.factIds[0];
    const fact = factById.get(factId ?? '');
    if (fact) lines.push(fact.text);
  }

  return lines;
}

