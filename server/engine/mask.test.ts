import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_FOOTPRINT_M, SENSOR_FAMILY, SENSOR_FOOTPRINT_M, SENSOR_RADIUS, buildPairIndex, cutField, familyOf, knownFamilies, radiusFor,
  sensorFamilyRows, type Detection, type SweepConfig,
} from './mask';
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

test('decision 5 names exactly the sensor families the footprint table covers', () => {
  // The defect issue #27 reports, made to fail rather than to be noticed: decision 5 named a
  // family the capture never carried, and nothing compared the two. This reads the table the mask
  // actually uses — `SENSOR_FOOTPRINT_M` — so deleting a family from it fails here, which a check
  // against a hand-typed list would not.
  const plan = readFileSync(new URL('../../docs/work-plan.md', import.meta.url), 'utf8');
  const decision = plan.split('\n').find((line) => /^\|\s*5\s*\|/.test(line));
  assert.ok(decision, 'decision 5 is in the plan');

  // "The cut mask is A + B + C + D, sensor-footprint buffered, ..."
  const list = /is\s+([^,]+),\s*sensor-footprint/.exec(decision)?.[1];
  assert.ok(list, `decision 5 names its sensors in the expected shape: ${decision}`);

  // The plan writes the geostationary feed "MTG"; the table keys it MTG_I1. Every other name is the
  // family name verbatim, which is what makes a bare "and SEVIRI" in that list detectable.
  const ALIAS: Record<string, string> = { MTG: 'MTG-I1' };
  // "hotspots" is the Deepfire hotspot layer, not an instrument: it carries detections whose own
  // `source` field names the sensor, so it has no footprint and no family. The decision names it
  // because it is one of the mask's inputs; it is excluded here because it is not one of the
  // instruments that can be missing from it. Anything else in the list is a family and is checked.
  const NOT_AN_INSTRUMENT = new Set(['hotspots']);
  const fromPlan = [...new Set(list.split('+').map((n) => n.trim()).map((n) => ALIAS[n] ?? n))]
    .filter((n) => !NOT_AN_INSTRUMENT.has(n))
    .sort();
  const fromTable = [...new Set(Object.keys(SENSOR_FOOTPRINT_M).map(familyOf))].sort();
  assert.deepEqual(fromPlan, fromTable, 'the plan and the footprint table name the same families');

  assert.deepEqual(
    Object.keys(SENSOR_FOOTPRINT_M).filter((s) => SENSOR_FAMILY[s] === undefined),
    [],
    'and every source in the table has a family, so neither can drift from the other',
  );
});

test('SEVIRI is absent from the table and from the capture, so nothing claims to include it', () => {
  // Criteria 2 and 3 are conditional on obtaining SEVIRI detections. Rather than passing vacuously
  // on a false antecedent, this asserts the antecedent IS false: a capture carrying SEVIRI, or a
  // table entry for it, fails here and sends a reader back to the amendment — instead of leaving a
  // satisfied-looking conditional that was never exercised.
  const named = [...Object.keys(SENSOR_FOOTPRINT_M), ...Object.values(SENSOR_FAMILY)].filter((s) => /seviri/i.test(s));
  assert.deepEqual(named, [], 'the footprint table has no SEVIRI entry');

  // The WHOLE capture, not the fire event's detections. `loadContext().detections` holds only the
  // two clusters the fire was grouped from, and the decoys are exactly where an unrelated
  // instrument would first appear — verified by putting a SEVIRI source on a decoy hotspot: this
  // check fails and the narrower one passes. The claim it has to support is about the capture.
  const sources = new Set(
    capture.hotspots
      .map((h) => (h as { properties?: { source?: string } }).properties?.source)
      .filter((s): s is string => typeof s === 'string'),
  );
  assert.equal(sources.size, 7, 'the capture carries seven sources');
  assert.deepEqual([...sources].filter((s) => /seviri/i.test(s)), [], 'and none of them is SEVIRI');
});

