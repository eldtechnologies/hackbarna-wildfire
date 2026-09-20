// The cut-time mask: when the fire reaches each road segment.
//
// The spike's central weakness was that a point-radius cut read 19:38, 21:18 or 00:03
// CEST for the same road depending on the buffer and the sensor mix, and it drew the
// wrong conclusion from that — that the number was unusable. The right conclusion is
// that the spread across configurations IS the answer, so this module computes a whole
// family of cut fields rather than one, and the band between them is what ships.
//
// Two structural facts keep it cheap:
//
//   * A detection is a disc, not a point. Its radius is the sensor's footprint, because
//     the fire is somewhere inside the pixel the sensor reported, not exactly at the
//     coordinate it published.
//   * Cut times do not depend on the cursor. They are a whole-window property, computed
//     once and cached, and the cursor only decides which of them have happened yet.
//
// The naive cost is detections x segments x configurations — about 49M distance tests
// for the July capture. Instead every pair is measured once at the largest radius any
// configuration will use, and each configuration is then a filter over that pair list.

import type { SensorFamilyRow } from '../../shared/egress';
import type { LatLon } from '../../shared/fires';
import { bboxOf, pointInRing, pointToSegmentMetres } from './geometry';

/**
 * Nominal detection footprint radius in metres — how far the fire could be from the
 * coordinate the sensor published.
 *
 * MTG-I1 is 1 km at the sub-satellite point, and the spike measured Iberian detections
 * at 1.34-1.59 km2 each, so the disc that certainly contains the fire is ~600 m in
 * radius. VIIRS is 375 m at nadir and larger at the swath edge; 375 is the optimistic
 * end and the sweep's radius scale is what varies it.
 */
export const SENSOR_FOOTPRINT_M: Record<string, number> = {
  MTG_I1: 600,
  VIIRS_SNPP_NRT: 375,
  VIIRS_NOAA20_NRT: 375,
  VIIRS_NOAA21_NRT: 375,
  MODIS_NRT: 1000,
  SENTINEL_3A: 1000,
  SENTINEL_3B: 1000,
};

export const DEFAULT_FOOTPRINT_M = 1000;

/**
 * The family each source belongs to.
 *
 * Several feeds are one instrument: the three VIIRS series are three satellites carrying the same
 * sensor, and counting them as three would tell a reader the capture was seen by seven instruments
 * when it was seen by four. A family is the unit a reader thinks in and the unit decision 5 names.
 *
 * A source with no entry here is its own family, which is how an unrecognised sensor stays visible
 * in the breakdown rather than being folded into the default footprint's family.
 */
export const SENSOR_FAMILY: Record<string, string> = {
  MTG_I1: 'MTG-I1',
  VIIRS_SNPP_NRT: 'VIIRS',
  VIIRS_NOAA20_NRT: 'VIIRS',
  VIIRS_NOAA21_NRT: 'VIIRS',
  MODIS_NRT: 'MODIS',
  SENTINEL_3A: 'Sentinel-3',
  SENTINEL_3B: 'Sentinel-3',
};

/**
 * A table lookup that cannot reach the prototype chain.
 *
 * `TABLE[source]` on an object literal answers for `source = 'constructor'` with the `Object`
 * function, and for `'__proto__'` with `Object.prototype`. Both are truthy, so a `?? fallback`
 * never fires and the value flows on — as a family name that is not a string, or, at
 * `SENSOR_RADIUS`, as `Object * scale = NaN`. Every `distanceM > NaN` is false, so a detection from
 * such a source would be treated as reaching every road segment in the graph. The source strings
 * come from the capture, which makes these lookups run over data rather than over a closed set of
 * literals — a difference `??` does not see.
 */
function ownLookup<T>(table: Record<string, T>, key: string): T | undefined {
  return Object.hasOwn(table, key) ? table[key] : undefined;
}

/** The family a source belongs to, or the source itself when it is not a known one. */
export function familyOf(source: string): string {
  return ownLookup(SENSOR_FAMILY, source) ?? source;
}

/** Every family the footprint table knows, in a stable order. */
export function knownFamilies(): string[] {
  return [...new Set(Object.values(SENSOR_FAMILY))].sort();
}

