// Threat ring analysis: for one fire, which bundled infrastructure assets fall
// inside the perimeter, inside the 5/10/20 km buffer rings, or inside the
// projected spread corridor. All geometry runs server-side with turf.

import along from '@turf/along';
import booleanPointInPolygon from '@turf/boolean-point-in-polygon';
import buffer from '@turf/buffer';
import { featureCollection, lineString, point, polygon } from '@turf/helpers';
import distance from '@turf/distance';
import length from '@turf/length';
import pointToLineDistance from '@turf/point-to-line-distance';
import union from '@turf/union';
import type { Feature, Polygon, MultiPolygon } from 'geojson';
import { getFires } from './providers';
import { getInfrastructure } from './infrastructure';
import type { FirePerimeter, FiresResponse, LatLon } from '../shared/fires';
import type { ThreatRing, ThreatsResponse } from '../shared/threats';
import { RING_RADII_KM, RING_SEVERITY } from '../shared/threats';

// The one perimeter pick used everywhere a fire's current polygon matters
// (threat rings, situation packet): the most recently observed one.
export function latestPerimeter(fires: FiresResponse, fireId: string): FirePerimeter | null {
  let latest: FirePerimeter | null = null;
  for (const p of fires.perimeters) {
    if (p.clusterId !== fireId) continue;
    if (!latest || (p.observedAt ?? '') > (latest.observedAt ?? '')) {
      latest = p;
    }
  }
  return latest;
}

function turfPoint(p: LatLon) {
  return point([p.lon, p.lat]);
}

function perimeterPolygon(ring: LatLon[]): Feature<Polygon> {
  return polygon([ring.map((p) => [p.lon, p.lat])]);
}

function perimeterLine(ring: LatLon[]) {
  return lineString(ring.map((p) => [p.lon, p.lat]));
}

// Tiny disc around a point, so point-in-polygon tests still work for fires
// that have no observed perimeter yet.
function pointDisc(p: LatLon, radiusKm = 0.05): Feature<Polygon> {
  return buffer(turfPoint(p), radiusKm, { units: 'kilometers' }) as Feature<Polygon>;
}

// Union of the fire's future spread-step polygons (horizon > 0). Null when
// the fire has no projected spread, so corridor tests are skipped. The
// polygons can be disjoint (a fire splitting over time), so the result is
// Polygon | MultiPolygon.
function spreadCorridor(
  clusterId: string,
  steps: { clusterId: string; horizonHours: number; polygon: LatLon[] }[],
): Feature<Polygon | MultiPolygon> | null {
  const polys = steps
    .filter((s) => s.clusterId === clusterId && s.horizonHours > 0 && s.polygon.length >= 4)
    .map((s) => perimeterPolygon(s.polygon));
  if (polys.length === 0) return null;
  if (polys.length === 1) return polys[0];
  return union(featureCollection(polys)) as Feature<Polygon | MultiPolygon>;
}

// Power lines span kilometers, so the midpoint alone can hide a span that
// crosses a ring. Sample the path every SAMPLE_STEP_KM and take the most
// severe ring (and its distance) across all samples.
const SAMPLE_STEP_KM = 0.5;

function powerLineThreat(
  path: LatLon[],
  perim: Feature<Polygon>,
  ringPolys: Feature<Polygon>[],
): { ring: ThreatRing | null; distanceKm: number } {
  const line = lineString(path.map((p) => [p.lon, p.lat]));
  const perimLine = lineString(perim.geometry.coordinates[0] as [number, number][]);
  const totalKm = length(line, { units: 'kilometers' });
  const steps = Math.max(1, Math.ceil(totalKm / SAMPLE_STEP_KM));

  let best: { ring: ThreatRing | null; distanceKm: number } = { ring: null, distanceKm: Infinity };
  for (let i = 0; i <= steps; i++) {
    const alongPt = along(line, (i / steps) * totalKm, { units: 'kilometers' });
    const pt = point(alongPt.geometry.coordinates);

    let ring: ThreatRing | null = null;
    let distanceKm: number;
    if (booleanPointInPolygon(pt, perim)) {
      ring = 'inside';
      distanceKm = 0;
    } else {
      distanceKm = pointToLineDistance(pt, perimLine, { units: 'kilometers' });
      for (let r = 0; r < ringPolys.length; r++) {
        if (booleanPointInPolygon(pt, ringPolys[r])) {
          ring = RING_RADII_KM[r].ring;
          break;
        }
      }
    }
    if (!ring) continue;

    const better =
      best.ring === null ||
      RING_SEVERITY[ring] < RING_SEVERITY[best.ring] ||
      (ring === best.ring && distanceKm < best.distanceKm);
    if (better) best = { ring, distanceKm };
  }
  return best;
}

