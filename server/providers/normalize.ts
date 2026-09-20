// Raw Deepfire API shapes and the normalizer that maps them into the internal
// schema. Deepfire serves OGC API Features: each collection is a GeoJSON
// FeatureCollection. Attributes live in `properties`, the shape lives in
// `geometry`.
//
// Verified against https://api.deepfire.co/ogc/features/v1/collections on 19 Sep 2026:
//
//   deepfire:hotspots              Point         id, cluster_id, observed_at, source,
//                                                 confidence (LOW|MEDIUM|HIGH),
//                                                 fire_radiative_power, country, active
//   deepfire:clusters              Point         id, first_observed, last_observed, active
//   deepfire:satellite-perimeters  MultiPolygon  id, cluster_id, computed_at,
//                                                 observed_watermark, n_hotspots,
//                                                 area_m2, perimeter_m, active
//   deepfire:static-heat-sources   Polygon       id, global_id, type, source, method,
//                                                 remarks, year
//
// The API reports no `numberMatched`, and `startIndex` is unreliable on wide
// bboxes (HTTP 500). The live client chunks by day. See live.ts.
//
// The normalizer applies one rule: a value the source did not supply becomes
// null, never a plausible number. Only features that cannot be placed at all —
// no usable geometry — are dropped, and the drop is counted and warned.

import type {
  FireCluster,
  FirePerimeter,
  SpreadStep,
  FiresResponse,
  Hotspot,
  LatLon,
} from '../../shared/fires';

type LonLat = [number, number];

interface OgcFeature<P, G> {
  type: 'Feature';
  id?: string | number;
  geometry: G | null; // RFC 7946 permits an explicitly null geometry
  properties: P;
}

interface PointGeometry {
  type: 'Point';
  coordinates: LonLat;
}

interface PolygonGeometry {
  type: 'Polygon';
  coordinates: LonLat[][];
}

interface MultiPolygonGeometry {
  type: 'MultiPolygon';
  coordinates: LonLat[][][];
}

export interface RawHotspotProps {
  id: string;
  cluster_id: string | null;
  observed_at: string;
  available_at?: string;
  source: string;
  confidence: string;
  fire_radiative_power: number | null;
  country: string | null;
  active: boolean;
}

export interface RawClusterProps {
  id: string;
  first_observed: string;
  last_observed: string;
  active: boolean;
}

export interface RawPerimeterProps {
  id: string;
  cluster_id: string;
  computed_at: string;
  observed_watermark: string;
  n_hotspots: number | string;
  area_m2: number | string;
  perimeter_m: number | string;
  active: boolean;
}

export type RawHotspot = OgcFeature<RawHotspotProps, PointGeometry>;
export type RawCluster = OgcFeature<RawClusterProps, PointGeometry>;
export type RawPerimeter = OgcFeature<
  RawPerimeterProps,
  PolygonGeometry | MultiPolygonGeometry
>;

// Mock/recorded spread records (scripts/mock-deepfire.mjs, recordings under
// data/snapshots/). The live API has no forecast collection, so these only
// ever arrive from the replay path. A horizon of 0 IS the observed perimeter.
export interface RawSpreadStep {
  cluster_id?: string | number | null;
  valid_time?: string;
  issued_at?: string;
  horizon_hours?: number;
  area_km2?: number;
  geometry?: PolygonGeometry | null;
}

export interface RawFiresPayload {
  hotspots: RawHotspot[];
  clusters: RawCluster[];
  perimeters: RawPerimeter[];
  spread?: RawSpreadStep[];
}

const CONFIDENCE_MAP: Record<string, number> = {
  HIGH: 0.9,
  MEDIUM: 0.65,
  LOW: 0.3,
};

// A number the source supplied, or null. Absent, blank and unparseable are all
// "not measured": Number('') is 0 and Number('abc') is NaN, so neither may be
// allowed to reach a caller as a number.
function numberOrNull(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '') return null;
    const n = Number(trimmed);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

