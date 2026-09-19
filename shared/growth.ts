// Growth-vector contracts: where a cluster is heading, how fast, and what the naive
// predictors say about the same held-out fires. Draft for the H0-4 freeze.
//
// The baselines are part of the response on purpose. Measured leave-one-event-out on
// the Portuguese datasets, persistence and constant-ROS beat a learned model on burned
// area (R² 0.991 and 0.992 against 0.862), so the console must be able to print the
// baseline beside any model claim — and `shippedBaseline` says which one is on screen.

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
  /** Rate of frontal advance, km/h. Null when too sparse. */
  rateKmh: number | null;
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
  r2: number;
  medianMape: number;
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
  /** True when what is on screen is a baseline rather than a trained model. */
  shippedBaseline: boolean;
  /** Which vector is the shipped one, so the claim and the label cannot drift. */
  shipped: PredictorName;
}