test('the plan records the amendment, and the open question about the SEVIRI band is closed', () => {
  // "The plan records why" is a claim about a file, so it is checked against the file. The old
  // bullet — "How much the SEVIRI band actually widens." — carried no closure and fails here.
  const plan = readFileSync(new URL('../../docs/work-plan.md', import.meta.url), 'utf8');

  const decision = plan.split('\n').find((line) => /^\|\s*5\s*\|/.test(line)) ?? '';
  assert.match(decision, /Amended/, 'decision 5 records that it was amended');
  assert.match(decision, /#27/, 'and names the issue that amended it');

  const open = plan.slice(plan.indexOf('## Open'));
  // EVERY bullet that mentions it, not the first one found. Stopping at the first match means
  // re-adding the stale open item as a second bullet after the closed one still passes — verified
  // by mutation. The claim is that the question is not left standing anywhere in the section.
  const bullets = open.split(/\n(?=- )/).filter((block) => /SEVIRI/i.test(block));
  assert.ok(bullets.length > 0, 'the open section still says what happened to the SEVIRI question');
  for (const bullet of bullets) {
    assert.match(bullet, /closed/i, `every SEVIRI item here says it is closed: ${bullet.slice(0, 90)}`);
  }
});

test('the family breakdown counts feeds as instruments, and a shared cut once', () => {
  // Four risk-map rows in one input where each right version differs observably from its wrong one.
  const det = (id: string, source: string): Detection => ({
    id, source, lat: 37.17, lon: -2.01, atSeconds: 0, confidence: 1, clusterId: null,
  });
  const detections = [
    det('v1', 'VIIRS_SNPP_NRT'),
    det('v2', 'VIIRS_NOAA20_NRT'),
    det('v3', 'VIIRS_NOAA21_NRT'),
    det('m1', 'MTG_I1'),
    det('s1', 'SENTINEL_3A'),
    det('w1', 'WEIRD_NEW_SENSOR'),
  ];
  // Two VIIRS detections reached a road and the unrecognised one did; NOTHING from Sentinel-3,
  // which is in the capture and reached none.
  const used = ['v1', 'v2', 'w1'];
  // Segment 0 is attained by TWO VIIRS feeds, segment 1 by MTG.
  const evidence = [['v1', 'v2'], ['m1']];

  const by = new Map(sensorFamilyRows(detections, used, evidence).rows.map((r) => [r.family, r]));

  // family grouping — the wrong version lists three VIIRS rows and reads as three instruments
  assert.equal(by.get('VIIRS')?.sources.length, 3, 'the three VIIRS feeds are one family');
  assert.equal(by.get('VIIRS')?.detections, 3, 'and their detections are summed into it');
  assert.equal(by.get('VIIRS')?.usedDetections, 2, 'two of which reached a road');
  // cut counting — the wrong version sums per source and reports two cuts for one segment
  assert.equal(by.get('VIIRS')?.cutSegments, 1, 'a segment cut by two feeds of one family is one cut');

  // used is not detections — the wrong version reports the capture's count as the contribution
  assert.equal(by.get('Sentinel-3')?.detections, 1, 'Sentinel-3 is in the capture');
  assert.equal(by.get('Sentinel-3')?.usedDetections, 0, 'and none of its detections reached a road');
  assert.equal(by.get('Sentinel-3')?.cutSegments, 0);

  // an unrecognised sensor keeps its own name rather than borrowing a family
  assert.equal(by.get('WEIRD_NEW_SENSOR')?.usedDetections, 1, 'an unknown sensor is its own family');
});

test('an empty capture still reports every family the table knows', () => {
  // An empty list would read as "no sensor saw this fire", the same inversion as an empty mask
  // reading as all-clear. The families come from the table, not from what happened to be seen.
  const { rows, unattributedCutSegments } = sensorFamilyRows([], [], []);
  assert.ok(rows.length > 0, 'the list is not empty');
  assert.deepEqual(rows.map((r) => r.family), knownFamilies(), 'a zero row per known family');
  assert.ok(
    rows.every((r) => r.detections === 0 && r.usedDetections === 0 && r.cutSegments === 0),
    'every count zero rather than absent',
  );
  assert.equal(unattributedCutSegments, 0, 'and nothing is unattributed when nothing was cut');
});

test('a source named after an Object member does not resolve through the prototype chain', () => {
  // `SENSOR_FAMILY[source] ?? source` answers for `'constructor'` with the Object function and for
  // `'__proto__'` with Object.prototype — both truthy, so the fallback never fires. The family
  // reaches the wire as a non-string: `{"family":{}}` for one, and for the other `JSON.stringify`
  // drops the key entirely. At the sibling radius lookup the same lookup yields `Object * scale`,
  // which is NaN, and every `distanceM > NaN` is false — so a detection from such a source is
  // treated as reaching every road segment in the graph. Source strings come from the capture.
  for (const source of ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf']) {
    assert.equal(familyOf(source), source, `${source} is its own family`);
    assert.equal(typeof familyOf(source), 'string', 'and the family is a string');
  }

  // The radius half, which is the one that would silently cut every road.
  const radius = SENSOR_RADIUS('constructor', 1);
  assert.ok(Number.isFinite(radius), `a prototype-member source gets a finite radius, not NaN: ${radius}`);
  assert.equal(radius, DEFAULT_FOOTPRINT_M, 'it falls back to the default footprint');

  // And through the public path, so the family that reaches a row is a string.
  const det = (id: string, source: string): Detection => ({
    id, source, lat: 37.17, lon: -2.01, atSeconds: 0, confidence: 1, clusterId: null,
  });
  const weird = sensorFamilyRows([det('p1', 'constructor'), det('p2', '__proto__')], ['p1', 'p2'], [['p1']]);
  for (const row of weird.rows) {
    assert.equal(typeof row.family, 'string', `every family is a string: ${JSON.stringify(row.family)}`);
    assert.ok(row.family.length > 0);
  }
  assert.equal(weird.unattributedCutSegments, 0);
});

test('a repeated used id does not inflate a family past the capture it came from', () => {
  // The pipeline builds this list from a Set, so it is unique today — but that is a property of the
  // caller's input, and this function is exported. Without de-duplication a repeated id reports a
  // family as having used more detections than the capture holds.
  const det = (id: string, source: string): Detection => ({
    id, source, lat: 37.17, lon: -2.01, atSeconds: 0, confidence: 1, clusterId: null,
  });
  const { rows } = sensorFamilyRows([det('v1', 'VIIRS_SNPP_NRT')], ['v1', 'v1', 'v1'], []);
  const viirs = rows.find((r) => r.family === 'VIIRS');
  assert.equal(viirs?.detections, 1);
  assert.equal(viirs?.usedDetections, 1, 'a repeated id counts once, and never exceeds the capture');
});

test('a cut whose evidence names no known detection is counted rather than dropped', () => {
  // The specification's residual, which was described and never implemented. Without it a capture
  // whose evidence ids stopped matching its detections would show up only as families reading
  // quietly low — the same shape as the defect this issue is about.
  const det = (id: string, source: string): Detection => ({
    id, source, lat: 37.17, lon: -2.01, atSeconds: 0, confidence: 1, clusterId: null,
  });
  const detections = [det('v1', 'VIIRS_SNPP_NRT')];
  // Segment 0 is real. Segment 1 cites only a ghost id, so it belongs to no family. Segment 2 has
  // no evidence at all, which is a segment the fire never cut and is NOT an omission.
  const { rows, unattributedCutSegments } = sensorFamilyRows(detections, ['v1'], [['v1'], ['ghost'], []]);

  assert.equal(unattributedCutSegments, 1, 'the ghost-only cut is counted');
  assert.equal(rows.find((r) => r.family === 'VIIRS')?.cutSegments, 1, 'and the real cut still belongs to its family');
  // Segments that were never cut carry no evidence and must not be counted as unattributable.
  const { unattributedCutSegments: none } = sensorFamilyRows(detections, ['v1'], [[], [], []]);
  assert.equal(none, 0, 'an uncut segment is not an unattributed cut');
});

test('a source that is not a string is coerced, not published as itself', () => {
  // `Detection.source` is typed `string` and arrives from the capture unvalidated — the loader
  // normalises `confidence` and passes `source` through. Uncoerced, a numeric source missed the
  // table lookup and came back unchanged, putting a number where `SensorFamilyRow.family` declares a
  // string. Measured before the fix: a row reading `{"family":0,"sources":[0]}`.
  const numeric = {
    id: 'n1', source: 0, lat: 37, lon: -2, atSeconds: 0, confidence: 1, clusterId: null,
  } as unknown as Detection;

  const { rows } = sensorFamilyRows([numeric], ['n1'], [['n1']]);
  const row = rows.find((r) => r.detections > 0);
  assert.ok(row, 'the detection is counted in some family');
  assert.equal(typeof row.family, 'string', `the family is a string: ${JSON.stringify(row.family)}`);
  assert.deepEqual(row.sources, ['0'], 'and the source is the string form of what arrived');
  assert.equal(row.cutSegments, 1, 'its cut still lands, rather than being dropped as unattributable');
});