// The first supplied, non-blank string, or null. `??` is not enough here: an
// empty string is not nullish, so it would survive and produce a value that
// looks present but is empty.
function firstNonBlank(...values: unknown[]): string | null {
  for (const v of values) {
    if (typeof v === 'string' && v.trim() !== '') return v;
  }
  return null;
}

// An unrecognised confidence word returns null, NOT the LOW value. Collapsing the
// two would make a real LOW indistinguishable from an API value we do not know.
function confidenceOf(word: unknown): number | null {
  if (typeof word !== 'string') return null;
  return CONFIDENCE_MAP[word.trim().toUpperCase()] ?? null;
}

// A GeoJSON position that is two finite numbers, or null.
function pointOf(geometry: PointGeometry | null | undefined): LatLon | null {
  const coords = geometry?.coordinates;
  if (!Array.isArray(coords) || coords.length < 2) return null;
  const [lon, lat] = coords;
  if (typeof lon !== 'number' || typeof lat !== 'number') return null;
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
  return { lat, lon };
}

// A closed ring of at least 4 finite positions, or null. GeoJSON requires the
// first position repeated at the end, so 3 positions is a malformed ring, not a
// triangle.
function ringOf(raw: LonLat[] | undefined): LatLon[] | null {
  if (!Array.isArray(raw) || raw.length < 4) return null;
  const ring: LatLon[] = [];
  for (const pos of raw) {
    if (!Array.isArray(pos) || pos.length < 2) return null;
    const [lon, lat] = pos;
    if (typeof lon !== 'number' || typeof lat !== 'number') return null;
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
    ring.push({ lat, lon });
  }
  const first = ring[0];
  const last = ring[ring.length - 1];
  if (first.lat !== last.lat || first.lon !== last.lon) return null;
  return ring;
}

function perimeterParts(
  geometry: PolygonGeometry | MultiPolygonGeometry | null | undefined,
): (LonLat[] | undefined)[] {
  if (!geometry) return [];
  if (geometry.type === 'Polygon') return [geometry.coordinates?.[0]];
  if (!Array.isArray(geometry.coordinates)) return [];
  return geometry.coordinates.map((part) => part?.[0]);
}

// Every caller passes at least one point (the members, or the cluster's own
// centroid when it has none), so this needs no empty-input sentinel.
function computeBbox(points: LatLon[]): [number, number, number, number] {
  let west = points[0].lon;
  let south = points[0].lat;
  let east = points[0].lon;
  let north = points[0].lat;
  for (const p of points) {
    if (p.lon < west) west = p.lon;
    if (p.lat < south) south = p.lat;
    if (p.lon > east) east = p.lon;
    if (p.lat > north) north = p.lat;
  }
  return [west, south, east, north];
}

function warnSkipped(kind: string, skipped: number, total: number): void {
  if (skipped === 0) return;
  console.warn(`[normalize] dropped ${skipped}/${total} ${kind} with no usable geometry`);
}