// Per-fire TTL cache: /api/threats and /api/situation both run the same turf
// analysis over the same infrastructure data, so a selection pays for it once
// per window instead of twice per click. The key is fireId@fires.fetchedAt,
// stable while the fires memoization window (providers/index.ts) holds; a new
// snapshot stamps a new fetchedAt, so the key changes and the analysis
// recomputes rather than pairing stale geometry with a fresh packet.
const THREATS_CACHE_TTL_MS = 60000;
const threatsCache = new Map<string, { value: ThreatsResponse; expiresAt: number }>();

function threatsCacheKey(fireId: string, fires: FiresResponse): string {
  return `${fireId}@${fires.fetchedAt}`;
}

export async function getThreats(
  fireId: string,
  fires?: FiresResponse,
): Promise<ThreatsResponse | null> {
  const firesSnapshot = fires ?? (await getFires());
  const key = threatsCacheKey(fireId, firesSnapshot);
  const cached = threatsCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const value = await computeThreats(fireId, firesSnapshot);
  if (value) {
    threatsCache.set(key, { value, expiresAt: Date.now() + THREATS_CACHE_TTL_MS });
  }
  return value;
}

async function computeThreats(
  fireId: string,
  fires?: FiresResponse,
): Promise<ThreatsResponse | null> {
  fires = fires ?? (await getFires());
  const cluster = fires.clusters.find((c) => c.id === fireId);
  if (!cluster) return null;

  const perimeter = latestPerimeter(fires, fireId);
  const hasPerimeter = perimeter != null;
  const center = perimeter ? perimeterPolygon(perimeter.polygon) : pointDisc(cluster.centroid);
  const centerLine = perimeter ? perimeterLine(perimeter.polygon) : null;

  const ringPolys = RING_RADII_KM.map(({ radiusKm }) =>
    buffer(center, radiusKm, { units: 'kilometers' }) as Feature<Polygon>,
  );

  const corridor = spreadCorridor(
    fireId,
    fires.spread.map((s) => ({
      clusterId: s.clusterId,
      horizonHours: s.horizonHours,
      polygon: s.polygon,
    })),
  );

  const { assets, powerLinePaths } = await getInfrastructure();
  const threatened: ThreatsResponse['threatened'] = [];

  for (const asset of assets) {
    let ring: ThreatRing | null = null;
    let distanceKm: number;

    if (asset.category === 'power-line') {
      const path = powerLinePaths[asset.id];
      if (!path) continue;
      const res = powerLineThreat(path, center, ringPolys);
      ring = res.ring;
      distanceKm = res.distanceKm;
    } else {
      const pt = turfPoint(asset.position);
      if (booleanPointInPolygon(pt, center)) {
        ring = 'inside';
        distanceKm = 0;
      } else {
        for (let r = 0; r < ringPolys.length; r++) {
          if (booleanPointInPolygon(pt, ringPolys[r])) {
            ring = RING_RADII_KM[r].ring;
            break;
          }
        }
        // With a perimeter the distance is to the perimeter edge; without
        // one (perimeter-less fire), it is the straight-line distance to the
        // cluster centroid.
        distanceKm =
          ring != null && centerLine != null
            ? pointToLineDistance(pt, centerLine, { units: 'kilometers' })
            : distance(pt, turfPoint(cluster.centroid), { units: 'kilometers' });
      }
    }

    if (ring == null) continue;

    const inCorridor = corridor != null && booleanPointInPolygon(turfPoint(asset.position), corridor);

    threatened.push({
      assetId: asset.id,
      name: asset.name,
      category: asset.category,
      ring,
      distanceKm: Math.round(distanceKm * 10) / 10,
      inSpreadCorridor: inCorridor,
    });
  }

  threatened.sort(
    (a, b) => RING_SEVERITY[a.ring] - RING_SEVERITY[b.ring] || a.distanceKm - b.distanceKm,
  );

  return {
    fireId,
    hasPerimeter,
    rings: [
      { ring: 'inside' as ThreatRing, radiusKm: null },
      ...RING_RADII_KM.map(({ ring: r, radiusKm }) => ({ ring: r, radiusKm })),
    ],
    threatened,
    corridorCount: threatened.filter((t) => t.inSpreadCorridor).length,
    computedAt: new Date().toISOString(),
  };
}
