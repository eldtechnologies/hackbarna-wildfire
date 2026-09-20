// Regression tests for the growth model. Run with:
//   node --test --import tsx server/model/model.test.ts
//
// These are behaviour tests. They pin the honest-absence rules (a direction that
// cannot be computed is null, never zero), the time split, the loader's failure
// contract, and the response shape that the console reads.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FiresResponse, Hotspot } from '../../shared/fires';
import {
  advanceBetween,
  hoursSinceLastDetection,
  observedGrowth,
  sourceMixOf,
  timeSplit,
  weightedCentroid,
} from './growth';
import { baselinesFor, constantRos } from './baselines';
import { detectionsOf, growthFor } from './index';
import { loadMetrics, shippedPredictor } from './metrics';

function hotspot(over: Partial<Hotspot>): Hotspot {
  return {
    id: 'h',
    position: { lat: 0, lon: 0 },
    frpMw: null,
    confidence: null,
    detectedAt: null,
    clusterId: 'c1',
    satellite: null,
    ...over,
  };
}

const at = (hour: number) => `2026-09-19T${String(hour).padStart(2, '0')}:00:00.000Z`;

test('weightedCentroid pulls toward the detection with the most power', () => {
  const c = weightedCentroid([
    hotspot({ position: { lat: 0, lon: 0 }, frpMw: 1 }),
    hotspot({ position: { lat: 0, lon: 10 }, frpMw: 99 }),
  ]);
  assert.ok(c);
  // 99/(1+99) of the way from 0 to 10.
  assert.ok(Math.abs(c.lon - 9.9) < 1e-9, `lon was ${c.lon}`);
});

test('weightedCentroid counts an unmeasured detection at unit weight rather than dropping it', () => {
  const c = weightedCentroid([
    hotspot({ position: { lat: 0, lon: 0 }, frpMw: null }),
    hotspot({ position: { lat: 0, lon: 10 }, frpMw: null }),
  ]);
  assert.ok(c);
  assert.equal(c.lon, 5, 'two unweighted detections must average, not vanish');
});

test('weightedCentroid of nothing is null, not the origin', () => {
  assert.equal(weightedCentroid([]), null);
});

test('timeSplit needs four dated detections and splits on time, not array order', () => {
  const late = hotspot({ detectedAt: at(12), position: { lat: 0, lon: 5 } });
  const early = hotspot({ detectedAt: at(6), position: { lat: 0, lon: 0 } });
  // Three is the boundary: one below the minimum cannot split.
  const three = [late, early, hotspot({ detectedAt: at(7) })];
  assert.equal(timeSplit(three), null, 'three dated detections cannot split');
  const split = timeSplit([...three, hotspot({ detectedAt: at(13) })]);
  assert.ok(split);
  assert.equal(split[0][0].detectedAt, at(6), 'the earlier half must hold the earliest');
});

test('timeSplit ignores undated detections instead of ordering them as epoch', () => {
  const dated = [at(6), at(7), at(8), at(9)].map((t) => hotspot({ detectedAt: t }));
  const split = timeSplit([...dated, hotspot({ detectedAt: null })]);
  assert.ok(split);
  assert.equal(split[0].length + split[1].length, 4, 'the undated detection must not join a half');
});

test('timeSplit orders UTC instants across offsets and excludes invalid dates', () => {
  const early = () => hotspot({ detectedAt: '2026-09-19T02:00:00+02:00' });
  const late = () => hotspot({ detectedAt: '2026-09-19T01:00:00Z', position: { lat: 0, lon: 0.01 } });
  const split = timeSplit([late(), early(), hotspot({ detectedAt: 'invalid' }), late(), early()]);
  assert.ok(split);
  assert.equal(split[0].length + split[1].length, 4);
  assert.equal(Date.parse(split[0][0].detectedAt!), Date.parse('2026-09-19T00:00:00Z'));
  assert.ok(advanceBetween(...split));
});

test('unequal FRP weights do not change a constant-speed track', () => {
  const track = Array.from({ length: 8 }, (_, h) => hotspot({
    detectedAt: at(h), position: { lat: 0, lon: 0.0089932 * h },
    frpMw: h === 3 || h === 4 ? 1000 : 1,
  }));
  const result = advanceBetween(track.slice(0, 4), track.slice(4));
  assert.ok(result);
  assert.ok(Math.abs(result.rateKmh - 1) < 0.01, `rate ${result.rateKmh}`);
});