/**
 * What each sensor family contributed to the field, one row per family.
 *
 * Per family rather than per source, and every known family appears even when the capture carries
 * none of it — the same posture the mask takes on an empty field. A family absent from the list
 * would be indistinguishable from a family whose detections never reached a road, and the whole
 * point of publishing this is that an absent family be visible rather than implied.
 *
 * Two input properties this relies on and does not enforce, stated because a violation is silent:
 *
 *   * Detection ids are UNIQUE. `sourceOf` is last-write-wins while `detectionsByFamily` counts
 *     entries, so a repeated id credits one detection to two families; the partition check in the
 *     response test cannot see it, because the total is unchanged. `detectionsFromCapture` does not
 *     deduplicate, and the committed capture has none.
 *   * `usedDetectionIds` are ids drawn from `detections`. One that names no detection is dropped
 *     without a counter, on the argument that the caller's own list is where it came from — the
 *     evidence side does carry a counter, because there the ids come from a different place (the
 *     cut field's per-segment citations) and the two can drift apart. Reachable only by a caller
 *     that does not take its used list from `cutField`.
 */
export function sensorFamilyRows(
  detections: Detection[],
  usedDetectionIds: string[],
  evidencePerSegment: string[][],
): { rows: SensorFamilyRow[]; unattributedCutSegments: number } {
  const sourceOf = new Map<string, string>();
  const sourcesByFamily = new Map<string, Set<string>>();
  const detectionsByFamily = new Map<string, number>();
  for (const d of detections) {
    // Coerced, because `Detection.source` is typed `string` but arrives from the capture
    // unvalidated — the loader normalises `confidence` and passes `source` through — and every
    // lookup below keys on it. Uncoerced, a numeric source missed `ownLookup`, came back unchanged,
    // and put a number where `SensorFamilyRow.family` declares a string. The prototype route was
    // closed; this is the type route, which the prototype guard does not cover.
    const source = typeof d.source === 'string' ? d.source : String(d.source);
    sourceOf.set(d.id, source);
    const family = familyOf(source);
    if (!sourcesByFamily.has(family)) sourcesByFamily.set(family, new Set());
    sourcesByFamily.get(family)!.add(source);
    detectionsByFamily.set(family, (detectionsByFamily.get(family) ?? 0) + 1);
  }

  // De-duplicated by id. The pipeline builds this list from a `Set` so it is unique today, but the
  // uniqueness is a property of the caller's input and this function is exported — a repeated id
  // would otherwise report a family as having used more detections than the capture holds.
  const usedByFamily = new Map<string, number>();
  for (const id of new Set(usedDetectionIds)) {
    const source = sourceOf.get(id);
    if (source === undefined) continue;
    const family = familyOf(source);
    usedByFamily.set(family, (usedByFamily.get(family) ?? 0) + 1);
  }

  // Counted as (family, segment) pairs. A segment attained by two feeds of one family is one cut
  // for that family: summing per source would count the same road twice and inflate exactly the
  // family with the most feeds, which is VIIRS.
  const cutsByFamily = new Map<string, Set<number>>();
  let unattributedCutSegments = 0;
  for (let segment = 0; segment < evidencePerSegment.length; segment++) {
    const ids = evidencePerSegment[segment] ?? [];
    // No evidence at all is a segment the fire never cut, which is not an omission — the array
    // covers every segment, and only the cut ones cite anything.
    if (ids.length === 0) continue;

    const families = new Set<string>();
    for (const id of ids) {
      const source = sourceOf.get(id);
      if (source !== undefined) families.add(familyOf(source));
    }
    if (families.size === 0) {
      // A segment carrying evidence that names no detection the capture holds: the cut exists and
      // belongs to no family. Counted rather than dropped, so a reader can tell "no unattributable
      // cuts" from "the response does not say" — and so a capture whose ids stopped matching its
      // detections shows up as this number moving rather than as families quietly reading low.
      unattributedCutSegments += 1;
      continue;
    }
    for (const family of families) {
      if (!cutsByFamily.has(family)) cutsByFamily.set(family, new Set());
      cutsByFamily.get(family)!.add(segment);
    }
  }

  // Every family the table knows, plus any the capture carries that the table does not — those
  // keep their own name, so an unrecognised instrument shows up as itself.
  const families = [...new Set([...knownFamilies(), ...sourcesByFamily.keys()])].sort();
  // Frozen, because the context that holds these is cached and every response hands them out —
  // the same reason `buildSegments` freezes its own.
  const rows = Object.freeze(
    families.map((family) =>
      Object.freeze({
        family,
        sources: Object.freeze([...(sourcesByFamily.get(family) ?? [])].sort()) as unknown as string[],
        detections: detectionsByFamily.get(family) ?? 0,
        usedDetections: usedByFamily.get(family) ?? 0,
        cutSegments: cutsByFamily.get(family)?.size ?? 0,
      }),
    ),
  ) as SensorFamilyRow[];
  return { rows, unattributedCutSegments };
}