export function normalize(
  raw: RawFiresPayload,
  provenance: 'live' | 'replay',
  scenario: string | null,
): FiresResponse {
  const rawHotspots = raw.hotspots ?? [];
  const hotspots: Hotspot[] = [];
  let skippedHotspots = 0;
  for (const f of rawHotspots) {
    const position = pointOf(f?.geometry);
    if (!position) {
      skippedHotspots += 1;
      continue;
    }
    const p = f.properties ?? ({} as RawHotspotProps);
    hotspots.push({
      id: String(p.id ?? f.id ?? ''),
      position,
      frpMw: numberOrNull(p.fire_radiative_power),
      confidence: confidenceOf(p.confidence),
      detectedAt: firstNonBlank(p.observed_at),
      satellite: firstNonBlank(p.source),
      clusterId: firstNonBlank(p.cluster_id == null ? null : String(p.cluster_id)),
    });
  }
  warnSkipped('hotspots', skippedHotspots, rawHotspots.length);

  const hotspotsByCluster = new Map<string, Hotspot[]>();
  for (const h of hotspots) {
    if (!h.clusterId) continue;
    const list = hotspotsByCluster.get(h.clusterId) ?? [];
    list.push(h);
    hotspotsByCluster.set(h.clusterId, list);
  }

  const rawClusters = raw.clusters ?? [];
  const clusters: FireCluster[] = [];
  let skippedClusters = 0;
  for (const f of rawClusters) {
    const centroid = pointOf(f?.geometry);
    if (!centroid) {
      skippedClusters += 1;
      continue;
    }
    const p = f.properties ?? ({} as RawClusterProps);
    const id = String(p.id ?? f.id ?? '');
    const members = hotspotsByCluster.get(id) ?? [];
    const measured = members
      .map((h) => h.frpMw)
      .filter((v): v is number => v !== null);
    clusters.push({
      id,
      name: null,
      centroid,
      hotspotIds: members.map((h) => h.id),
      // The real cluster carries no geometry of its own beyond its centroid and
      // no member list, so membership is derived from the hotspots above.
      bbox: computeBbox(members.length > 0 ? members.map((h) => h.position) : [centroid]),
      totalFrpMw: measured.length > 0 ? measured.reduce((a, b) => a + b, 0) : null,
      firstDetectedAt: firstNonBlank(p.first_observed),
      lastDetectedAt: firstNonBlank(p.last_observed),
    });
  }
  warnSkipped('clusters', skippedClusters, rawClusters.length);

  const rawPerimeters = raw.perimeters ?? [];
  const perimeters: FirePerimeter[] = [];
  let skippedPerimeters = 0;
  let droppedParts = 0;
  for (const f of rawPerimeters) {
    const parts = perimeterParts(f?.geometry);
    const rings = parts.map(ringOf).filter((r): r is LatLon[] => r !== null);
    // Count parts, not only whole features: a MultiPolygon with one good part and
    // one malformed part would otherwise lose the bad part silently.
    droppedParts += parts.length - rings.length;
    if (rings.length === 0) {
      skippedPerimeters += 1;
      continue;
    }
    const p = f.properties ?? ({} as RawPerimeterProps);
    const clusterId = firstNonBlank(p.cluster_id == null ? null : String(p.cluster_id));
    const m2 = numberOrNull(p.area_m2);
    const observedAt = firstNonBlank(p.observed_watermark, p.computed_at);
    for (let i = 0; i < rings.length; i += 1) {
      perimeters.push({
        clusterId,
        polygon: rings[i],
        areaKm2: m2 === null ? null : m2 / 1e6,
        observedAt,
        partIndex: i,
        partCount: rings.length,
      });
    }
  }
  warnSkipped('perimeters', skippedPerimeters, rawPerimeters.length);
  warnSkipped('perimeter parts', droppedParts, droppedParts);

  // Mock/recorded spread (replay path only). Horizon 0 records are the
  // observed perimeter at that frame; positive horizons are projections.
  const spread: SpreadStep[] = [];
  let skippedSpread = 0;
  const rawSpread = raw.spread ?? [];
  for (const s of rawSpread) {
    const ring = ringOf(s?.geometry?.coordinates?.[0]);
    const clusterId = firstNonBlank(s?.cluster_id == null ? null : String(s.cluster_id));
    const validTime = firstNonBlank(s?.valid_time);
    const horizon = numberOrNull(s?.horizon_hours);
    if (!ring || !clusterId || !validTime || horizon === null) {
      skippedSpread += 1;
      continue;
    }
    if (horizon === 0) {
      perimeters.push({
        clusterId,
        polygon: ring,
        areaKm2: numberOrNull(s.area_km2),
        observedAt: validTime,
        partIndex: 0,
        partCount: 1,
      });
    } else if (horizon > 0) {
      spread.push({ clusterId, at: validTime, horizonHours: horizon, polygon: ring });
    } else {
      // A negative horizon is neither the observed perimeter nor a projection.
      skippedSpread += 1;
    }
  }
  warnSkipped('spread steps', skippedSpread, rawSpread.length);

  return {
    provenance,
    fetchedAt: new Date().toISOString(),
    scenario,
    hotspots,
    clusters,
    perimeters,
    // Deepfire exposes observed perimeters only. It has no forecast
    // collection, so the live path always has an empty spread list.
    spread,
  };
}
