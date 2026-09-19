// Growth vector: where a cluster is heading, how fast, and what the naive
// predictors say for the same cluster.
//
// The estimate is a centroid displacement between the earlier and later half of a
// cluster's detections. Nothing else is available at serve time: one observation
// window holds detections, not a track, so the advance is inferred from how the
// detection mass moved inside that window. That is the same quantity the offline
// harness scores, which is why the baseline numbers travel with it.

import type { Hotspot, LatLon } from '../../shared/fires';
import type { GrowthVector } from '../../shared/growth';

const R_EARTH_KM = 6371.0088;

// Below this the two centroids are the same point and the bearing is noise.
const MIN_DISPLACEMENT_KM = 0.1;

function haversineKm(a: LatLon, b: LatLon): number {
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLon = ((b.lon - a.lon) * Math.PI) / 180;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((a.lat * Math.PI) / 180) *
      Math.cos((b.lat * Math.PI) / 180) *
      Math.sin(dLon / 2) ** 2;
  return 2 * R_EARTH_KM * Math.asin(Math.sqrt(h));
}

/** Degrees clockwise from north. */
function bearingDeg(a: LatLon, b: LatLon): number {
  const dLon = ((b.lon - a.lon) * Math.PI) / 180;
  const y = Math.sin(dLon) * Math.cos((b.lat * Math.PI) / 180);
  const x =
    Math.cos((a.lat * Math.PI) / 180) * Math.sin((b.lat * Math.PI) / 180) -
    Math.sin((a.lat * Math.PI) / 180) *
      Math.cos((b.lat * Math.PI) / 180) *
      Math.cos(dLon);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

/**
 * FRP-weighted centroid. A detection with no measured FRP still counts for
 * position at unit weight, so a sensor that reports no power cannot pull the
 * centroid and is not dropped either.
 */
export function weightedCentroid(detections: Hotspot[]): LatLon | null {
  let wSum = 0;
  let lonSum = 0;
  let latSum = 0;
  for (const d of detections) {
    const w = d.frpMw !== null && d.frpMw > 0 ? d.frpMw : 1;
    wSum += w;
    lonSum += d.position.lon * w;
    latSum += d.position.lat * w;
  }
  if (wSum === 0) return null;
  return { lat: latSum / wSum, lon: lonSum / wSum };
}

/** The earlier and later halves of a detection set, split on time. */
export function timeSplit(detections: Hotspot[]): [Hotspot[], Hotspot[]] | null {
  const dated = detections.filter(
    (d): d is Hotspot & { detectedAt: string } => d.detectedAt !== null,
  );
  if (dated.length < 4) return null;
  const ordered = [...dated].sort((a, b) => (a.detectedAt < b.detectedAt ? -1 : 1));
  const mid = Math.floor(ordered.length / 2);
  return [ordered.slice(0, mid), ordered.slice(mid)];
}

/**
 * Bearing and rate between two detection halves. Null when the halves are too
 * close to carry a direction, or when their timestamps do not separate.
 */
export function advanceBetween(
  earlier: Hotspot[],
  later: Hotspot[],
): { bearingDeg: number; rateKmh: number } | null {
  const a = weightedCentroid(earlier);
  const b = weightedCentroid(later);
  if (!a || !b) return null;
  const distanceKm = haversineKm(a, b);
  if (distanceKm < MIN_DISPLACEMENT_KM) return null;
  const tA = earlier.map((d) => d.detectedAt).filter((t): t is string => t !== null).sort()[0];
  const tB = later.map((d) => d.detectedAt).filter((t): t is string => t !== null).sort().slice(-1)[0];
  if (!tA || !tB) return null;
  const hours = (Date.parse(tB) - Date.parse(tA)) / 3_600_000;
  if (!Number.isFinite(hours) || hours <= 0) return null;
  return { bearingDeg: bearingDeg(a, b), rateKmh: distanceKm / hours };
}

export function sourceMixOf(detections: Hotspot[]): Record<string, number> {
  const mix: Record<string, number> = {};
  for (const d of detections) {
    // `satellite` is the schema's own source field, e.g. 'MTG_I1'. An undated or
    // unnamed detection is counted as unknown rather than folded into a real sensor.
    const key = d.satellite ?? 'unknown';
    mix[key] = (mix[key] ?? 0) + 1;
  }
  return mix;
}

/** Hours since the most recent detection, or null when none is dated. */
export function hoursSinceLastDetection(detections: Hotspot[], now: Date): number | null {
  const stamps = detections
    .map((d) => d.detectedAt)
    .filter((t): t is string => t !== null)
    .map((t) => Date.parse(t))
    .filter(Number.isFinite);
  if (stamps.length === 0) return null;
  return (now.getTime() - Math.max(...stamps)) / 3_600_000;
}

/**
 * The observed growth vector for a cluster. `bearingDeg` and `rateKmh` are null
 * when the detections cannot carry a direction, which is an honest absence and
 * not a zero.
 */
export function observedGrowth(
  clusterId: string,
  detections: Hotspot[],
  now: Date,
): GrowthVector {
  const split = timeSplit(detections);
  const advance = split ? advanceBetween(split[0], split[1]) : null;
  return {
    clusterId,
    at: now.toISOString(),
    predictor: 'observed',
    bearingDeg: advance?.bearingDeg ?? null,
    rateKmh: advance?.rateKmh ?? null,
    detections: detections.length,
    sourceMix: sourceMixOf(detections),
    hoursSinceLastDetection: hoursSinceLastDetection(detections, now),
  };
}
