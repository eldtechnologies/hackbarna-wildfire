// Regression tests for the Deepfire normalizer. Run with:
//   node --test --import tsx server/providers/normalize.test.ts
//
// These pin the trust boundary. Every case here was a real defect at some point,
// so they are behaviour tests, not string checks.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalize, type RawCluster, type RawHotspot, type RawPerimeter } from './normalize';

// data/snapshots, resolved from this file rather than the cwd.
const SNAPSHOT_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../data/snapshots');

const RING: [number, number][] = [
  [-2, 37],
  [-2.1, 37],
  [-2.1, 37.1],
  [-2, 37.1],
  [-2, 37],
];

const hotspot = (
  props: Partial<RawHotspot['properties']> = {},
  lon = -2,
  lat = 37,
): RawHotspot => ({
  type: 'Feature',
  geometry: { type: 'Point', coordinates: [lon, lat] },
  properties: {
    id: 'h1',
    cluster_id: 'c1',
    observed_at: '2026-07-09T12:00:00Z',
    source: 'VIIRS',
    confidence: 'HIGH',
    fire_radiative_power: 10,
    country: 'ES',
    active: true,
    ...props,
  },
});

const cluster = (id: string): RawCluster => ({
  type: 'Feature',
  geometry: { type: 'Point', coordinates: [-2, 37] },
  properties: {
    id,
    first_observed: '2026-07-09T00:00:00Z',
    last_observed: '2026-07-09T12:00:00Z',
    active: true,
  },
});

const perimeter = (
  props: Partial<RawPerimeter['properties']> = {},
  geom: RawPerimeter['geometry'] = { type: 'MultiPolygon', coordinates: [[RING]] },
): RawPerimeter => ({
  type: 'Feature',
  geometry: geom,
  properties: {
    id: 'p1',
    cluster_id: 'c1',
    computed_at: '2026-07-09T13:00:00Z',
    observed_watermark: '2026-07-09T12:00:00Z',
    n_hotspots: 1,
    area_m2: 1_000_000,
    perimeter_m: 100,
    active: true,
    ...props,
  },
});

type Payload = Parameters<typeof normalize>[0];
const payload = (over: Partial<Payload> = {}): Payload => ({
  hotspots: [hotspot()],
  clusters: [cluster('c1')],
  perimeters: [],
  ...over,
});

const run = (over: Partial<Payload> = {}) => normalize(payload(over), 'live', null);

// Captures the drop warnings so the "the loss is visible" contract is testable.
const captureWarnings = (fn: () => void): string[] => {
  const seen: string[] = [];
  const real = console.warn;
  console.warn = (...args: unknown[]) => seen.push(args.join(' '));
  try {
    fn();
  } finally {
    console.warn = real;
  }
  return seen;
};

// --- FRP: a missing value is null, a measured value is kept verbatim ---------

test('a missing FRP stays null, never 0', () => {
  const out = run({ hotspots: [hotspot({ fire_radiative_power: null })] });
  assert.equal(out.hotspots[0].frpMw, null);
});

test('a measured zero FRP stays 0, never null', () => {
  // Regression: an earlier revision wrote `|| frp === 0 ? null`, turning a real
  // measurement into a missing value.
  assert.equal(run({ hotspots: [hotspot({ fire_radiative_power: 0 })] }).hotspots[0].frpMw, 0);
});

test('a blank FRP string is not a measured zero', () => {
  // Regression: Number('') is 0 and 0 is finite, so a blank field became a
  // MEASURED zero — the exact confusion this module exists to prevent.
  for (const blank of ['', '   ']) {
    assert.equal(
      run({ hotspots: [hotspot({ fire_radiative_power: blank as unknown as number })] })
        .hotspots[0].frpMw,
      null,
      `"${blank}" must not become 0`,
    );
  }
});

test('an unparseable FRP becomes null, not a fake 0', () => {
  assert.equal(
    run({ hotspots: [hotspot({ fire_radiative_power: 'n/a' as unknown as number })] }).hotspots[0]
      .frpMw,
    null,
  );
});

