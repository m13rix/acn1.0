/**
 * Scoring Functions
 * 
 * Provides decay curve functions for weighting keyword importance.
 * The curve controls how quickly the weight drops for lower-ranked keywords.
 */

/**
 * Scoring parameters that control the decay curve
 */
export interface ScoringParams {
  /**
   * Base weight for the most important keyword (default: 1.0)
   */
  baseWeight: number;
  
  /**
   * Decay rate - higher values mean faster dropoff (default: 3.5)
   * Controls the steepness of the curve. Higher = steeper initial drop.
   * - 2.0: moderate decay
   * - 3.5: steep decay (default, matches parabola-like curve)
   * - 5.0+: very aggressive dropoff
   */
  decayPower: number;
  
  /**
   * Minimum weight floor - keywords below this are set to 0 (default: 0.01)
   * Lower values allow the curve to drop closer to zero
   */
  minWeight: number;
  
  /**
   * Percentage of top keywords that get full weight (default: 0.1 = 10%)
   * This scales with the total keyword count, so 0.1 means top 10% always get full weight
   */
  topPercentage: number;
  
  /**
   * Weight for query-to-entry similarity score (default: 0.5)
   * This controls how much the direct similarity between the full query and entry contributes
   * to the final score, separate from the keyword-based scoring
   */
  querySimilarityWeight: number;
}

export const DEFAULT_PARAMS: ScoringParams = {
  baseWeight: 1.0,
  decayPower: 3.5,
  minWeight: 0.01,
  topPercentage: 0.1, // Top 10% get full weight
  querySimilarityWeight: 0.5, // Weight for query-to-entry similarity
};

/**
 * Compute the weight for a keyword at a given rank
 * 
 * Uses percentage-based positioning to ensure the curve scales consistently
 * regardless of total keyword count. The weight is determined purely by the
 * keyword's position as a percentage through the list (0% = first, 100% = last).
 * 
 * Uses an inverted parabola-like decay: weight = base * (1 - progress)^power
 * This creates a curve that starts steep and flattens out (like half a parabola, branches down).
 * 
 * @param rank - 0-based rank (0 = most important)
 * @param totalKeywords - Total number of keywords
 * @param params - Scoring parameters
 */
export function computeWeight(
  rank: number,
  totalKeywords: number,
  params: Partial<ScoringParams> = {}
): number {
  const p = { ...DEFAULT_PARAMS, ...params };
  
  if (totalKeywords <= 0) return 0;
  if (rank < 0) return p.baseWeight;
  
  // Calculate position as percentage (0.0 = first keyword, 1.0 = last keyword)
  // This ensures the curve scales consistently regardless of total count
  const positionPercentage = totalKeywords > 1 
    ? rank / (totalKeywords - 1)  // Normalize to 0-1 range
    : 0; // Single keyword case
  
  // Top percentage of keywords get full weight
  if (positionPercentage <= p.topPercentage) {
    return p.baseWeight;
  }
  
  // For keywords beyond the top percentage, calculate decay based on remaining percentage
  // Map the position from [topPercentage, 1.0] to [0.0, 1.0] for the decay curve
  const adjustedPercentage = (positionPercentage - p.topPercentage) / (1.0 - p.topPercentage);
  
  // Inverted parabola-like decay: (1 - adjustedPercentage)^power
  // This creates a steep initial drop that flattens out (like half a parabola, branches down)
  // Higher power = steeper initial drop, faster approach to zero
  const decay = Math.pow(1 - adjustedPercentage, p.decayPower);
  const weight = p.baseWeight * decay;
  
  // Return 0 if below minimum threshold (allows curve to reach near-zero)
  return weight < p.minWeight ? 0 : weight;
}

/**
 * Generate weight distribution for all keywords
 */
export function computeWeights(
  totalKeywords: number,
  params: Partial<ScoringParams> = {}
): number[] {
  const weights: number[] = [];
  
  for (let i = 0; i < totalKeywords; i++) {
    weights.push(computeWeight(i, totalKeywords, params));
  }
  
  return weights;
}

/**
 * Alternative decay functions for experimentation
 */
export const decayFunctions = {
  /**
   * Exponential decay: weight = base * e^(-rate * rank)
   */
  exponential: (rank: number, total: number, rate: number = 0.5): number => {
    return Math.exp(-rate * rank);
  },
  
  /**
   * Logarithmic decay: weight = base / (1 + log(1 + rank))
   */
  logarithmic: (rank: number, total: number, base: number = 1): number => {
    return base / (1 + Math.log(1 + rank));
  },
  
  /**
   * Step function: top N get full weight, rest get min
   */
  step: (rank: number, total: number, topN: number = 3, min: number = 0.1): number => {
    return rank < topN ? 1.0 : min;
  },
  
  /**
   * Sigmoid decay: smooth S-curve transition
   */
  sigmoid: (rank: number, total: number, steepness: number = 0.5): number => {
    const midpoint = total / 2;
    return 1 / (1 + Math.exp(steepness * (rank - midpoint)));
  },
};
