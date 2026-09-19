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

import type {
  FireCluster,
  FirePerimeter,
  FiresResponse,
  Hotspot,
  LatLon,
} from '../../shared/fires';

type LonLat = [number, number];

interface OgcFeature<P, G> {
  type: 'Feature';
  id?: string | number;
  geometry: G;
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

export interface RawFiresPayload {
  hotspots: RawHotspot[];
  clusters: RawCluster[];
  perimeters: RawPerimeter[];
}

// The API returns uppercase confidence words. Anything else is unclassified:
// keep a low value rather than inventing confidence.
const CONFIDENCE_MAP: Record<string, number> = {
  HIGH: 0.9,
  MEDIUM: 0.65,
  LOW: 0.3,
};

function normalizeConfidence(value: string | null | undefined): number {
  if (!value) return 0.3;
  return CONFIDENCE_MAP[String(value).toUpperCase()] ?? 0.3;
}

function ringToLatLon(ring: LonLat[]): LatLon[] {
  return ring.map(([lon, lat]) => ({ lat, lon }));
}

// A MultiPolygon perimeter becomes one FirePerimeter per part. The outer ring
// is ring 0; inner rings (holes) are dropped, because the internal schema
// carries a single closed ring.
function perimeterParts(
  geometry: PolygonGeometry | MultiPolygonGeometry,
): LonLat[][] {
  if (geometry.type === 'Polygon') return [geometry.coordinates[0] ?? []];
  return geometry.coordinates.map((poly) => poly[0] ?? []);
}

function computeBbox(points: LatLon[]): [number, number, number, number] {
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  for (const p of points) {
    west = Math.min(west, p.lon);
    south = Math.min(south, p.lat);
    east = Math.max(east, p.lon);
    north = Math.max(north, p.lat);
  }
  // An empty ring must not produce an inverted box of infinities.
  if (!Number.isFinite(west)) return [0, 0, 0, 0];
  return [west, south, east, north];
}

function num(value: number | string | null | undefined): number {
  const n = typeof value === 'string' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) ? n : 0;
}

export function normalize(
  raw: RawFiresPayload,
  provenance: 'live' | 'replay',
  scenario: string | null,
): FiresResponse {
  const hotspots: Hotspot[] = (raw.hotspots ?? []).map((f) => {
    const p = f.properties;
    const [lon, lat] = f.geometry.coordinates;
    const frp = num(p.fire_radiative_power);
    return {
      id: String(p.id ?? f.id ?? ''),
      position: { lat, lon },
      // Missing FRP stays null. A null is "not measured"; a 0 is "measured zero".
      frpMw: p.fire_radiative_power == null || frp === 0 ? null : frp,
      confidence: normalizeConfidence(p.confidence),
      detectedAt: p.observed_at,
      clusterId: p.cluster_id != null ? String(p.cluster_id) : null,
    };
  });

  const hotspotsByCluster = new Map<string, Hotspot[]>();
  for (const h of hotspots) {
    if (!h.clusterId) continue;
    const list = hotspotsByCluster.get(h.clusterId) ?? [];
    list.push(h);
    hotspotsByCluster.set(h.clusterId, list);
  }

  // The real cluster carries only id, first_observed, last_observed, active.
  // Membership comes from each hotspot's cluster_id, never from the cluster.
  const clusters: FireCluster[] = (raw.clusters ?? []).map((f) => {
    const p = f.properties;
    const id = String(p.id ?? f.id ?? '');
    const [lon, lat] = f.geometry.coordinates;
    const members = hotspotsByCluster.get(id) ?? [];
    const totalFrpMw = members.reduce((sum, h) => sum + (h.frpMw ?? 0), 0);
    return {
      id,
      name: null,
      centroid: { lat, lon },
      hotspotIds: members.map((h) => h.id),
      bbox:
        members.length > 0
          ? computeBbox(members.map((h) => h.position))
          : computeBbox([{ lat, lon }]),
      totalFrpMw,
      firstDetectedAt: p.first_observed,
      lastDetectedAt: p.last_observed,
    };
  });

  const perimeters: FirePerimeter[] = [];
  for (const f of raw.perimeters ?? []) {
    const p = f.properties;
    for (const ring of perimeterParts(f.geometry)) {
      if (ring.length < 3) continue;
      perimeters.push({
        clusterId: String(p.cluster_id),
        polygon: ringToLatLon(ring),
        areaKm2: num(p.area_m2) / 1e6,
        observedAt: p.observed_watermark ?? p.computed_at,
      });
    }
  }

  return {
    provenance,
    fetchedAt: new Date().toISOString(),
    scenario,
    hotspots,
    clusters,
    perimeters,
    // Deepfire exposes observed perimeters only. It has no forecast collection.
    spread: [],
  };
}