test('a negative FRP is kept, because it is a real value', () => {
  const out = run({ hotspots: [hotspot({ fire_radiative_power: -1.5 })] });
  assert.equal(out.hotspots[0].frpMw, -1.5);
});

// --- Confidence: case-insensitive, and an unknown word is NOT "low" ----------

test('confidence words map case-insensitively', () => {
  const out = run({
    hotspots: [
      hotspot({ id: 'a', confidence: 'HIGH', fire_radiative_power: 1 }),
      hotspot({ id: 'b', confidence: 'medium', fire_radiative_power: 1 }),
      hotspot({ id: 'c', confidence: 'Low', fire_radiative_power: 1 }),
    ],
  });
  assert.deepEqual(
    out.hotspots.map((h) => h.confidence),
    [0.9, 0.65, 0.3],
  );
});

test('an unknown confidence word is null, not the LOW value', () => {
  // Regression: the fallback equalled LOW's value, so an unrecognised word was
  // indistinguishable from a real LOW and deleting the LOW entry changed nothing.
  for (const word of ['unknown', '', '   ', null, 42]) {
    const out = run({ hotspots: [hotspot({ confidence: word as unknown as string })] });
    assert.equal(out.hotspots[0].confidence, null, `${JSON.stringify(word)} must be null`);
  }
  // and a real LOW must still be distinguishable from that
  assert.equal(run({ hotspots: [hotspot({ confidence: 'LOW' })] }).hotspots[0].confidence, 0.3);
});

// --- Geometry and timestamps: malformed features are dropped, and counted ----

test('GeoJSON [lon, lat] becomes { lat, lon }, not the other way round', () => {
  assert.deepEqual(run({ hotspots: [hotspot({}, -2.29, 37.12)] }).hotspots[0].position, {
    lat: 37.12,
    lon: -2.29,
  });
});

test('a hotspot with a null geometry is dropped, not thrown on', () => {
  // Regression: RFC 7946 permits `geometry: null`, and the destructure threw,
  // discarding all three collections.
  const broken = { ...hotspot(), geometry: null } as unknown as RawHotspot;
  const out = run({ hotspots: [broken, hotspot({ id: 'ok' })] });
  assert.equal(out.hotspots.length, 1);
  assert.equal(out.hotspots[0].id, 'ok');
});

test('a missing observed_at is null, and the key is still present', () => {
  const out = run({ hotspots: [hotspot({ observed_at: undefined as unknown as string })] });
  assert.ok('detectedAt' in out.hotspots[0]);
  assert.equal(out.hotspots[0].detectedAt, null);
});

test('the source satellite passes through, and a blank one is null', () => {
  const out = run({
    hotspots: [hotspot(), hotspot({ id: 'h2', source: '  ' })],
  });
  assert.equal(out.hotspots[0].satellite, 'VIIRS');
  assert.equal(out.hotspots[1].satellite, null);
});

test('a horizon-0 spread record is the perimeter, positive horizons are steps', () => {
  const out = run({
    spread: [
      { cluster_id: 'c1', valid_time: '2026-07-09T12:00:00Z', horizon_hours: 0, area_km2: 7.4, geometry: { type: 'Polygon', coordinates: [RING] } },
      { cluster_id: 'c1', valid_time: '2026-07-09T14:00:00Z', horizon_hours: 2, geometry: { type: 'Polygon', coordinates: [RING] } },
      { cluster_id: 'c1', valid_time: '2026-07-09T16:00:00Z', geometry: { type: 'Polygon', coordinates: [RING] } },
    ],
  });
  assert.equal(out.perimeters.length, 1);
  assert.equal(out.perimeters[0].areaKm2, 7.4);
  assert.equal(out.perimeters[0].observedAt, '2026-07-09T12:00:00Z');
  assert.equal(out.spread.length, 1);
  assert.equal(out.spread[0].horizonHours, 2);
  assert.equal(out.spread[0].at, '2026-07-09T14:00:00Z');
});

