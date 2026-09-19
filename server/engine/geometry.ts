// Planar geometry for the cut-time mask and the route walk.
//
// No dependency. Everything here is point-to-segment distance and length, which is
// a dozen lines, and adding a geometry library would buy nothing while importing the
// hoisting hazard PR #10's review flagged (@turf/helpers imported but undeclared).
//
// Distances are metres, never degrees. A degrees-vs-metres comparison silently
// "passes" every radius expressed in metres, so a caller comparing `distDeg <= rMetres`
// gets `true` for every pair and the mask paints the whole province.
//
// The projection is equirectangular about the *query point's* latitude, not a global
// origin. Over the distances the mask tests (≤ ~2 km) the residual error is under a
// metre; a single global origin 30 km away would carry ~100 m, which is half the
// radius we care about.

import type { LatLon } from '../../shared/fires';

const DEG = Math.PI / 180;

/** Metres per degree of latitude at `lat` (WGS84 meridional arc, truncated series). */
function metresPerDegLat(lat: number): number {
  const p = lat * DEG;
  return 111132.92 - 559.82 * Math.cos(2 * p) + 1.175 * Math.cos(4 * p) - 0.0023 * Math.cos(6 * p);
}

/** Metres per degree of longitude at `lat` (WGS84 parallel arc, truncated series). */
function metresPerDegLon(lat: number): number {
  const p = lat * DEG;
  return 111412.84 * Math.cos(p) - 93.5 * Math.cos(3 * p) + 0.118 * Math.cos(5 * p);
}

export interface MetrePoint {
  x: number;
  y: number;
}

/**
 * Distance in metres from a point to a segment, using a local frame centred on the
 * query point. Accuracy is worst at the far end of the segment, where the latitude
 * difference changes the longitude scale; at 2 km that is under a metre.
 */
export function pointToSegmentMetres(p: LatLon, a: LatLon, b: LatLon): number {
  const mpdLat = metresPerDegLat(p.lat);
  const mpdLon = metresPerDegLon(p.lat);
  const ax = (a.lon - p.lon) * mpdLon;
  const ay = (a.lat - p.lat) * mpdLat;
  const bx = (b.lon - p.lon) * mpdLon;
  const by = (b.lat - p.lat) * mpdLat;
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(ax, ay); // degenerate segment: distance to the vertex
  // Project the origin onto the segment and clamp to its extent.
  const t = Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2));
  return Math.hypot(ax + t * dx, ay + t * dy);
}

/** Shortest distance from a point to a polyline, in metres. */
export function polylineDistanceMetres(p: LatLon, points: LatLon[]): number {
  if (points.length === 0) return Number.POSITIVE_INFINITY;
  if (points.length === 1) return pointToSegmentMetres(p, points[0], points[0]);
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0; i + 1 < points.length; i++) {
    const d = pointToSegmentMetres(p, points[i], points[i + 1]);
    if (d < best) best = d;
  }
  return best;
}

/** Length of a polyline in metres. */
export function polylineLengthMetres(points: LatLon[]): number {
  let total = 0;
  const origin = points[0];
  if (!origin) return 0;
  const mpdLat = metresPerDegLat(origin.lat);
  const mpdLon = metresPerDegLon(origin.lat);
  for (let i = 0; i + 1 < points.length; i++) {
    const dx = (points[i + 1].lon - points[i].lon) * mpdLon;
    const dy = (points[i + 1].lat - points[i].lat) * mpdLat;
    total += Math.hypot(dx, dy);
  }
  return total;
}

export function metresBetween(a: LatLon, b: LatLon): number {
  return pointToSegmentMetres(a, b, b);
}

export type Bbox = [west: number, south: number, east: number, north: number];

export function bboxOf(points: LatLon[]): Bbox | null {
  if (points.length === 0) return null;
  let w = points[0].lon;
  let e = points[0].lon;
  let s = points[0].lat;
  let n = points[0].lat;
  for (const p of points) {
    if (p.lon < w) w = p.lon;
    if (p.lon > e) e = p.lon;
    if (p.lat < s) s = p.lat;
    if (p.lat > n) n = p.lat;
  }
  return [w, s, e, n];
}

export function bboxUnion(a: Bbox, b: Bbox): Bbox {
  return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
}

/** Pad a bbox by `metres` on every side. */
export function bboxPad(box: Bbox, metres: number): Bbox {
  const midLat = (box[1] + box[3]) / 2;
  const dLat = metres / metresPerDegLat(midLat);
  const dLon = metres / metresPerDegLon(midLat);
  return [box[0] - dLon, box[1] - dLat, box[2] + dLon, box[3] + dLat];
}

export function bboxContains(box: Bbox, p: LatLon): boolean {
  return p.lon >= box[0] && p.lon <= box[2] && p.lat >= box[1] && p.lat <= box[3];
}

/** CAP requires a closed ring of at least four positions; anything less is not a polygon. */
export function ringIsClosed(ring: LatLon[]): boolean {
  if (ring.length < 4) return false;
  const first = ring[0];
  const last = ring[ring.length - 1];
  return first.lat === last.lat && first.lon === last.lon;
}

/**
 * Signed area in square metres (positive = counter-clockwise), useful for detecting
 * a reversed winding between two rings that need to be interpolated together.
 */
export function ringSignedAreaM2(ring: LatLon[]): number {
  if (ring.length < 3) return 0;
  const mpdLat = metresPerDegLat(ring[0].lat);
  const mpdLon = metresPerDegLon(ring[0].lat);
  let twice = 0;
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i];
    const q = ring[(i + 1) % ring.length];
    twice += p.lon * mpdLon * (q.lat * mpdLat) - q.lon * mpdLon * (p.lat * mpdLat);
  }
  return twice / 2;
}
