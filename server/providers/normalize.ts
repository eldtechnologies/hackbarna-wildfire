// Raw Deepfire API shapes and the normalizer that maps them into the internal
// schema. The real Deepfire spec arrives at the hackathon, so these shapes are
// mocked from the public description (hotspots, clusters, fire spread). When
// the spec lands, adjust only this file: both the live client and the replay
// snapshots pass through the same normalize() function.

import type {
  FireCluster,
  FirePerimeter,
  FiresResponse,
  Hotspot,
  LatLon,
  SpreadStep,
} from '../../shared/fires';

export interface RawHotspot {
  id: string | number;
  latitude: number;
  longitude: number;
  frp: number; // fire radiative power in MW
  confidence: number | 'low' | 'nominal' | 'high';
  acq_datetime: string;
  cluster_id?: string | number | null;
}

export interface RawCluster {
  id: string | number;
  label?: string;
  centroid: { lat: number; lon: number };
  hotspot_ids?: Array<string | number>;
  bbox?: [number, number, number, number];
  total_frp?: number;
  first_seen: string;
  last_seen: string;
}

export interface RawSpreadPolygon {
  cluster_id: string | number;
  valid_time: string;
  horizon_hours?: number; // 0 or absent means the observed perimeter
  area_km2?: number;
  geometry: { type: 'Polygon'; coordinates: number[][][] }; // GeoJSON, [lon, lat] rings
}

export interface RawFiresPayload {
  hotspots: RawHotspot[];
  clusters: RawCluster[];
  spread: RawSpreadPolygon[];
}

const CONFIDENCE_MAP = { low: 0.3, nominal: 0.65, high: 0.9 } as const;

function normalizeConfidence(value: RawHotspot['confidence']): number {
  if (typeof value === 'number') return Math.min(1, Math.max(0, value));
  return CONFIDENCE_MAP[value] ?? 0.5;
}

function ringToLatLon(ring: number[][]): LatLon[] {
  return ring.map(([lon, lat]) => ({ lat, lon }));
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
  return [west, south, east, north];
}

export function normalize(
  raw: RawFiresPayload,
  provenance: 'live' | 'replay',
  scenario: string | null,
): FiresResponse {
  const hotspots: Hotspot[] = raw.hotspots.map((h) => ({
    id: String(h.id),
    position: { lat: h.latitude, lon: h.longitude },
    frpMw: h.frp,
    confidence: normalizeConfidence(h.confidence),
    detectedAt: h.acq_datetime,
    clusterId: h.cluster_id != null ? String(h.cluster_id) : null,
  }));

  const hotspotsByCluster = new Map<string, Hotspot[]>();
  for (const h of hotspots) {
    if (!h.clusterId) continue;
    const list = hotspotsByCluster.get(h.clusterId) ?? [];
    list.push(h);
    hotspotsByCluster.set(h.clusterId, list);
  }

  const clusters: FireCluster[] = raw.clusters.map((c) => {
    const id = String(c.id);
    const members = hotspotsByCluster.get(id) ?? [];
    const memberIds = c.hotspot_ids?.map(String) ?? members.map((h) => h.id);
    const totalFrpMw =
      c.total_frp ?? members.reduce((sum, h) => sum + h.frpMw, 0);
    const bbox =
      c.bbox ??
      (members.length > 0
        ? computeBbox(members.map((h) => h.position))
        : computeBbox([c.centroid]));
    return {
      id,
      name: c.label ?? null,
      centroid: { lat: c.centroid.lat, lon: c.centroid.lon },
      hotspotIds: memberIds,
      bbox,
      totalFrpMw,
      firstDetectedAt: c.first_seen,
      lastDetectedAt: c.last_seen,
    };
  });

  const perimeters: FirePerimeter[] = [];
  const spread: SpreadStep[] = [];
  for (const s of raw.spread) {
    const polygon = ringToLatLon(s.geometry.coordinates[0] ?? []);
    const horizon = s.horizon_hours ?? 0;
    if (horizon <= 0) {
      perimeters.push({
        clusterId: String(s.cluster_id),
        polygon,
        areaKm2: s.area_km2 ?? 0,
        observedAt: s.valid_time,
      });
    } else {
      spread.push({
        clusterId: String(s.cluster_id),
        at: s.valid_time,
        horizonHours: horizon,
        polygon,
      });
    }
  }
  spread.sort((a, b) => a.horizonHours - b.horizonHours);

  return {
    provenance,
    fetchedAt: new Date().toISOString(),
    scenario,
    hotspots,
    clusters,
    perimeters,
    spread,
  };
}