/** Geostationary versus polar — the axis that actually moves the answer. */
export const GEO_SOURCES = new Set(['MTG_I1']);
export function isPolar(source: string): boolean {
  return !GEO_SOURCES.has(source);
}

export type SourceSet = 'all' | 'geo+polar' | 'geo' | 'polar';

export interface Detection {
  id: string;
  lat: number;
  lon: number;
  /** Seconds since the scenario origin. Integer. */
  atSeconds: number;
  source: string;
  confidence: number | null;
  clusterId: string | null;
}

export interface SweepConfig {
  id: string;
  /** Printed beside the number; the reader must be able to tell what produced it. */
  label: string;
  sources: SourceSet;
  radiusScale: number;
  /**
   * When set, every detection uses this radius instead of its sensor footprint.
   * This is how the spike's sensitivity table is expressed — a plain buffer radius,
   * identical for every sensor — and reproducing that table is how the mask is
   * verified against the published numbers.
   */
  fixedRadiusM?: number;
  minConfidence: number | null;
  /**
   * Whether persistent industrial heat is left in the mask. Normally false: the
   * archive carries gas flares near Gallardos, and a mask built from raw detections
   * would cut a road on one.
   */
  includeStaticHeatSources: boolean;
}

export const SENSOR_RADIUS = (source: string, scale: number): number =>
  (ownLookup(SENSOR_FOOTPRINT_M, source) ?? DEFAULT_FOOTPRINT_M) * scale;

/** The radius this configuration applies to a detection from `source`. */
export function radiusFor(config: SweepConfig, source: string): number {
  return config.fixedRadiusM ?? SENSOR_RADIUS(source, config.radiusScale);
}

/** The largest radius any detection can get under this configuration. */
export function maxRadiusOf(config: SweepConfig): number {
  if (config.fixedRadiusM !== undefined) return config.fixedRadiusM;
  const coarsest = Math.max(...Object.values(SENSOR_FOOTPRINT_M), DEFAULT_FOOTPRINT_M);
  return coarsest * config.radiusScale;
}

/**
 * The largest radius the index must cover — derived from the configurations, not a magic
 * constant. An earlier version hardcoded `2000 * radiusScale`, which built four times the
 * pairs it needed and, worse, happened to be double the true maximum, which is what was
 * hiding a gap in the grid query (see `buildPairIndex`).
 */
export function maxRadiusAcross(configs: SweepConfig[]): number {
  return Math.max(0, ...configs.map(maxRadiusOf));
}

export interface Pair {
  segmentIndex: number;
  detectionIndex: number;
  distanceM: number;
}

const cellKey = (cx: number, cy: number): string => `${cx},${cy}`;

/**
 * Every (segment, detection) pair closer than `maxRadiusM`, measured once.
 *
 * A uniform grid: a segment is filed in every cell its own bbox touches, and a detection
 * reads the nine cells around it.
 *
 * The cell is deliberately TWICE the query radius, so the nine cells cover a square of
 * side six times the radius. Setting cellSize equal to the radius — which is the obvious
 * choice — covers exactly the radius in the worst case and relies on the degrees-to-metres
 * conversion in the index matching the WGS84 series used for measurement. It does not
 * exactly: the two differ by about 0.08%, which is enough to push a point just across a
 * cell boundary into a cell two away, and the 3x3 query then misses a pair that is
 * genuinely within the radius. That reads as a road that is never cut, which is the
 * direction that gets people killed. The cost of the larger cell is more candidates per
 * query, paid once when the index is built.
 */