test('advanceBetween reads a due-east move as ~90 degrees', () => {
  const a = [hotspot({ detectedAt: at(0), position: { lat: 0, lon: 0 } }), hotspot({ detectedAt: at(0), position: { lat: 0, lon: 0 } })];
  const b = [hotspot({ detectedAt: at(1), position: { lat: 0, lon: 0.01 } }), hotspot({ detectedAt: at(1), position: { lat: 0, lon: 0.01 } })];
  const adv = advanceBetween(a, b);
  assert.ok(adv);
  assert.ok(Math.abs(adv.bearingDeg - 90) < 0.01, `bearing was ${adv.bearingDeg}`);
  // 0.01 deg of longitude at the equator, over one hour.
  assert.ok(Math.abs(adv.rateKmh - 1.11195) < 0.01, `rate was ${adv.rateKmh}`);
});

test('advanceBetween reads a due-north move as ~0 degrees and wraps correctly', () => {
  const a = [hotspot({ detectedAt: at(0) }), hotspot({ detectedAt: at(0) })];
  const b = [hotspot({ detectedAt: at(1), position: { lat: 0.01, lon: 0 } }), hotspot({ detectedAt: at(1), position: { lat: 0.01, lon: 0 } })];
  const adv = advanceBetween(a, b);
  assert.ok(adv);
  assert.ok(adv.bearingDeg < 0.01 || adv.bearingDeg > 359.99, `bearing was ${adv.bearingDeg}`);
});

test('advanceBetween divides the displacement by the separation of the two half-centroids', () => {
  // A fire moving due east at exactly 1 km/h, with each half spread over hours. The
  // rate must divide by the time between the half-centroids (their mean stamps), not
  // by the window's first-to-last span, which reaches past both and reads ~0.57 km/h.
  const DEG_PER_KM = 0.0089932; // degrees of longitude per km at the equator
  const moving = (hours: number[]) =>
    hours.map((h) => hotspot({ detectedAt: at(h), position: { lat: 0, lon: DEG_PER_KM * h } }));
  const adv = advanceBetween(moving([0, 1, 2, 3]), moving([4, 5, 6, 7]));
  assert.ok(adv);
  assert.ok(Math.abs(adv.rateKmh - 1) < 0.01, `rate was ${adv.rateKmh}, not the true 1 km/h`);
});

test('advanceBetween refuses a direction when the centroids coincide', () => {
  const a = [hotspot({ detectedAt: at(0) })];
  const b = [hotspot({ detectedAt: at(1) })];
  assert.equal(advanceBetween(a, b), null, 'no displacement is no direction');

  const still = [hotspot({ detectedAt: at(0) }), hotspot({ detectedAt: at(0) })];
  const still2 = [hotspot({ detectedAt: at(1) }), hotspot({ detectedAt: at(1) })];
  assert.equal(advanceBetween(still, still2), null);
});

test('advanceBetween refuses a rate when the timestamps do not separate', () => {
  const a = [hotspot({ detectedAt: at(1) }), hotspot({ detectedAt: at(1) })];
  const b = [hotspot({ detectedAt: at(1), position: { lat: 0, lon: 0.01 } }), hotspot({ detectedAt: at(1), position: { lat: 0, lon: 0.01 } })];
  assert.equal(advanceBetween(a, b), null, 'zero elapsed is not an infinite rate');
});

test('sourceMixOf counts sensors and names the unknown ones', () => {
  const mix = sourceMixOf([
    hotspot({ satellite: 'VIIRS' }),
    hotspot({ satellite: 'VIIRS' }),
    hotspot({ satellite: 'MTG-I1' }),
    hotspot({ satellite: null }),
  ]);
  assert.deepEqual(mix, { VIIRS: 2, 'MTG-I1': 1, unknown: 1 });
});

test('hoursSinceLastDetection uses the newest stamp and is null when none is dated', () => {
  const now = new Date('2026-09-19T12:00:00.000Z');
  assert.equal(hoursSinceLastDetection([hotspot({ detectedAt: at(10) })], now), 2);
  assert.equal(hoursSinceLastDetection([hotspot({ detectedAt: null })], now), null);
});

test('hoursSinceLastDetection clamps a future stamp to zero, never a negative age', () => {
  const now = new Date('2026-09-19T12:00:00.000Z');
  assert.equal(
    hoursSinceLastDetection([hotspot({ detectedAt: at(13) })], now),
    0,
    'a detection dated ahead of now is not "hours ago"',
  );
});

test('observedGrowth reports a null direction rather than a zero one', () => {
  const v = observedGrowth('c1', [hotspot({ detectedAt: at(0) })], new Date(at(1)));
  assert.equal(v.bearingDeg, null);
  assert.equal(v.rateKmh, null);
  assert.equal(v.predictor, 'observed');
  assert.equal(v.detections, 1);
});