test('a blank observed_watermark falls back instead of surviving as ""', () => {
  // Regression: `??` does not treat '' as nullish, so the empty string won.
  const out = run({ perimeters: [perimeter({ observed_watermark: '' })] });
  assert.equal(out.perimeters[0].observedAt, '2026-07-09T13:00:00Z');
});

// --- Cluster membership and totals ------------------------------------------

test('cluster membership comes from the hotspot cluster_id', () => {
  const out = run({
    hotspots: [hotspot({ id: 'a', cluster_id: 'c1' }), hotspot({ id: 'b', cluster_id: 'c2' })],
    clusters: [cluster('c1'), cluster('c2')],
  });
  assert.deepEqual(out.clusters[0].hotspotIds, ['a']);
  assert.deepEqual(out.clusters[1].hotspotIds, ['b']);
});

test('totalFrpMw is null when no member has a measured FRP', () => {
  // Regression: a sum of `?? 0` reported 0 MW, a measurement that does not exist.
  const none = run({
    hotspots: [hotspot({ fire_radiative_power: null })],
    clusters: [cluster('c1')],
  });
  assert.equal(none.clusters[0].totalFrpMw, null);
  const some = run({ hotspots: [hotspot({ fire_radiative_power: 7 })], clusters: [cluster('c1')] });
  assert.equal(some.clusters[0].totalFrpMw, 7);
});

test('a cluster with no members still gets a usable bbox, not infinities', () => {
  const bbox = run({ hotspots: [], clusters: [cluster('c1')] }).clusters[0].bbox;
  assert.ok(bbox.every(Number.isFinite), `bbox has infinities: ${bbox}`);
  // and it is the cluster's own location, not a fallback sentinel
  assert.deepEqual(bbox, [-2, 37, -2, 37]);
});

// --- Perimeters --------------------------------------------------------------

test('a MultiPolygon perimeter yields one record per part, tagged and counted', () => {
  const p = perimeter(
    {},
    { type: 'MultiPolygon', coordinates: [[RING], [RING]] },
  );
  const out = run({ perimeters: [p] });
  assert.equal(out.perimeters.length, 2);
  assert.deepEqual(
    out.perimeters.map((x) => [x.partIndex, x.partCount]),
    [
      [0, 2],
      [1, 2],
    ],
  );
  // areaKm2 is the parent total, repeated: a summing consumer must count the
  // feature once, which partCount makes possible.
  assert.deepEqual(out.perimeters.map((x) => x.areaKm2), [1, 1]);
});

test('an unmeasured perimeter area is null, never 0', () => {
  // Regression: num() mapped null and 'abc' to 0, publishing areaKm2: 0.
  for (const bad of [null, 'abc']) {
    const out = run({ perimeters: [perimeter({ area_m2: bad as unknown as number })] });
    assert.equal(out.perimeters[0].areaKm2, null, `${JSON.stringify(bad)} must be null`);
  }
  assert.equal(run({ perimeters: [perimeter({ area_m2: 0 })] }).perimeters[0].areaKm2, 0);
});

test('a ring shorter than 4 positions is dropped, not rendered', () => {
  // GeoJSON rings are closed, so 3 positions is malformed rather than a triangle.
  const p = perimeter(
    {},
    {
      type: 'MultiPolygon',
      coordinates: [
        [
          [
            [-2, 37],
            [-2.1, 37],
            [-2.1, 37.1],
          ],
        ],
      ],
    },
  );
  assert.equal(run({ perimeters: [p] }).perimeters.length, 0);
});

test('a closed ring with only 3 positions is still dropped', () => {
  // Isolates the length rule from the closed-ring rule: this ring IS closed, so
  // only the >=4 requirement can reject it.
  const p = perimeter(
    {},
    {
      type: 'MultiPolygon',
      coordinates: [
        [
          [
            [-2, 37],
            [-2.1, 37],
            [-2, 37],
          ],
        ],
      ],
    },
  );
  assert.equal(run({ perimeters: [p] }).perimeters.length, 0);
});