export function buildPairIndex(
  segments: LatLon[][],
  detections: Detection[],
  maxRadiusM: number,
): Pair[] {
  if (maxRadiusM <= 0 || segments.length === 0 || detections.length === 0) return [];

  const all: LatLon[] = [];
  for (const s of segments) all.push(...s);
  const box = bboxOf(all);
  if (!box) return [];
  const cellSize = maxRadiusM * 2;
  const midLat = (box[1] + box[3]) / 2;
  const mPerDegLat = 110977;
  const mPerDegLon = Math.max(1, 111320 * Math.cos((midLat * Math.PI) / 180));

  // Why 2x is sufficient, stated as the condition it actually is rather than as the
  // 0.08% approximation error alone.
  //
  // The index converts degrees to metres with one scale taken at the box's mid-latitude;
  // the measurement converts at the detection's own latitude, which is the WGS84 series.
  // Writing r for the ratio of the two on the longitude axis — the larger of the two
  // axes — the 3x3 window reaches `cellSize = 2 * maxRadiusM` in the direction where the
  // detection sits at a cell edge, so a pair is missed only if r > 2. On the committed
  // data r = 0.998; r exceeds 2 only when a detection is about 45 degrees of latitude
  // away from the segment cloud's midpoint, which this graph's bbox cannot produce.
  //
  // Asserted rather than argued, because the failure is silent and points the dangerous
  // way: a missed pair is a road that is never cut. If a future graph spans a large
  // latitude range, this is the line that should stop it.
  const lonRatio = mPerDegLon / (111320 * Math.cos((box[1] * Math.PI) / 180));
  const latRatio = mPerDegLat / 110977;
  const worstRatio = Math.max(lonRatio, latRatio);
  if (worstRatio > 2) {
    throw new RangeError(
      `the pair index cannot cover a ${maxRadiusM} m radius over this bbox: the lattice and ` +
        `the distance measure disagree by a factor of ${worstRatio.toFixed(3)} across it, and ` +
        `the 3x3 cell query is only exact below 2. Split the graph by latitude or build the ` +
        `index at a larger radius.`,
    );
  }
  const originLon = box[0];
  const originLat = box[1];
  const toCell = (lon: number, lat: number): [number, number] => [
    Math.floor(((lon - originLon) * mPerDegLon) / cellSize),
    Math.floor(((lat - originLat) * mPerDegLat) / cellSize),
  ];

  const grid = new Map<string, number[]>();
  for (let i = 0; i < segments.length; i++) {
    const sb = bboxOf(segments[i]);
    if (!sb) continue;
    const [x0, y0] = toCell(sb[0], sb[1]);
    const [x1, y1] = toCell(sb[2], sb[3]);
    for (let cx = x0; cx <= x1; cx++) {
      for (let cy = y0; cy <= y1; cy++) {
        const key = cellKey(cx, cy);
        const bucket = grid.get(key);
        if (bucket) bucket.push(i);
        else grid.set(key, [i]);
      }
    }
  }

  const pairs: Pair[] = [];
  for (let d = 0; d < detections.length; d++) {
    const det = detections[d];
    const point: LatLon = { lat: det.lat, lon: det.lon };
    const [cx, cy] = toCell(det.lon, det.lat);
    const seen = new Set<number>();
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const bucket = grid.get(cellKey(cx + dx, cy + dy));
        if (!bucket) continue;
        for (const si of bucket) {
          if (seen.has(si)) continue;
          seen.add(si);
          const dist = polylineDistance(point, segments[si]);
          if (dist <= maxRadiusM) pairs.push({ segmentIndex: si, detectionIndex: d, distanceM: dist });
        }
      }
    }
  }
  return pairs;
}

function polylineDistance(p: LatLon, points: LatLon[]): number {
  if (points.length === 0) return Number.POSITIVE_INFINITY;
  if (points.length === 1) return pointToSegmentMetres(p, points[0], points[0]);
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0; i + 1 < points.length; i++) {
    const d = pointToSegmentMetres(p, points[i], points[i + 1]);
    if (d < best) best = d;
  }
  return best;
}

