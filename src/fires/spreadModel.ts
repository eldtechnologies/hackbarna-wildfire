// Spread model: groups the normalized FiresResponse into one FireCase per
// cluster (latest observed perimeter + its future spread steps) and
// interpolates the perimeter at any time offset. The Deepfire spread polygons
// are precomputed by the provider; the wind direction is not part of the
// schema, so the case exposes the bearing derived from the centroid drift
// between the observed perimeter and the furthest projection.

import type {
  FireCluster,
  FirePerimeter,
  FiresResponse,
  LatLon,
  SpreadStep,
} from '../../shared/fires';
import { bearingDeg, lerpRings, ringAreaKm2, ringCentroid } from './geometry';

export interface FireCase {
  cluster: FireCluster;
  /** Observed perimeter (latest one when the provider sends several). */
  basePerimeter: AnchoredPerimeter;
  /** Future projections sorted by horizonHours ascending, >= 1h. */
  steps: SpreadStep[];
  /** Highest projected horizon in hours, 0 when no steps exist. */
  maxHorizonHours: number;
  /** Centroid of the base perimeter. */
  centroid: LatLon;
  /** Centroid drift toward the furthest projection, null when no steps. */
  driftBearingDeg: number | null;
  areaKm2: number;
}

export interface Projection {
  /** Interpolated ring at the requested offset, clamped to [0, maxHorizon]. */
  polygon: LatLon[];
  /** ISO time the projection refers to, base observation + offset. */
  validAt: string;
  areaKm2: number;
}
/** Perimeter with the two fields the spread model cannot work without. */
type AnchoredPerimeter = FirePerimeter & { clusterId: string; observedAt: string };

// A perimeter with no owning cluster or no observation time cannot anchor
// time-based projections, so it is dropped here rather than carried as a guess.
function isAnchored(p: FirePerimeter): p is AnchoredPerimeter {
  return p.clusterId != null && p.observedAt != null;
}

export function buildFireCases(response: FiresResponse): FireCase[] {
  const clustersById = new Map(response.clusters.map((c) => [c.id, c]));

  const latestPerimeterByCluster = new Map<string, AnchoredPerimeter>();
  for (const p of response.perimeters) {
    if (!isAnchored(p)) continue;
    const current = latestPerimeterByCluster.get(p.clusterId);
    if (!current || p.observedAt > current.observedAt) {
      latestPerimeterByCluster.set(p.clusterId, p);
    }
  }

  const stepsByCluster = new Map<string, SpreadStep[]>();
  for (const s of response.spread) {
    if (s.horizonHours <= 0) continue;
    const list = stepsByCluster.get(s.clusterId) ?? [];
    list.push(s);
    stepsByCluster.set(s.clusterId, list);
  }

  const cases: FireCase[] = [];
  for (const [clusterId, perimeter] of latestPerimeterByCluster) {
    const cluster = clustersById.get(clusterId);
    if (!cluster || perimeter.polygon.length < 4) continue;
    const steps = (stepsByCluster.get(clusterId) ?? []).sort(
      (a, b) => a.horizonHours - b.horizonHours,
    );
    const centroid = ringCentroid(perimeter.polygon);
    const driftBearingDeg =
      steps.length > 0
        ? bearingDeg(centroid, ringCentroid(steps[steps.length - 1].polygon))
        : null;
    cases.push({
      cluster,
      basePerimeter: perimeter,
      steps,
      maxHorizonHours: steps.length > 0 ? steps[steps.length - 1].horizonHours : 0,
      centroid,
      driftBearingDeg,
      areaKm2:
        perimeter.areaKm2 != null && perimeter.areaKm2 > 0
          ? perimeter.areaKm2
          : ringAreaKm2(perimeter.polygon),
    });
  }
  return cases;
}

/**
 * Interpolated perimeter at `hours` after the base observation. Exact rings at
 * step horizons, lerped rings between them, the base perimeter below the
 * first horizon and the last ring above the final one.
 */
export function projectAt(caseData: FireCase, hours: number): Projection {
  const clamped = Math.min(Math.max(hours, 0), caseData.maxHorizonHours);
  const base = caseData.basePerimeter;
  const validAt = new Date(
    new Date(base.observedAt).getTime() + clamped * 3_600_000,
  ).toISOString();

  if (clamped <= 0 || caseData.steps.length === 0) {
    return { polygon: base.polygon, validAt, areaKm2: caseData.areaKm2 };
  }

  // Exact or interpolated bracket around the clamped offset.
  let prev = { ring: base.polygon, hours: 0, area: caseData.areaKm2 };
  for (const step of caseData.steps) {
    if (clamped === step.horizonHours) {
      return {
        polygon: step.polygon,
        validAt,
        areaKm2: ringAreaKm2(step.polygon),
      };
    }
    if (clamped < step.horizonHours) {
      const span = step.horizonHours - prev.hours;
      const t = span > 0 ? (clamped - prev.hours) / span : 0;
      const ring = lerpRings(prev.ring, step.polygon, t);
      return { polygon: ring, validAt, areaKm2: ringAreaKm2(ring) };
    }
    prev = { ring: step.polygon, hours: step.horizonHours, area: ringAreaKm2(step.polygon) };
  }
  return { polygon: prev.ring, validAt, areaKm2: prev.area };
}
