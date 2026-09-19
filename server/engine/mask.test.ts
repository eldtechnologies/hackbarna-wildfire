import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildPairIndex, cutField, radiusFor, type Detection, type SweepConfig } from './mask';
import { detectionsFromCapture, groupClustersIntoEvents, loadCapture, pickEventForWindow } from './capture';
import { formatCapTimestamp, toEpochMs } from './time';
import type { LatLon } from '../../shared/fires';

// Paths are resolved from this module, not process.cwd(), so the suite behaves the same
// whether it is run from the repo root, an editor, or a different checkout.
const dataUrl = (rel: string): string => fileURLToPath(new URL(`../../data/${rel}`, import.meta.url));

const capture = loadCapture(JSON.parse(readFileSync(dataUrl('snapshots/los-gallardos-2026-07-09.json'), 'utf8')));
const alWays = (
  JSON.parse(readFileSync(dataUrl('fixtures/al-6109.json'), 'utf8')) as {
    ways: Array<{ id: string; name: string | null; highway: string; geometry: number[][] }>;
  }
).ways;

const originMs = toEpochMs(capture.window!.from)!;
const segments: LatLon[][] = alWays.map((w) => w.geometry.map(([lat, lon]) => ({ lat, lon })));

const FIRE_EVENT = groupClustersIntoEvents(capture.clusters, capture.hotspots)[0];
const pick = pickEventForWindow(
  groupClustersIntoEvents(capture.clusters, capture.hotspots),
  capture.window!.from,
  capture.window!.to,
)!;
const fireDetections = detectionsFromCapture(capture, {
  clusterIds: new Set(pick.clusterIds),
  originMs,
});

/** Earliest cut across the AL-6109 ways, as a CAP-format Barcelona-local timestamp. */
function firstCut(config: SweepConfig, detections: Detection[]): string | null {
  const maxRadius = config.fixedRadiusM ?? 2000 * config.radiusScale;
  const pairs = buildPairIndex(segments, detections, maxRadius);
  const field = cutField(pairs, detections, segments.length, config);
  let earliest = Number.POSITIVE_INFINITY;
  for (const t of field.cutAtSeconds) if (t < earliest) earliest = t;
  if (!Number.isFinite(earliest)) return null;
  return formatCapTimestamp(originMs + earliest * 1000);
}

const config = (over: Partial<SweepConfig>): SweepConfig => ({
  id: 'test',
  label: 'test',
  sources: 'all',
  radiusScale: 1,
  minConfidence: null,
  includeStaticHeatSources: false,
  ...over,
});

test('the fire is two cluster ids, and the pair totals the count the spike published', () => {
  // The capture carries the Los Gallardos fire as two clusters — one all-MTG, one
  // all-polar, same centroid — plus three unrelated heat sources. Reading a single
  // cluster id silently halves the fire.
  assert.equal(pick.clusterIds.length, 2, 'the fire is carried as two clusters');
  assert.equal(fireDetections.length, 2660, '1,932 MTG + 728 polar = the spike\'s 2,660');
  assert.equal(capture.hotspots.length, 2743, 'the capture also holds 83 decoy detections');
  assert.equal(capture.hotspots.length - fireDetections.length, 83);
});

test('the decoy clusters are grouped away from the fire, not merged into it', () => {
  const events = groupClustersIntoEvents(capture.clusters, capture.hotspots);
  const counts = events.map((e) => e.detections).sort((a, b) => b - a);
  assert.deepEqual(counts, [2660, 41, 37, 5], 'the fire, two long-lived western sources, and a southern one');
  assert.equal(events[0].detections, pick.detections);
  assert.deepEqual(FIRE_EVENT.clusterIds.slice().sort(), pick.clusterIds.slice().sort());

  // The property that matters: the fire's two halves merge, and no decoy joins them.
  assert.equal(events[0].clusterIds.length, 2);
  for (const e of events.slice(1)) {
    for (const id of e.clusterIds) assert.ok(!events[0].clusterIds.includes(id), 'a decoy merged into the fire');
  }
});

