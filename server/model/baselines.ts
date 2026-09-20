// The two naive predictors, as growth vectors.
//
// They are not a fallback for a missing model. They are the answer until a model
// beats them on held-out fires, and the console prints their score beside any
// model claim so the reader can see which one is actually winning.

import type { GrowthVector } from '../../shared/growth';

/** Persistence: the cluster keeps the bearing and rate it was last seen with. */
export function persistence(observed: GrowthVector): GrowthVector {
  return { ...observed, predictor: 'persistence' };
}

/**
 * Constant rate of spread: the observed bearing, with one fixed rate for every
 * fire. `meanRateKmh` comes from the corpus, so it travels with the scores
 * instead of being recomputed here.
 */
export function constantRos(
  observed: GrowthVector,
  meanRateKmh: number | null,
): GrowthVector {
  return { ...observed, predictor: 'constant_ros', rateKmh: meanRateKmh, rateBasis: 'frontal_corpus_mean' };
}

/**
 * The baselines for a cluster, in a stable order: persistence first.
 * An uncomputable bearing stays null rather than becoming zero — no direction is
 * not the same as due north.
 */
export function baselinesFor(
  observed: GrowthVector,
  meanRateKmh: number | null,
): GrowthVector[] {
  return [persistence(observed), constantRos(observed, meanRateKmh)];
}
