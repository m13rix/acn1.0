import assert from 'node:assert/strict';
import test from 'node:test';

import { MemoryService } from '../src/memory_system/MemoryService.js';
import type { FactRecord } from '../src/memory_system/types.js';

function fact(id: string, embedding: number[]): FactRecord {
  return {
    id,
    text: id,
    language: 'en',
    parserMode: 'ud',
    globalEmbedding: embedding,
    constituency: null,
    dependencies: [],
    phrases: { np: [], vp: [], adjp: [] },
    exclusiveToAgentName: null,
    sourceId: null,
    sourceLabel: null,
    createdAt: 0,
    updatedAt: 0,
  };
}

test('cross-document link candidates use a deduplicated top seven for each new fact', () => {
  const service = new MemoryService({ linkCandidatePoolMax: 7 });
  const newFacts = [fact('new-a', [1, 0]), fact('new-b', [0, 1])];
  const existingFacts = [
    fact('new-a', [1, 0]),
    fact('shared', [0.9, 0.9]),
    ...Array.from({ length: 6 }, (_, index) => fact(`a-${index + 1}`, [1, 0.1])),
    ...Array.from({ length: 6 }, (_, index) => fact(`b-${index + 1}`, [0.1, 1])),
  ];
  (service as unknown as { facts: FactRecord[] }).facts = existingFacts;

  const candidates = (service as unknown as {
    collectLinkCandidateFacts: (facts: FactRecord[], category: string | null) => FactRecord[];
  }).collectLinkCandidateFacts(newFacts, null);
  const candidateIds = candidates.map((item) => item.id);

  assert.equal(candidateIds.length, 13);
  assert.equal(new Set(candidateIds).size, candidateIds.length);
  assert.equal(candidateIds.includes('new-a'), false);
  assert.equal(candidateIds.filter((id) => id === 'shared').length, 1);
  assert.deepEqual(new Set(candidateIds), new Set([
    'shared',
    ...Array.from({ length: 6 }, (_, index) => `a-${index + 1}`),
    ...Array.from({ length: 6 }, (_, index) => `b-${index + 1}`),
  ]));
});
