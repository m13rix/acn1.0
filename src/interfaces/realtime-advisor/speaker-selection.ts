import type {
  AdaptiveScoreStats,
  AdaptiveThresholds,
  SpeakerConfidenceSummary,
  SpeakerRecord,
  SpeakerEmbeddingCandidate,
} from './types.js';

const FALLBACK_THRESHOLDS: AdaptiveThresholds = {
  confirmedScore: 0.25,
  confirmedMargin: 0.05,
  cleanSpeechSeconds: 2,
  agreeingSegments: 2,
  unknownScoreCeiling: 0.22,
  unknownMargin: 0.03,
};

export function calculateAdaptiveThresholds(stats: AdaptiveScoreStats): AdaptiveThresholds {
  void stats;
  return {
    confirmedScore: FALLBACK_THRESHOLDS.confirmedScore,
    confirmedMargin: FALLBACK_THRESHOLDS.confirmedMargin,
    cleanSpeechSeconds: FALLBACK_THRESHOLDS.cleanSpeechSeconds,
    agreeingSegments: FALLBACK_THRESHOLDS.agreeingSegments,
    unknownScoreCeiling: FALLBACK_THRESHOLDS.unknownScoreCeiling,
    unknownMargin: FALLBACK_THRESHOLDS.unknownMargin,
  };
}

export function listSpeakerEmbeddingCandidates(speakers: SpeakerRecord[]): SpeakerEmbeddingCandidate[] {
  return speakers
    .filter((speaker) => typeof speaker.embeddingPath === 'string' && speaker.embeddingPath.trim())
    .map((speaker) => ({
      speakerId: speaker.id,
      label: speaker.id,
      embeddingPath: speaker.embeddingPath!,
      embedding: [],
    }));
}

export function isConfirmedKnownSpeaker(
  summary: SpeakerConfidenceSummary,
  thresholds: AdaptiveThresholds,
): boolean {
  const topScore = summary.topScore ?? 0;
  const margin = summary.margin ?? 0;
  const cleanSpeechSeconds = summary.cleanSpeechSeconds ?? 0;
  const agreeingSegments = summary.agreeingSegments ?? 0;
  if (!summary.topLabel || margin < thresholds.confirmedMargin) {
    return false;
  }

  const enoughNormalEvidence = topScore >= thresholds.confirmedScore
    && cleanSpeechSeconds >= thresholds.cleanSpeechSeconds
    && agreeingSegments >= thresholds.agreeingSegments;
  const veryStrongShortEvidence = topScore >= thresholds.confirmedScore - 0.04
    && margin >= thresholds.confirmedMargin * 2
    && cleanSpeechSeconds >= 0.7
    && agreeingSegments >= 1;

  return enoughNormalEvidence || veryStrongShortEvidence;
}

export function isUnknownSpeakerCandidate(
  summary: SpeakerConfidenceSummary,
  thresholds: AdaptiveThresholds,
): boolean {
  const topScore = summary.topScore ?? 0;
  const cleanSpeechSeconds = summary.cleanSpeechSeconds ?? 0;
  if (cleanSpeechSeconds < 0.7) {
    return false;
  }

  const noUsableMatch = !summary.topLabel || topScore <= 0;
  const clearlyBelowKnown = topScore <= thresholds.unknownScoreCeiling;

  return noUsableMatch || clearlyBelowKnown;
}
