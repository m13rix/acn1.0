import test from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateAdaptiveThresholds,
  isConfirmedKnownSpeaker,
  isUnknownSpeakerCandidate,
  listSpeakerEmbeddingCandidates,
} from '../src/interfaces/realtime-advisor/speaker-selection.js';
import type { SpeakerRecord } from '../src/interfaces/realtime-advisor/types.js';

function speaker(input: Partial<SpeakerRecord> & { id: string; name: string; usageCount: number }): SpeakerRecord {
  return {
    id: input.id,
    name: input.name,
    description: input.description,
    createdAt: '2026-06-03T00:00:00.000Z',
    updatedAt: '2026-06-03T00:00:00.000Z',
    samplePath: `sample-${input.id}.wav`,
    embeddingPath: Object.prototype.hasOwnProperty.call(input, 'embeddingPath') ? input.embeddingPath : `embedding-${input.id}.json`,
    embeddingModel: 'speechbrain/spkrec-ecapa-voxceleb',
    usageCount: input.usageCount,
    lastSeenAt: input.lastSeenAt,
    cooccurrence: input.cooccurrence ?? {},
  };
}

test('listSpeakerEmbeddingCandidates returns every pre-embedded speaker without priority limiting', () => {
  const candidates = listSpeakerEmbeddingCandidates([
    speaker({ id: 'spk_a', name: 'A', usageCount: 20 }),
    speaker({ id: 'spk_b', name: 'B', usageCount: 1, cooccurrence: { spk_seen: 50 } }),
    speaker({ id: 'spk_c', name: 'C', usageCount: 100, embeddingPath: undefined }),
  ]);

  assert.equal(candidates.length, 2);
  assert.deepEqual(candidates.map((candidate) => candidate.speakerId), ['spk_a', 'spk_b']);
});

test('calculateAdaptiveThresholds uses ECAPA-safe fixed thresholds', () => {
  const thresholds = calculateAdaptiveThresholds({
    knownScores: [0.32, 0.36, 0.41, 0.44],
    knownMargins: [0.06, 0.08, 0.11, 0.14],
    unknownTopScores: [0.12, 0.17, 0.20, 0.22],
    unknownMargins: [0.01, 0.02, 0.03, 0.05],
  });

  assert.deepEqual(thresholds, {
    confirmedScore: 0.25,
    confirmedMargin: 0.05,
    cleanSpeechSeconds: 2,
    agreeingSegments: 2,
    unknownScoreCeiling: 0.22,
    unknownMargin: 0.03,
  });
});

test('strong-margin short clips can still confirm known speakers', () => {
  const thresholds = calculateAdaptiveThresholds({
    knownScores: [0.32, 0.4],
    knownMargins: [0.06, 0.08],
    unknownTopScores: [0.08, 0.09, 0.2, 0.22],
    unknownMargins: [0, 0, 0.08, 0.10],
  });

  assert.equal(isConfirmedKnownSpeaker({
    topLabel: 'spk_13',
    topScore: 0.29,
    secondScore: 0.12,
    margin: 0.17,
    cleanSpeechSeconds: 1.1,
    agreeingSegments: 1,
  }, thresholds), true);
});

test('unresolved stable speaker tracks are buffered instead of dropped', () => {
  const thresholds = calculateAdaptiveThresholds({
    knownScores: [0.32, 0.4],
    knownMargins: [0.18, 0.22],
    unknownTopScores: [0.08, 0.09, 0.2, 0.22],
    unknownMargins: [0, 0, 0.08, 0.10],
  });

  assert.equal(isUnknownSpeakerCandidate({
    topLabel: 'spk_possible',
    topScore: 0.22,
    secondScore: 0.12,
    margin: 0.10,
    cleanSpeechSeconds: 3.5,
    agreeingSegments: 1,
  }, thresholds), true);
});

test('known-like speakers above the unknown ceiling are not treated as new voices', () => {
  const thresholds = calculateAdaptiveThresholds({
    knownScores: [82, 90],
    knownMargins: [18, 22],
    unknownTopScores: [0.08, 0.09],
    unknownMargins: [0.01, 0.02],
  });

  assert.equal(isConfirmedKnownSpeaker({
    topLabel: 'spk_possible',
    topScore: 0.24,
    secondScore: 0.10,
    margin: 0.08,
    cleanSpeechSeconds: 1.1,
    agreeingSegments: 1,
  }, thresholds), false);

  assert.equal(isUnknownSpeakerCandidate({
    topLabel: 'spk_possible',
    topScore: 0.24,
    secondScore: 0.10,
    margin: 0.08,
    cleanSpeechSeconds: 1.1,
    agreeingSegments: 1,
  }, thresholds), false);
});