test('an unclosed ring is dropped', () => {
  const p = perimeter(
    {},
    {
      type: 'MultiPolygon',
      coordinates: [
        [
          [
            [-2, 37],
            [-2.1, 37],
            [-2.1, 37.1],
            [-2, 37.2],
          ],
        ],
      ],
    },
  );
  assert.equal(run({ perimeters: [p] }).perimeters.length, 0);
});

test('a non-numeric coordinate is dropped, not passed through as a string', () => {
  const broken = {
    ...hotspot(),
    geometry: { type: 'Point', coordinates: ['-2', '37'] },
  } as unknown as RawHotspot;
  assert.equal(run({ hotspots: [broken] }).hotspots.length, 0);
});

test('the real snapshot normalizes to 2743 / 7 / 12 with no NaN', () => {
  // The replay path is the demo's no-network fallback, so the shipped snapshot
  // gets a smoke test of its own.
  const raw = JSON.parse(
    readFileSync(join(SNAPSHOT_DIR, 'los-gallardos-2026-07-09.json'), 'utf8'),
  );
  const out = normalize(raw, 'replay', 'los-gallardos-2026-07-09');
  assert.equal(out.hotspots.length, 2743);
  assert.equal(out.clusters.length, 7);
  assert.equal(out.perimeters.length, 12);
  assert.ok(out.hotspots.every((h) => Number.isFinite(h.position.lat)));
  assert.ok(out.hotspots.every((h) => Number.isFinite(h.position.lon)));
  assert.ok(out.hotspots.every((h) => h.frpMw === null || Number.isFinite(h.frpMw)));
  assert.ok(out.perimeters.every((p) => p.areaKm2 === null || Number.isFinite(p.areaKm2)));
});

test('a perimeter with no cluster_id has a null clusterId, not the string "undefined"', () => {
  // Regression: String(undefined) produced the identity "undefined".
  const bare = {
    type: 'Feature',
    geometry: { type: 'MultiPolygon', coordinates: [[RING]] },
    properties: { id: 'p', computed_at: 'x', n_hotspots: 1, area_m2: 1, perimeter_m: 1, active: true },
  } as unknown as RawPerimeter;
  assert.equal(run({ perimeters: [bare] }).perimeters[0].clusterId, null);

  const blank = perimeter({ cluster_id: '  ' as unknown as string });
  assert.equal(run({ perimeters: [blank] }).perimeters[0].clusterId, null);
});

test('a blank hotspot cluster_id is null rather than an empty identity', () => {
  const out = run({ hotspots: [hotspot({ cluster_id: '   ' as unknown as string })] });
  assert.equal(out.hotspots[0].clusterId, null);
});

test('a MultiPolygon keeps its good part and counts the malformed one', () => {
  // Regression: only whole features were counted, so a feature with one good part
  // and one bad part lost the bad part silently.
  const mixed = perimeter(
    {},
    {
      type: 'MultiPolygon',
      coordinates: [
        [RING],
        [
          [
            [-3, 38],
            [-3.1, 38],
          ],
        ],
      ],
    },
  );
  const out = run({ perimeters: [mixed] });
  assert.equal(out.perimeters.length, 1);
  assert.deepEqual([out.perimeters[0].partIndex, out.perimeters[0].partCount], [0, 1]);
});

test('dropping a malformed perimeter part is warned, not silent', () => {
  // Regression: only whole features were counted, so a feature that lost one part
  // lost it silently.
  const mixed = perimeter(
    {},
    {
      type: 'MultiPolygon',
      coordinates: [
        [RING],
        [
          [
            [-3, 38],
            [-3.1, 38],
          ],
        ],
      ],
    },
  );
  const warnings = captureWarnings(() => run({ perimeters: [mixed] }));
  assert.ok(
    warnings.some((w) => w.includes('perimeter parts')),
    `expected a dropped-part warning, got: ${JSON.stringify(warnings)}`,
  );
});

test('a clean payload warns about nothing', () => {
  const warnings = captureWarnings(() => run({ perimeters: [perimeter()] }));
  assert.deepEqual(warnings, []);
});
