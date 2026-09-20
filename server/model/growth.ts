// Growth vector: where a cluster is heading, how fast, and what the naive
// predictors say for the same cluster.
//
// The estimate is a centroid displacement between the earlier and later half of a
// cluster's detections. Nothing else is available at serve time: one observation
// window holds detections, not a track, so the advance is inferred from how the
// detection mass moved inside that window.

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
 * position at unit weight, so missing power does not drop a
 * detected position.
 */
export function weightedCentroid(detections: Hotspot[]): LatLon | null {
  let wSum = 0;
  let lonSum = 0;
  let latSum = 0;
  for (const d of detections) {
    const w = positionWeight(d);
    wSum += w;
    lonSum += d.position.lon * w;
    latSum += d.position.lat * w;
  }
  if (wSum === 0) return null;
  return { lat: latSum / wSum, lon: lonSum / wSum };
}

const positionWeight = (d: Hotspot): number => d.frpMw !== null && d.frpMw > 0 ? d.frpMw : 1;

function datedDetections(detections: Hotspot[]): { detection: Hotspot; time: number }[] {
  return detections.flatMap((detection) => {
    const time = detection.detectedAt === null ? NaN : Date.parse(detection.detectedAt);
    return Number.isFinite(time) ? [{ detection, time }] : [];
  });
}

/** The earlier and later halves of a detection set, split on time. */
export function timeSplit(detections: Hotspot[]): [Hotspot[], Hotspot[]] | null {
  const dated = datedDetections(detections);
  if (dated.length < 4) return null;
  const ordered = dated.sort((a, b) => a.time - b.time).map((d) => d.detection);
  const mid = Math.floor(ordered.length / 2);
  return [ordered.slice(0, mid), ordered.slice(mid)];
}

/**
 * Bearing and rate between two detection halves. Null when the halves are too
 * close to carry a direction, or when their timestamps do not separate.
 *
 * The rate divides the centroid displacement by the separation of the two
 * half-centroids, not by the window's first-to-last span. Each centroid carries
 * the FRP-weighted mean time of its own detections, so dividing by the full span (which reaches
 * past both centroids) under-reports the rate — roughly half, on evenly spread
 * halves. The displacement and the interval must describe the same two instants.
 */
export function advanceBetween(
  earlier: Hotspot[],
  later: Hotspot[],
): { bearingDeg: number; rateKmh: number } | null {
  earlier = datedDetections(earlier).map((d) => d.detection);
  later = datedDetections(later).map((d) => d.detection);
  const a = weightedCentroid(earlier);
  const b = weightedCentroid(later);
  if (!a || !b) return null;
  const distanceKm = haversineKm(a, b);
  if (distanceKm < MIN_DISPLACEMENT_KM) return null;
  const tA = meanStampMs(earlier);
  const tB = meanStampMs(later);
  if (tA === null || tB === null) return null;
  const hours = (tB - tA) / 3_600_000;
  if (!Number.isFinite(hours) || hours <= 0) return null;
  return { bearingDeg: bearingDeg(a, b), rateKmh: distanceKm / hours };
}

/** Epoch milliseconds of the dated detections, dropping unparseable stamps. */
function epochStamps(detections: Hotspot[]): number[] {
  return datedDetections(detections).map((d) => d.time);
}

/** Time centroid with the same weights as the spatial centroid. */
function meanStampMs(detections: Hotspot[]): number | null {
  const dated = datedDetections(detections);
  if (dated.length === 0) return null;
  const weight = dated.reduce((sum, d) => sum + positionWeight(d.detection), 0);
  return dated.reduce((sum, d) => sum + d.time * positionWeight(d.detection), 0) / weight;
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
  const stamps = epochStamps(detections);
  if (stamps.length === 0) return null;
  // A detection dated in the future (clock skew, an accelerated mock clock) is not
  // "hours ago"; the honest floor is zero rather than a negative age.
  return Math.max(0, (now.getTime() - Math.max(...stamps)) / 3_600_000);
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
    rateBasis: 'detection_centroid_drift',
    detections: detections.length,
    sourceMix: sourceMixOf(detections),
    hoursSinceLastDetection: hoursSinceLastDetection(detections, now),
  };
}
