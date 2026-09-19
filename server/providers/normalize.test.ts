// Regression tests for the Deepfire normalizer. Run with:
//   node --test --import tsx server/providers/normalize.test.ts
//
// These pin the trust boundary. Every case here was a real defect or a real
// near-miss at some point, so they are behaviour tests, not string checks.

import test from 'node:test';
import assert from 'node:assert/strict';
import { normalize, type RawCluster, type RawHotspot, type RawPerimeter } from './normalize';

const hotspot = (props: Partial<RawHotspot['properties']>, lon = -2, lat = 37): RawHotspot => ({
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
  properties: { id, first_observed: '2026-07-09T00:00:00Z', last_observed: '2026-07-09T12:00:00Z', active: true },
});

const perimeter = (ring: [number, number][], areaM2: number): RawPerimeter => ({
  type: 'Feature',
  geometry: { type: 'MultiPolygon', coordinates: [[ring]] },
  properties: {
    id: 'p1',
    cluster_id: 'c1',
    computed_at: '2026-07-09T13:00:00Z',
    observed_watermark: '2026-07-09T12:00:00Z',
    n_hotspots: 1,
    area_m2: areaM2,
    perimeter_m: 100,
    active: true,
  },
});

const payload = (over: Partial<Parameters<typeof normalize>[0]> = {}) => ({
  hotspots: [hotspot({})],
  clusters: [cluster('c1')],
  perimeters: [],
  ...over,
});

test('a missing FRP stays null, never 0', () => {
  const out = normalize(payload({ hotspots: [hotspot({ fire_radiative_power: null })] }), 'live', null);
  assert.equal(out.hotspots[0].frpMw, null);
});

test('a measured zero FRP stays 0, never null', () => {
  // Regression: an earlier revision wrote `|| frp === 0 ? null`, which turned a
  // real measurement into a missing value. Zero is a measurement.
  const out = normalize(payload({ hotspots: [hotspot({ fire_radiative_power: 0 })] }), 'live', null);
  assert.equal(out.hotspots[0].frpMw, 0);
});

test('an unparseable FRP becomes null, not a fake 0', () => {
  const out = normalize(payload({ hotspots: [hotspot({ fire_radiative_power: 'n/a' as unknown as number })] }), 'live', null);
  assert.equal(out.hotspots[0].frpMw, null);
});

test('a negative FRP is kept, because it is a real value', () => {
  const out = normalize(payload({ hotspots: [hotspot({ fire_radiative_power: -1.5 })] }), 'live', null);
  assert.equal(out.hotspots[0].frpMw, -1.5);
});

test('confidence words map by case-insensitive name, not to the fallback', () => {
  const out = normalize(
    payload({
      hotspots: [
        hotspot({ id: 'a', confidence: 'HIGH', fire_radiative_power: 1 }),
        hotspot({ id: 'b', confidence: 'MEDIUM', fire_radiative_power: 1 }),
        hotspot({ id: 'c', confidence: 'LOW', fire_radiative_power: 1 }),
      ],
    }),
    'live',
    null,
  );
  assert.deepEqual(out.hotspots.map((h) => h.confidence), [0.9, 0.65, 0.3]);
});

test('GeoJSON [lon, lat] becomes { lat, lon }, not the other way round', () => {
  const out = normalize(payload({ hotspots: [hotspot({}, -2.29, 37.12)] }), 'live', null);
  assert.deepEqual(out.hotspots[0].position, { lat: 37.12, lon: -2.29 });
});

test('cluster membership comes from the hotspot cluster_id', () => {
  const out = normalize(
    payload({
      hotspots: [hotspot({ id: 'a', cluster_id: 'c1' }), hotspot({ id: 'b', cluster_id: 'c2' })],
      clusters: [cluster('c1'), cluster('c2')],
    }),
    'live',
    null,
  );
  assert.deepEqual(out.clusters[0].hotspotIds, ['a']);
  assert.deepEqual(out.clusters[1].hotspotIds, ['b']);
});

test('a cluster with no members still gets a usable bbox, not infinities', () => {
  const out = normalize(payload({ hotspots: [], clusters: [cluster('c1')] }), 'live', null);
  const bbox = out.clusters[0].bbox;
  assert.ok(bbox.every(Number.isFinite), `bbox has infinities: ${bbox}`);
});

test('a MultiPolygon perimeter with two parts yields two perimeters', () => {
  const ring: [number, number][] = [[-2, 37], [-2.1, 37], [-2.1, 37.1], [-2, 37.1], [-2, 37]];
  const p: RawPerimeter = {
    ...perimeter(ring, 1_000_000),
    geometry: { type: 'MultiPolygon', coordinates: [[ring], [ring]] },
  };
  const out = normalize(payload({ perimeters: [p] }), 'live', null);
  assert.equal(out.perimeters.length, 2);
  assert.equal(out.perimeters[0].areaKm2, 1);
});

test('a degenerate ring is dropped rather than rendered', () => {
  const out = normalize(payload({ perimeters: [perimeter([[-2, 37], [-2.1, 37]], 10)] }), 'live', null);
  assert.equal(out.perimeters.length, 0);
});