test('the baselines carry their own name and keep an unknown rate unknown', () => {
  const v = observedGrowth('c1', [hotspot({ detectedAt: at(0) })], new Date(at(1)));
  const [p, c] = baselinesFor(v, 9.5);
  assert.equal(p.predictor, 'persistence');
  assert.equal(c.predictor, 'constant_ros');
  assert.equal(c.rateKmh, 9.5);
  assert.equal(constantRos(v, null).rateKmh, null, 'a missing constant stays null');
});

test('shippedPredictor names a baseline when no model score beats it', () => {
  assert.equal(
    shippedPredictor([
      { name: 'persistence', target: 'burned_area', corpus: 'x', r2: 0.99, medianR2PerFire: 0.57, medianMape: 6, medianBearingErrorDeg: null, events: 10 },
      { name: 'constant_ros', target: 'burned_area', corpus: 'x', r2: 0.98, medianR2PerFire: -0.08, medianMape: 9, medianBearingErrorDeg: null, events: 10 },
      { name: 'model', target: 'bearing_rate', corpus: 'x', r2: 0.1, medianR2PerFire: null, medianMape: 50, medianBearingErrorDeg: 56, events: 10 },
    ]),
    'persistence',
  );
});

test('shippedPredictor decides on the per-fire median, where the pooled reading disagrees', () => {
  // On MedEU the pooled R2 prefers constant_ros (0.8026) while the per-fire median
  // prefers persistence (-3.4177 against -10.949). The honest aggregate must decide.
  const perFire = shippedPredictor([
    { name: 'persistence', target: 'burned_area', corpus: 'm', r2: 0.7681, medianR2PerFire: -3.4177, medianMape: 37.5, medianBearingErrorDeg: null, events: 60 },
    { name: 'constant_ros', target: 'burned_area', corpus: 'm', r2: 0.8026, medianR2PerFire: -10.949, medianMape: 48.5, medianBearingErrorDeg: null, events: 60 },
  ]);
  assert.equal(perFire, 'persistence');
});

test('loadMetrics returns the committed harness output', () => {
  const { scores } = loadMetrics();
  assert.ok(scores.length > 0, 'the harness output must be committed and readable');
  for (const s of scores) {
    assert.ok(s.corpus.length > 0, 'every score must name its corpus');
    assert.equal(typeof s.r2, 'number');
  }
});

test('a pooled score travels with its per-fire reading, because they disagree', () => {
  // The pooled R2 is dominated by the largest fires. Serving it alone would put a
  // number on screen that is true of a few fires and false of the typical one. The
  // committed values are pinned, so a mutation that served the pooled number twice
  // fails here.
  const pinned: Record<string, { r2: number; perFire: number }> = {
    'PT-FireSprd/persistence': { r2: 0.9897, perFire: 0.572 },
    'PT-FireSprd/constant_ros': { r2: 0.9856, perFire: -0.08 },
    'FireSpread_MedEU/persistence': { r2: 0.7681, perFire: -3.4177 },
    'FireSpread_MedEU/constant_ros': { r2: 0.8026, perFire: -10.949 },
  };
  const area = loadMetrics().scores.filter((s) => s.target === 'burned_area');
  assert.ok(area.length > 0);
  for (const s of area) {
    const p = pinned[`${s.corpus}/${s.name}`];
    assert.ok(p, `an unexpected area score: ${s.corpus}/${s.name}`);
    assert.equal(s.r2, p.r2);
    assert.equal(s.medianR2PerFire, p.perFire);
    assert.notEqual(s.medianR2PerFire, s.r2, `${s.corpus}/${s.name}: the two readings must disagree`);
    assert.ok(s.medianR2PerFire! <= s.r2, `${s.corpus}/${s.name}: per-fire must not flatter pooled`);
  }
});

test('meanRateKmh serves a frontal rate, never MedEU centroid drift', () => {
  // MedEU is marked rate_basis 'centroid_drift' and a drift is not a rate of advance.
  // Only PT-FireSprd's frontal mean (0.9569 km/h) may become the served constant; a
  // regression that included the drift row would serve 0.0173 km/h.
  assert.equal(loadMetrics().meanRateKmh, 0.9569);
});

test('the all-pairs rows stay out of the served scores', () => {
  // The committed file carries a second row per corpus whose numbers differ (MedEU
  // constant_ros is 0.8026 filtered against -28.4813 unfiltered). Serving both would
  // put two numbers behind one key.
  const scores = loadMetrics().scores;
  const keys = scores.map((s) => `${s.corpus}/${s.name}/${s.target}`);
  assert.equal(new Set(keys).size, keys.length, 'one served reading per key');
  const medeu = scores.find(
    (s) => s.corpus === 'FireSpread_MedEU' && s.name === 'constant_ros' && s.target === 'burned_area',
  );
  assert.ok(medeu);
  assert.equal(medeu.r2, 0.8026, 'the gap-filtered reading, never the all-pairs one');
});