export interface CutField {
  configId: string;
  /** Per segment, seconds since origin; Infinity when never cut within the window. */
  cutAtSeconds: number[];
  /** Every detection achieving that minimum, so the ledger can cite them. */
  evidenceDetectionIds: string[][];
  /** Detections that passed the filter, for the "how much of the data was used" number. */
  usedDetections: number;
  /**
   * Those same detections, by id.
   *
   * The count above answers "how much of the data was used" for the whole field; the ids are what
   * lets the response answer it per sensor family, which is a question the count cannot: a family
   * whose detections never reach a road and one that reaches every road are the same number here
   * and different numbers once they are told apart.
   */
  usedDetectionIds: string[];
}

export function configAllows(config: SweepConfig, det: Detection): boolean {
  if (config.sources === 'geo' && isPolar(det.source)) return false;
  if (config.sources === 'polar' && !isPolar(det.source)) return false;
  if (config.minConfidence !== null) {
    if (det.confidence === null || det.confidence < config.minConfidence) return false;
  }
  return true;
}

/**
 * Apply one configuration to the precomputed pairs.
 *
 * The comparison is `<=`, so a detection exactly at the radius counts as reaching the
 * segment. That is the conservative direction: it cuts a road slightly early rather
 * than slightly late, and late is the direction that gets people killed.
 */
export function cutField(
  pairs: Pair[],
  detections: Detection[],
  segmentCount: number,
  config: SweepConfig,
): CutField {
  const cutAtSeconds = new Array<number>(segmentCount).fill(Number.POSITIVE_INFINITY);
  const evidence: string[][] = Array.from({ length: segmentCount }, () => []);
  const used = new Set<number>();

  for (const pair of pairs) {
    const det = detections[pair.detectionIndex];
    if (!configAllows(config, det)) continue;
    // `<=`: a detection exactly at the radius counts as reaching the segment, which
    // errs toward cutting a road early rather than late.
    if (pair.distanceM > radiusFor(config, det.source)) continue;
    used.add(pair.detectionIndex);

    const current = cutAtSeconds[pair.segmentIndex];
    if (det.atSeconds < current) {
      cutAtSeconds[pair.segmentIndex] = det.atSeconds;
      evidence[pair.segmentIndex] = [det.id];
    } else if (det.atSeconds === current) {
      // Deterministic: equal-time detections accumulate in a stable order.
      evidence[pair.segmentIndex].push(det.id);
    }
  }

  for (const list of evidence) list.sort();
  return {
    configId: config.id,
    cutAtSeconds,
    evidenceDetectionIds: evidence,
    usedDetections: used.size,
    // `used` holds indices; the response needs ids, because an index means nothing outside the
    // array it came from and the breakdown is published.
    usedDetectionIds: [...used].map((i) => detections[i].id),
  };
}

/**
 * Drop detections sitting on known persistent heat — gas flares, industry, quarries.
 * Without this a road is cut by a flare that has been burning for years: the archive
 * carries cells around 18 MW within about 20 km of Gallardos.
 *
 * Deepfire publishes these as polygons, so membership is a point-in-ring test rather
 * than a radius. A detection is dropped when it falls inside any polygon.
 *
 * Returns the surviving detections and the ones removed, because "we discarded 4
 * detections" is a number the reader is entitled to see.
 */
export function subtractStaticHeatSources(
  detections: Detection[],
  sources: LatLon[][],
): { kept: Detection[]; removed: Detection[] } {
  const rings = sources.filter((r) => r.length >= 3);
  if (rings.length === 0) return { kept: detections, removed: [] };
  const kept: Detection[] = [];
  const removed: Detection[] = [];
  for (const det of detections) {
    const point: LatLon = { lat: det.lat, lon: det.lon };
    let onSource = false;
    for (const ring of rings) {
      if (pointInRing(point, ring)) {
        onSource = true;
        break;
      }
    }
    if (onSource) removed.push(det);
    else kept.push(det);
  }
  return { kept, removed };
}


