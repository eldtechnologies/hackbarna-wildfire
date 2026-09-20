// Growth response assembly: for one cluster, the observed advance, the naive
// predictors' answers for the same cluster, and the held-out scores behind both.
//
// No learned vector is served yet. The offline benchmark has worse bearing errors
// for its learned model; scoreScope makes clear that it does not validate the live
// centroid estimator. See docs/stream3-baselines.md.

import type { FiresResponse, Hotspot } from '../../shared/fires';
import type { GrowthResponse } from '../../shared/growth';
import { baselinesFor } from './baselines';
import { observedGrowth } from './growth';
import { loadMetrics, shippedPredictor, type Metrics } from './metrics';

/** Detections that belong to a cluster. */
export function detectionsOf(response: FiresResponse, clusterId: string): Hotspot[] {
  const cluster = response.clusters.find((c) => c.id === clusterId);
  if (!cluster) return [];
  const byCluster = response.hotspots.filter((h) => h.clusterId === clusterId);
  if (byCluster.length > 0) return byCluster;
  // A provider may send a cluster without tagging its detections. Fall back to the
  // explicit id list rather than returning nothing.
  const ids = new Set(cluster.hotspotIds ?? []);
  return response.hotspots.filter((h) => ids.has(h.id));
}

/** Null when the cluster is not in the response, so the route can say 404. */
export function growthFor(
  clusterId: string,
  response: FiresResponse,
  now: Date = new Date(),
  loadMetricsFn: () => Metrics = loadMetrics,
): GrowthResponse | null {
  if (!response.clusters.some((c) => c.id === clusterId)) return null;
  const metrics = loadMetricsFn();
  const detections = detectionsOf(response, clusterId);
  const observed = observedGrowth(clusterId, detections, now);
  const shipped = shippedPredictor(metrics.scores);
  return {
    clusterId,
    at: now.toISOString(),
    model: null,
    baselines: baselinesFor(observed, metrics.meanRateKmh),
    scores: metrics.scores,
    scoreScope: 'offline_corpus_baselines',
    shippedBaseline: shipped !== 'model',
    shipped,
  };
}