test('the mask reproduces the spike\'s published cut times for the Bedar exit road', () => {
  // docs/last-safe-departure.md A10, reproduced here on the real capture and the real
  // OSM geometry. All times CEST (UTC+2).
  assert.equal(firstCut(config({ fixedRadiusM: 100 }), fireDetections), '2026-07-09T21:18:21+02:00');
  assert.equal(firstCut(config({ fixedRadiusM: 200 }), fireDetections), '2026-07-09T19:38:21+02:00');
  assert.equal(firstCut(config({ fixedRadiusM: 500 }), fireDetections), '2026-07-09T19:38:21+02:00');
  assert.equal(firstCut(config({ fixedRadiusM: 200, sources: 'polar' }), fireDetections), '2026-07-10T00:03:36+02:00');
});

test('the source set moves the answer further than a tenfold radius change', () => {
  // The plan's claim about the sweep, corrected against measurement. The radius is
  // flat from 200 m to 750 m and then drifts earlier slowly; the source set moves the
  // same road by hours. Measured, all sources: 100 m -> 21:18, 200-750 m -> 19:38,
  // 1000-1500 m -> 19:28, 2000 m -> 19:18.
  const at200 = firstCut(config({ fixedRadiusM: 200 }), fireDetections);
  for (const r of [300, 500, 750]) {
    assert.equal(firstCut(config({ fixedRadiusM: r }), fireDetections), at200, `flat at ${r} m`);
  }

  const polar = firstCut(config({ fixedRadiusM: 200, sources: 'polar' }), fireDetections);
  const widest = firstCut(config({ fixedRadiusM: 2000 }), fireDetections);
  const sourceHours = (toEpochMs(polar)! - toEpochMs(at200)!) / 3_600_000;
  const radiusHours = (toEpochMs(at200)! - toEpochMs(widest)!) / 3_600_000;

  assert.ok(sourceHours > 4 && sourceHours < 5, `source set moves it ~4.4 h, got ${sourceHours.toFixed(2)}`);
  assert.ok(radiusHours > 0 && radiusHours < 1, `a 10x radius moves it under an hour, got ${radiusHours.toFixed(2)}`);
  assert.ok(sourceHours > 2 * radiusHours, 'the sensor axis dominates the buffer axis');
});

test('a per-sensor footprint mask lands on the same time as the flat 200 m buffer', () => {
  // The mask the product actually ships uses each sensor's own footprint rather than
  // one buffer for all. It must not silently disagree with the measured reproduction.
  assert.equal(firstCut(config({ radiusScale: 1 }), fireDetections), '2026-07-09T19:38:21+02:00');
});

test('a decoy-only mask never reaches the Bedar road', () => {
  // If the 83 decoys could cut AL-6109, the reproduction above would be luck.
  // Compare by cluster id, not object identity: groupClustersIntoEvents returns fresh
  // objects on every call, so `e !== pick` would silently keep every event.
  const fireIds = new Set(pick.clusterIds);
  const decoyIds = new Set(
    capture.clusters
      .map((c) => c.properties.id ?? c.id)
      .filter((id) => !fireIds.has(id)),
  );
  const decoys = detectionsFromCapture(capture, { clusterIds: decoyIds, originMs });
  assert.equal(decoys.length, 83);
  assert.equal(firstCut(config({ fixedRadiusM: 500 }), decoys), null, 'decoys never cut the road');
});

test('the radius comparison is inclusive at exactly the radius', () => {
  // Two segments: one exactly 200 m from the detection, one 201 m.
  const det: Detection = { id: 'd', lat: 37.0, lon: -2.0, atSeconds: 100, source: 'MTG_I1', confidence: null, clusterId: null };
  const near = [{ lat: 37.0, lon: -2.0022472 }]; // 200.0 m due west
  const far = [{ lat: 37.0, lon: -2.0022584 }]; // ~201 m
  const pairs = buildPairIndex([near, far], [det], 1000);
  const byIndex = new Map(pairs.map((p) => [p.segmentIndex, p.distanceM]));
  const dNear = byIndex.get(0)!;
  const dFar = byIndex.get(1)!;

  const atExact = cutField(pairs, [det], 2, config({ fixedRadiusM: dNear }));
  assert.equal(atExact.cutAtSeconds[0], 100, 'exactly at the radius cuts');
  assert.ok(Number.isFinite(dFar) && dFar > dNear, `far segment must be further: ${dFar} vs ${dNear}`);
  const justShort = cutField(pairs, [det], 2, config({ fixedRadiusM: dFar - 1e-9 }));
  assert.equal(justShort.cutAtSeconds[1], Number.POSITIVE_INFINITY, 'a hair beyond the radius does not cut');
});