test('the model score carries its own fire count and bearing error', () => {
  const model = loadMetrics().scores.find((s) => s.name === 'model' && s.corpus === 'PT-FireSprd');
  assert.ok(model, 'the model row must be served so its null slot is reasoned');
  assert.equal(model.events, 69, 'the fitted fire count, not the corpus count of 72');
  assert.equal(model.medianBearingErrorDeg, 56.18, 'the number that justifies model: null');
});

test('a missing metrics file is the supported not-yet-run state', () => {
  const dir = mkdtempSync(join(tmpdir(), 'metrics-'));
  try {
    const m = loadMetrics(join(dir, 'absent.json'));
    assert.deepEqual(m, { scores: [], meanRateKmh: null });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('valid uncomputed model and constant-rate blocks still serve available baselines', () => {
  const document = JSON.parse(readFileSync(new URL('../../data/model/metrics.json', import.meta.url), 'utf8'));
  for (const row of document.rows) {
    row.model = { computed: false, reason: 'insufficient data' };
    row.burned_area.constant_ros = { computed: false, reason: 'one eligible fire' };
  }
  const dir = mkdtempSync(join(tmpdir(), 'metrics-baseline-'));
  try {
    const path = join(dir, 'metrics.json');
    writeFileSync(path, JSON.stringify(document));
    const { scores } = loadMetrics(path);
    assert.ok(scores.length > 0);
    assert.ok(scores.every((s) => s.name === 'persistence'));
    assert.equal(scores.find((s) => s.corpus === 'PT-FireSprd' && s.target === 'bearing_rate')?.events, 69);
    assert.equal(scores.find((s) => s.corpus === 'FireSpread_MedEU' && s.target === 'bearing_rate')?.events, 59);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a corrupt metrics file throws instead of serving an empty score list', () => {
  const dir = mkdtempSync(join(tmpdir(), 'metrics-'));
  try {
    const p = join(dir, 'metrics.json');
    writeFileSync(p, '[{"corpus":');
    assert.throws(() => loadMetrics(p), 'truncated JSON must fail loudly');
    writeFileSync(p, '{"corpus":"x"}');
    assert.throws(() => loadMetrics(p), 'a non-array must fail loudly');
    // A row missing a leaf (here `r2`) must not be served with `r2: undefined`.
    writeFileSync(
      p,
      JSON.stringify([
        {
          corpus: 'x',
          fires: 1,
          rate_basis: 'frontal',
          primary: true,
          mean_rate_kmh: null,
          burned_area: { persistence: { median_r2_per_fire: null, median_mape: 1 }, constant_ros: {} },
          bearing_rate: { persistence: {} },
        },
      ]),
    );
    assert.throws(() => loadMetrics(p), /not the harness output/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('detectionsOf prefers the cluster tag and falls back to the id list', () => {
  const response = {
    clusters: [{ id: 'c1', hotspotIds: ['h9'] }],
    hotspots: [hotspot({ id: 'h1', clusterId: 'c1' })],
  } as unknown as FiresResponse;
  assert.deepEqual(detectionsOf(response, 'c1').map((h) => h.id), ['h1']);

  const untagged = {
    clusters: [{ id: 'c1', hotspotIds: ['h9'] }],
    hotspots: [hotspot({ id: 'h9', clusterId: null })],
  } as unknown as FiresResponse;
  assert.deepEqual(detectionsOf(untagged, 'c1').map((h) => h.id), ['h9']);
});

test('growthFor describes a known cluster and refuses an unknown one', () => {
  const response = {
    clusters: [{ id: 'c1', hotspotIds: [] }],
    hotspots: [
      hotspot({ detectedAt: at(0) }),
      hotspot({ detectedAt: at(0) }),
      hotspot({ detectedAt: at(1), position: { lat: 0, lon: 0.01 } }),
      hotspot({ detectedAt: at(1), position: { lat: 0, lon: 0.01 } }),
    ],
  } as unknown as FiresResponse;

  assert.equal(growthFor('nope', response), null, 'an unknown cluster is not a 200 with empty numbers');

  const body = growthFor('c1', response, new Date(at(2)));
  assert.ok(body);
  assert.equal(body.clusterId, 'c1');
  assert.equal(body.model, null, 'the model lost on held-out fires and must not be invented');
  assert.deepEqual(body.baselines.map((b) => b.predictor), ['persistence', 'constant_ros']);
  assert.deepEqual(body.baselines.map((b) => b.rateBasis), ['detection_centroid_drift', 'frontal_corpus_mean']);
  assert.equal(body.scoreScope, 'offline_corpus_baselines');
  assert.equal(body.shippedBaseline, true);
  assert.equal(body.shipped, 'persistence');
  assert.ok(body.scores.length > 0, 'the held-out scores must travel with the claim');
});
