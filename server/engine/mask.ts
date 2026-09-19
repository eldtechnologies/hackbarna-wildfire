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
  (SENSOR_FOOTPRINT_M[source] ?? DEFAULT_FOOTPRINT_M) * scale;

/** The radius this configuration applies to a detection from `source`. */
export function radiusFor(config: SweepConfig, source: string): number {
  return config.fixedRadiusM ?? SENSOR_RADIUS(source, config.radiusScale);
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
 * A uniform grid at the query radius: a segment is filed in every cell its own bbox
 * touches, and a detection reads the nine cells around it. Any segment within
 * `maxRadiusM` of the detection necessarily shares one of those nine, because
 * cellSize == maxRadiusM.
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
  const cellSize = maxRadiusM;
  const midLat = (box[1] + box[3]) / 2;
  const mPerDegLat = 110977;
  const mPerDegLon = Math.max(1, 111320 * Math.cos((midLat * Math.PI) / 180));
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
  return { configId: config.id, cutAtSeconds, evidenceDetectionIds: evidence, usedDetections: used.size };
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