test('the evidence cited is the detection that actually set the time', () => {
  const early: Detection = { id: 'early', lat: 37.0, lon: -2.0, atSeconds: 50, source: 'MTG_I1', confidence: null, clusterId: null };
  const late: Detection = { id: 'late', lat: 37.0, lon: -2.0, atSeconds: 900, source: 'MTG_I1', confidence: null, clusterId: null };
  const seg = [{ lat: 37.0, lon: -2.0 }];
  const pairs = buildPairIndex([seg], [late, early], 500);
  const field = cutField(pairs, [late, early], 1, config({ fixedRadiusM: 500 }));
  assert.equal(field.cutAtSeconds[0], 50);
  assert.deepEqual(field.evidenceDetectionIds[0], ['early']);
});

test('equal-time detections accumulate deterministically, in id order', () => {
  const mk = (id: string): Detection => ({ id, lat: 37.0, lon: -2.0, atSeconds: 50, source: 'MTG_I1', confidence: null, clusterId: null });
  const seg = [{ lat: 37.0, lon: -2.0 }];
  const a = cutField(buildPairIndex([seg], [mk('z'), mk('a')], 500), [mk('z'), mk('a')], 1, config({ fixedRadiusM: 500 }));
  const b = cutField(buildPairIndex([seg], [mk('a'), mk('z')], 500), [mk('a'), mk('z')], 1, config({ fixedRadiusM: 500 }));
  assert.deepEqual(a.evidenceDetectionIds[0], ['a', 'z']);
  assert.deepEqual(a.evidenceDetectionIds, b.evidenceDetectionIds, 'input order must not change the output');
});

test('a never-cut segment stays Infinity and never becomes a finite time', () => {
  const det: Detection = { id: 'd', lat: 37.0, lon: -2.0, atSeconds: 10, source: 'MTG_I1', confidence: null, clusterId: null };
  const farSegment = [{ lat: 38.0, lon: -2.0 }];
  const pairs = buildPairIndex([farSegment], [det], 2000);
  assert.equal(pairs.length, 0, 'a segment 111 km away is not in the index at all');
  const field = cutField(pairs, [det], 1, config({ fixedRadiusM: 2000 }));
  assert.equal(field.cutAtSeconds[0], Number.POSITIVE_INFINITY);
  assert.equal(field.usedDetections, 0, 'a detection that touched nothing is not counted as used');
});

test('the confidence floor drops LOW detections rather than treating null as zero', () => {
  const seg = [{ lat: 37.0, lon: -2.0 }];
  const dets: Detection[] = [
    { id: 'low', lat: 37.0, lon: -2.0, atSeconds: 10, source: 'MTG_I1', confidence: 0.3, clusterId: null },
    { id: 'unknown', lat: 37.0, lon: -2.0, atSeconds: 20, source: 'MTG_I1', confidence: null, clusterId: null },
    { id: 'high', lat: 37.0, lon: -2.0, atSeconds: 30, source: 'MTG_I1', confidence: 0.9, clusterId: null },
  ];
  const pairs = buildPairIndex([seg], dets, 500);
  const field = cutField(pairs, dets, 1, config({ fixedRadiusM: 500, minConfidence: 0.5 }));
  assert.equal(field.cutAtSeconds[0], 30, 'only the HIGH detection survives the floor');
  assert.deepEqual(field.evidenceDetectionIds[0], ['high']);
});

test('radiusFor prefers a fixed radius and falls back to the sensor footprint', () => {
  assert.equal(radiusFor(config({ fixedRadiusM: 250 }), 'VIIRS_SNPP_NRT'), 250);
  assert.equal(radiusFor(config({}), 'VIIRS_SNPP_NRT'), 375);
  assert.equal(radiusFor(config({ radiusScale: 2 }), 'MTG_I1'), 1200);
  assert.equal(radiusFor(config({}), 'SOMETHING_UNKNOWN'), 1000, 'an unknown sensor is assumed coarse, not fine');
});
