// The held-out scores produced by tools/model/harness.py, loaded at serve time so
// every growth claim travels with the number behind it.
//
// The file is small and committed; the corpora it was computed from stay on the
// data box (see docs/stream3-baselines.md).

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { GrowthScore, PredictorName } from '../../shared/growth';

const HERE = dirname(fileURLToPath(import.meta.url));
const METRICS_PATH = join(HERE, '../../data/model/metrics.json');

interface HarnessRow {
  corpus: string;
  fires: number;
  /**
   * How the corpus's rate was measured. Only 'frontal' is a rate of advance; a
   * centroid drift over a growing polygon is not, and must never become the
   * served constant.
   */
  rate_basis: 'frontal' | 'centroid_drift';
  /** False for the all-pairs row, which exists to document the outlier effect. */
  primary: boolean;
  mean_rate_kmh: number | null;
  burned_area: Record<
    string,
    { r2: number; median_r2_per_fire: number | null; median_mape: number }
  >;
  bearing_rate: {
    persistence: { rate_r2: number; rate_median_mape: number };
  };
  model?: {
    computed: boolean;
    rate?: Record<string, { r2: number; median_mape: number }>;
  };
}

function rows(): HarnessRow[] {
  try {
    return JSON.parse(readFileSync(METRICS_PATH, 'utf8')) as HarnessRow[];
  } catch {
    // No metrics is a supported state: the route then serves the baselines with
    // no scores rather than inventing them.
    return [];
  }
}

/** One score per predictor per target per corpus, in a stable order. */
export function loadScores(): GrowthScore[] {
  const out: GrowthScore[] = [];
  // One served reading per corpus: the all-pairs row would collide with the
  // gap-filtered one on (name, target, corpus) and carry a different number.
  for (const row of rows().filter((r) => r.primary)) {
    const events = row.fires;
    for (const name of ['persistence', 'constant_ros'] as const) {
      const area = row.burned_area?.[name];
      if (area) {
        out.push({
          name,
          target: 'burned_area',
          corpus: row.corpus,
          r2: area.r2,
          medianR2PerFire: area.median_r2_per_fire,
          medianMape: area.median_mape,
          events,
        });
      }
    }
    const dir = row.bearing_rate?.persistence;
    if (dir) {
      out.push({
        name: 'persistence',
        target: 'bearing_rate',
        corpus: row.corpus,
        r2: dir.rate_r2,
        medianR2PerFire: null,
        medianMape: dir.rate_median_mape,
        events,
      });
    }
    const modelRate = row.model?.computed ? row.model.rate?.model : undefined;
    if (modelRate) {
      out.push({
        name: 'model',
        target: 'bearing_rate',
        corpus: row.corpus,
        r2: modelRate.r2,
        medianR2PerFire: null,
        medianMape: modelRate.median_mape,
        events,
      });
    }
  }
  return out;
}

/**
 * The corpus mean rate to hold constant, or null when no corpus carries a real
 * rate of frontal advance. MedEU is excluded by design: its centroid drift is
 * not a rate, and serving it would print hundreds of km/h.
 */
export function meanRateKmh(): number | null {
  const frontal = rows().filter(
    (r) => r.primary && r.rate_basis === 'frontal' && r.mean_rate_kmh !== null,
  );
  if (frontal.length === 0) return null;
  return frontal[0].mean_rate_kmh;
}

/**
 * The predictor that ships. A model ships only when it beats the baseline on the
 * target that matters; until then the baseline is the answer.
 */
export function shippedPredictor(scores: GrowthScore[]): PredictorName {
  const area = scores.filter((s) => s.target === 'burned_area');
  const best = area.reduce<GrowthScore | null>(
    (acc, s) => (acc === null || s.r2 > acc.r2 ? s : acc),
    null,
  );
  return best?.name ?? 'persistence';
}
