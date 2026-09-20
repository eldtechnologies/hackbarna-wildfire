// Growth-vector contracts: where a cluster is heading, how fast, and what the naive
// predictors say about the same held-out fires. Draft for the H0-4 freeze.
//
// Offline corpus scores accompany the vectors as context. They are not a validation
// of the online detection-centroid estimator or a route-safety guarantee.

/** Which predictor produced this vector. */
export type PredictorName = 'observed' | 'persistence' | 'constant_ros' | 'model';

/** A cluster's advance, or a naive predictor's answer for the same cluster. */
export interface GrowthVector {
  clusterId: string;
  at: string;
  /**
   * Names the vector. Without it `baselines` is an unlabelled array and a client
   * cannot print which one is on screen, which is the whole point of shipping the
   * baseline beside the model.
   */
  predictor: PredictorName;
  /** Bearing of movement, degrees clockwise from north. Null when too sparse. */
  bearingDeg: number | null;
  /** Motion estimate in km/h; interpretation is specified by rateBasis. */
  rateKmh: number | null;
  rateBasis: 'detection_centroid_drift' | 'frontal_corpus_mean';
  /** Evidence the estimate rests on, so a thin estimate is visibly thin. */
  detections: number;
  /** Detections by source, e.g. { 'MTG-I1': 40, 'VIIRS': 3 }. */
  sourceMix: Record<string, number>;
  /** Hours since the last detection for this cluster; null when none is dated. */
  hoursSinceLastDetection: number | null;
}

/** A predictor's score on held-out events. Both targets are reported. */
export interface GrowthScore {
  name: 'persistence' | 'constant_ros' | 'model';
  target: 'bearing_rate' | 'burned_area';
  /**
   * Corpus the number was measured on. Two corpora with cadences an order of
   * magnitude apart do not give the same answer, so a score without its corpus is
   * the caveat-free number this contract exists to prevent.
   */
  corpus: string;
  /** Pooled across every held-out pair. Variance-weighted, so the largest fires
   *  dominate it and it flatters any predictor that carries the last value forward. */
  r2: number;
  /**
   * Median R2 over held-out fires - how the typical fire does. Much lower than `r2`
   * and negative where a growth series makes carrying the last value worse than the
   * fire's own mean. Null when the target has no per-fire reading.
   */
  medianR2PerFire: number | null;
  medianMape: number;
  /**
   * Median absolute bearing error, degrees. Only the direction target carries it;
   * null on the area target. This is the number the model slot is judged on, so it
   * travels with the null model slot instead of living only in the file.
   */
  medianBearingErrorDeg: number | null;
  /** Number of held-out events, not rows. */
  events: number;
}

export interface GrowthResponse {
  clusterId: string;
  at: string;
  /** The model's estimate, or null when it did not beat the baselines. */
  model: GrowthVector | null;
  /** Always present, whichever predictor is shipped. */
  baselines: GrowthVector[];
  /** Held-out scores per predictor per target, so the number travels with the claim. */
  scores: GrowthScore[];
  /** These scores assess corpus predictors, not this live centroid estimator. */
  scoreScope: 'offline_corpus_baselines';
  /** True when what is on screen is a baseline rather than a trained model. */
  shippedBaseline: boolean;
  /** Which vector is the shipped one, so the claim and the label cannot drift. */
  shipped: PredictorName;
}
