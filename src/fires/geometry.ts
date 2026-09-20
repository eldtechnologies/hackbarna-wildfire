// Pure ring math for fire perimeters. A ring is an array of {lat, lon} points,
// first point repeated at the end (schema convention). All functions here are
// framework-free so spreadModel stays testable and cheap.

import type { LatLon } from '../../shared/fires';

export function closeRing(points: LatLon[]): LatLon[] {
  if (points.length < 3) return points.slice();
  const first = points[0];
  const last = points[points.length - 1];
  if (first.lat === last.lat && first.lon === last.lon) return points.slice();
  return [...points, { lat: first.lat, lon: first.lon }];
}

export function ringCentroid(points: LatLon[]): LatLon {
  if (points.length === 0) return { lat: 0, lon: 0 };
  let lat = 0;
  let lon = 0;
  // The closing vertex is the first vertex again, not extra geometry.
  const closed = points.length > 1 && points[0].lat === points.at(-1)!.lat && points[0].lon === points.at(-1)!.lon;
  const vertices = closed ? points.slice(0, -1) : points;
  for (const p of vertices) {
    lat += p.lat;
    lon += p.lon;
  }
  return { lat: lat / vertices.length, lon: lon / vertices.length };
}

// Resample a ring into `count` evenly spaced (by arc length in degrees)
// points, starting the walk at the point farthest along the dominant axis of
// drift between the two rings. This keeps rings with different point counts
// and different starting vertices comparable for lerp.
function resampleRing(points: LatLon[], count: number): LatLon[] {
  const ring = closeRing(points);
  const out: LatLon[] = [];
  if (ring.length < 3) return ring;

  // Segment arc lengths in a naive equirectangular metric, fine at the few-km
  // scale of a fire perimeter.
  const lengths: number[] = [];
  let total = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    const d = Math.hypot(ring[i + 1].lon - ring[i].lon, ring[i + 1].lat - ring[i].lat);
    lengths.push(d);
    total += d;
  }
  if (total === 0) {
    for (let i = 0; i < count; i++) out.push(ring[0]);
    return out;
  }

  let seg = 0;
  let consumed = 0;
  for (let k = 0; k < count; k++) {
    const target = (k / count) * total;
    while (seg < lengths.length - 1 && consumed + lengths[seg] < target) {
      consumed += lengths[seg];
      seg++;
    }
    const segLen = lengths[seg] || 1;
    const t = Math.min(1, Math.max(0, (target - consumed) / segLen));
    out.push(lerpPoint(ring[seg], ring[seg + 1], t));
  }
  return out;
}

function lerpPoint(a: LatLon, b: LatLon, t: number): LatLon {
  return { lat: a.lat + (b.lat - a.lat) * t, lon: a.lon + (b.lon - a.lon) * t };
}

// Interpolate between two rings at parameter t in [0, 1]. Both rings are
// resampled to a common point count and rotated so their walks start at the
// point pair that best preserves the drift direction, then lerped per vertex.
export function lerpRings(a: LatLon[], b: LatLon[], t: number): LatLon[] {
  const count = Math.max(a.length, b.length, 16);
  const ra = resampleRing(a, count);
  const rb = resampleRing(b, count);
  const rot = bestRotation(ra, rb);
  const out: LatLon[] = [];
  for (let i = 0; i < count; i++) {
    const j = (i + rot) % count;
    out.push(lerpPoint(ra[i], rb[j], t));
  }
  return closeRing(out);
}

// Choose the rotation offset of ring b that minimizes the sum of squared
// distances between paired vertices. O(n^2) with n ~ 16-64 is fine here.
function bestRotation(a: LatLon[], b: LatLon[]): number {
  const n = a.length;
  let bestOffset = 0;
  let bestCost = Infinity;
  for (let offset = 0; offset < n; offset++) {
    let cost = 0;
    for (let i = 0; i < n; i++) {
      const p = b[(i + offset) % n];
      const d = Math.hypot(p.lon - a[i].lon, p.lat - a[i].lat);
      cost += d * d;
      if (cost >= bestCost) break;
    }
    if (cost < bestCost) {
      bestCost = cost;
      bestOffset = offset;
    }
  }
  return bestOffset;
}

// Shoelace area with local km scaling around the ring centroid. Accurate
// enough for perimeters under a few hundred km.
export function ringAreaKm2(points: LatLon[]): number {
  const ring = closeRing(points);
  if (ring.length < 4) return 0;
  const c = ringCentroid(ring);
  const kmPerDegLat = 111.32;
  const kmPerDegLon = 111.32 * Math.cos((c.lat * Math.PI) / 180);
  let sum = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    const x1 = (ring[i].lon - c.lon) * kmPerDegLon;
    const y1 = (ring[i].lat - c.lat) * kmPerDegLat;
    const x2 = (ring[i + 1].lon - c.lon) * kmPerDegLon;
    const y2 = (ring[i + 1].lat - c.lat) * kmPerDegLat;
    sum += x1 * y2 - x2 * y1;
  }
  return Math.abs(sum) / 2;
}

// Compass bearing (degrees from north, clockwise) from a to b.
export function bearingDeg(a: LatLon, b: LatLon): number {
  const rad = Math.PI / 180;
  const dLon = (b.lon - a.lon) * rad;
  const lat1 = a.lat * rad;
  const lat2 = b.lat * rad;
  const y = Math.sin(dLon) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  return (Math.atan2(y, x) / rad + 360) % 360;
}

export function compassLabel(bearing: number): string {
  const dirs = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
  const idx = Math.round(bearing / 22.5) % 16;
  return dirs[idx];
}
