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
    { r2: number; median_r2_per_fire: number | null; median_mape: number } | { computed: false; reason: string }
  >;
  bearing_rate: {
    rate_fires: number;
    direction_fires: number;
    persistence: {
      median_bearing_error_deg: number | null;
      rate_r2: number;
      rate_median_mape: number;
    };
  };
  model?: {
    computed: boolean;
    fires?: number;
    bearing?: { persistence_median_error_deg: number; model_median_error_deg: number };
    rate?: Record<string, { r2: number; median_mape: number }>;
  };
}

/** The held-out scores and the constant rate to serve, loaded from one file. */
export interface Metrics {
  scores: GrowthScore[];
  /** Corpus mean rate of frontal advance to hold constant; null when none qualifies. */
  meanRateKmh: number | null;
}

const isNum = (v: unknown): boolean => typeof v === 'number' && Number.isFinite(v);
const isNumOrNull = (v: unknown): boolean => v === null || isNum(v);
const isArea = (v: any): boolean =>
  v != null && isNum(v.r2) && isNumOrNull(v.median_r2_per_fire) && isNum(v.median_mape);
const notComputed = (v: any): boolean => v?.computed === false && typeof v.reason === 'string';
const isBearing = (v: any): boolean =>
  v != null && isNumOrNull(v.median_bearing_error_deg) && isNum(v.rate_r2) && isNum(v.rate_median_mape);
const isModel = (v: any): boolean =>
  v == null ||
  notComputed(v) ||
  (v.computed === true &&
    isNum(v.fires) &&
    (v.bearing == null ||
      (isNum(v.bearing.persistence_median_error_deg) && isNum(v.bearing.model_median_error_deg))) &&
    (v.rate == null || (isNum(v.rate.model?.r2) && isNum(v.rate.model?.median_mape))));

/**
 * Shape check for the committed artifact. A missing or mistyped leaf is corruption,
 * not an empty result: without this a row missing `r2` would be served as a score
 * with `r2: undefined`. It fails loudly so the route reports 502 rather than putting
 * a caveat-free number on screen.
 */
function isHarnessRow(r: any): boolean {
  return (
    r != null &&
    typeof r.corpus === 'string' &&
    isNum(r.fires) &&
    (r.rate_basis === 'frontal' || r.rate_basis === 'centroid_drift') &&
    typeof r.primary === 'boolean' &&
    isNumOrNull(r.mean_rate_kmh) &&
    isArea(r.burned_area?.persistence) &&
    (isArea(r.burned_area?.constant_ros) || notComputed(r.burned_area?.constant_ros)) &&
    isNum(r.bearing_rate?.rate_fires) && isNum(r.bearing_rate?.direction_fires) &&
    isBearing(r.bearing_rate?.persistence) &&
    isModel(r.model)
  );
}

/**
 * The committed harness output. A missing file is the supported "not yet run" state
 * and yields no scores; any other read, parse or shape failure is corruption and
 * throws, so the route answers 502 instead of serving an empty score list as if the
 * numbers existed.
 */
function rows(path: string): HarnessRow[] {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const parsed: unknown = JSON.parse(raw);
  const rows = (parsed as { rows?: unknown })?.rows;
  if (!Array.isArray(rows) || !rows.every(isHarnessRow)) {
    throw new Error(`${path} is not the harness output`);
  }
  return rows;
}

/** One score per predictor per target per corpus, in a stable order. */
function scoresOf(rows: HarnessRow[]): GrowthScore[] {
  const out: GrowthScore[] = [];
  // One served reading per corpus: the all-pairs row would collide with the
  // gap-filtered one on (name, target, corpus) and carry a different number.
  for (const row of rows.filter((r) => r.primary)) {
    const events = row.fires;
    for (const name of ['persistence', 'constant_ros'] as const) {
      const area = row.burned_area?.[name];
      if (area && 'r2' in area) {
        out.push({
          name,
          target: 'burned_area',
          corpus: row.corpus,
          r2: area.r2,
          medianR2PerFire: area.median_r2_per_fire,
          medianMape: area.median_mape,
          medianBearingErrorDeg: null,
          events,
        });
      }
    }
    const dir = row.bearing_rate.persistence;
    out.push({
      name: 'persistence',
      target: 'bearing_rate',
      corpus: row.corpus,
      r2: dir.rate_r2,
      medianR2PerFire: null,
      medianMape: dir.rate_median_mape,
      medianBearingErrorDeg: dir.median_bearing_error_deg,
      events: row.bearing_rate.rate_fires,
    });
    // The model is fitted on fewer fires than the corpus holds (folds that carry no
    // rate are skipped), so its own count travels with its score.
    const model = row.model?.computed ? row.model : undefined;
    if (model?.rate?.model) {
      out.push({
        name: 'model',
        target: 'bearing_rate',
        corpus: row.corpus,
        r2: model.rate.model.r2,
        medianR2PerFire: null,
        medianMape: model.rate.model.median_mape,
        medianBearingErrorDeg: model.bearing?.model_median_error_deg ?? null,
        events: model.fires ?? events,
      });
    }
  }
  return out;
}

/**
 * The corpus mean rate to hold constant, or null when no corpus carries a real rate
 * of frontal advance. MedEU is excluded by design: its centroid drift is not a rate,
 * and cannot be interpreted as a rate of frontal spread.
 */
function meanRateOf(rows: HarnessRow[]): number | null {
  const frontal = rows.find(
    (r) => r.primary && r.rate_basis === 'frontal' && r.mean_rate_kmh !== null,
  );
  return frontal ? frontal.mean_rate_kmh : null;
}

export function loadMetrics(path: string = METRICS_PATH): Metrics {
  const parsed = rows(path);
  return { scores: scoresOf(parsed), meanRateKmh: meanRateOf(parsed) };
}

/**
 * The predictor that ships. Only predictors scored on burned area are candidates, so
 * the model — which carries a bearing_rate score only — is not one yet; a model would
 * have to beat these on this target to ship.
 *
 * The choice is made on the per-fire median, the honest aggregate: on MedEU the
 * pooled R2 prefers constant_ros while the per-fire reading prefers persistence. The
 * pooled R2 is the fallback only when a corpus carries no per-fire number.
 */
export function shippedPredictor(scores: GrowthScore[]): PredictorName {
  const area = scores.filter((s) => s.target === 'burned_area');
  const rank = (s: GrowthScore): number => s.medianR2PerFire ?? s.r2;
  const best = area.reduce<GrowthScore | null>(
    (acc, s) => (acc === null || rank(s) > rank(acc) ? s : acc),
    null,
  );
  return best?.name ?? 'persistence';
}
