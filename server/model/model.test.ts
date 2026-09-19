// Regression tests for the growth model. Run with:
//   node --test --import tsx server/model/model.test.ts
//
// These are behaviour tests. They pin the honest-absence rules (a direction that
// cannot be computed is null, never zero), the time split, and the response shape
// that the console reads.

import test from 'node:test';
import assert from 'node:assert/strict';
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
import { loadScores, shippedPredictor } from './metrics';

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
  assert.equal(timeSplit([late]), null, 'three dated detections cannot split');
  const split = timeSplit([late, early, hotspot({ detectedAt: at(7) }), hotspot({ detectedAt: at(13) })]);
  assert.ok(split);
  assert.equal(split[0][0].detectedAt, at(6), 'the earlier half must hold the earliest');
});

test('timeSplit ignores undated detections instead of ordering them as epoch', () => {
  const dated = [at(6), at(7), at(8), at(9)].map((t) => hotspot({ detectedAt: t }));
  const split = timeSplit([...dated, hotspot({ detectedAt: null })]);
  assert.ok(split);
  assert.equal(split[0].length + split[1].length, 4, 'the undated detection must not join a half');
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
      { name: 'persistence', target: 'burned_area', corpus: 'x', r2: 0.99, medianMape: 6, events: 10 },
      { name: 'constant_ros', target: 'burned_area', corpus: 'x', r2: 0.98, medianMape: 9, events: 10 },
      { name: 'model', target: 'bearing_rate', corpus: 'x', r2: 0.1, medianMape: 50, events: 10 },
    ]),
    'persistence',
  );
});

test('loadScores returns the committed harness output', () => {
  const scores = loadScores();
  assert.ok(scores.length > 0, 'the harness output must be committed and readable');
  for (const s of scores) {
    assert.ok(s.corpus.length > 0, 'every score must name its corpus');
    assert.equal(typeof s.r2, 'number');
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
  assert.equal(body.shippedBaseline, true);
  assert.equal(body.shipped, 'persistence');
  assert.ok(body.scores.length > 0, 'the held-out scores must travel with the claim');
});
