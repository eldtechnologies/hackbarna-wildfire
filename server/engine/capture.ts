// Read the raw Deepfire OGC capture into the engine's narrow Detection type.
//
// Deliberately independent of server/providers/normalize.ts. The engine needs five
// fields out of 2,743 records and nothing else, so reading them directly keeps this
// stream unblocked by the provider rewrite, which is still in review. The live panel
// gets its detections through a second adapter over getFires(); both produce the same
// Detection[] and everything downstream is identical.
//
// The one thing that is NOT simple here is which detections belong to the fire.
//
// The capture's bbox holds three separate heat sources. The Los Gallardos fire itself
// is carried as TWO cluster ids — one whose members are entirely MTG-I1 and one whose
// members are entirely polar — sharing a centroid to within 500 m. That is a sensor
// artefact, not two fires, and it is the "one fire can carry two cluster IDs" hazard
// the spike flagged. Filtering on a single cluster id silently halves the fire:
// 1,932 + 728 = 2,660, which is exactly the hotspot count the spike published.
//
// The remaining 83 detections form three clusters 20 km west and 25 km south that
// predate the fire by weeks or sit on unrelated ground.

import type { LatLon } from '../../shared/fires';
import { metresBetween } from './geometry';
import type { Detection } from './mask';
import { toEpochMs } from './time';

export interface RawFeature<P> {
  type: string;
  id: string;
  geometry: { type: string; coordinates: unknown };
  properties: P;
}

export interface RawHotspotProps {
  id?: string;
  cluster_id?: string | null;
  observed_at?: string;
  source?: string;
  confidence?: string;
  fire_radiative_power?: number | null;
}

export interface RawClusterProps {
  id?: string;
  first_observed?: string;
  last_observed?: string;
  active?: boolean;
}

export interface RawCapture {
  scenario: string;
  source?: string;
  window?: { from: string; to: string };
  bbox?: string;
  hotspots: Array<RawFeature<RawHotspotProps>>;
  clusters: Array<RawFeature<RawClusterProps>>;
  perimeters?: Array<RawFeature<Record<string, unknown>>>;
}

const CONFIDENCE_SCORE: Record<string, number> = { HIGH: 0.9, MEDIUM: 0.65, LOW: 0.3 };

/** An unknown confidence word becomes null, never a plausible-looking default. */
export function confidenceOf(word: unknown): number | null {
  if (typeof word !== 'string') return null;
  return CONFIDENCE_SCORE[word.toUpperCase()] ?? null;
}

export interface CaptureEvent {
  /** Cluster ids that are the same fire. */
  clusterIds: string[];
  centroid: LatLon;
  detections: number;
  firstSeen: string | null;
  lastSeen: string | null;
}

/**
 * Group clusters into events by centroid proximity and overlapping lifetime.
 *
 * The threshold is generous on purpose. Merging two fires that are 3 km apart costs
 * nothing here — they would share a cut field anyway — while failing to merge the two
 * halves of one fire halves the mask and moves every cut time later, which is the
 * direction that gets people killed.
 */
export function groupClustersIntoEvents(
  clusters: RawCapture['clusters'],
  hotspots: RawCapture['hotspots'],
  maxSeparationM = 5000,
): CaptureEvent[] {
  const members = new Map<string, { count: number; first: string | null; last: string | null }>();
  for (const f of hotspots) {
    const cid = f.properties.cluster_id;
    if (!cid) continue;
    const entry = members.get(cid) ?? { count: 0, first: null, last: null };
    entry.count += 1;
    const at = f.properties.observed_at ?? null;
    if (at !== null) {
      if (entry.first === null || at < entry.first) entry.first = at;
      if (entry.last === null || at > entry.last) entry.last = at;
    }
    members.set(cid, entry);
  }

  const points: Array<{ id: string; centroid: LatLon }> = [];
  for (const c of clusters) {
    const coords = c.geometry.coordinates as number[] | undefined;
    const id = c.properties.id ?? c.id;
    if (!Array.isArray(coords) || coords.length !== 2) continue;
    const [lon, lat] = coords;
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
    points.push({ id, centroid: { lat, lon } });
  }

  // Union-find over "centroids within maxSeparationM of each other".
  const parent = new Map<string, string>();
  const find = (a: string): string => {
    let root = a;
    while (parent.get(root) !== undefined && parent.get(root) !== root) root = parent.get(root)!;
    parent.set(a, root);
    return root;
  };
  const union = (a: string, b: string): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };
  for (const p of points) if (!parent.has(p.id)) parent.set(p.id, p.id);
  for (let i = 0; i < points.length; i++) {
    for (let j = i + 1; j < points.length; j++) {
      if (metresBetween(points[i].centroid, points[j].centroid) <= maxSeparationM) {
        union(points[i].id, points[j].id);
      }
    }
  }

  const grouped = new Map<string, CaptureEvent>();
  for (const p of points) {
    const root = find(p.id);
    const m = members.get(p.id);
    const existing = grouped.get(root);
    const event: CaptureEvent = existing ?? {
      clusterIds: [],
      centroid: p.centroid,
      detections: 0,
      firstSeen: null,
      lastSeen: null,
    };
    if (!existing) {
      event.centroid = p.centroid;
    } else {
      // Keep the centroid of the heaviest cluster so the event sits on the fire.
      if ((m?.count ?? 0) > event.detections) event.centroid = p.centroid;
    }
    event.clusterIds.push(p.id);
    event.detections += m?.count ?? 0;
    if (m?.first !== null && m?.first !== undefined) {
      if (event.firstSeen === null || m.first < event.firstSeen) event.firstSeen = m.first;
    }
    if (m?.last !== null && m?.last !== undefined) {
      if (event.lastSeen === null || m.last > event.lastSeen) event.lastSeen = m.last;
    }
    grouped.set(root, event);
  }

  return [...grouped.values()].sort((a, b) => b.detections - a.detections);
}

/**
 * The event a given time window is about: the busiest one whose lifetime overlaps it.
 * Falls back to the busiest overall when nothing overlaps, so a caller is never handed
 * an empty mask by accident.
 */
export function pickEventForWindow(events: CaptureEvent[], windowFrom: string, windowTo: string): CaptureEvent | null {
  if (events.length === 0) return null;
  const overlapping = events.filter((e) => {
    if (e.firstSeen === null || e.lastSeen === null) return false;
    return e.firstSeen <= windowTo && e.lastSeen >= windowFrom;
  });
  return (overlapping.length > 0 ? overlapping : events).reduce((best, e) =>
    e.detections > best.detections ? e : best,
  );
}

export interface DetectionOptions {
  /** Restrict to these cluster ids. Omit for every detection in the capture. */
  clusterIds?: ReadonlySet<string>;
  /** Seconds since this origin become each detection's atSeconds. */
  originMs: number;
}

export function detectionsFromCapture(raw: RawCapture, opts: DetectionOptions): Detection[] {
  const out: Detection[] = [];
  for (const f of raw.hotspots) {
    const p = f.properties;
    const coords = f.geometry.coordinates as number[] | undefined;
    if (!Array.isArray(coords) || coords.length < 2) continue;
    const [lon, lat] = coords;
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
    if (opts.clusterIds && !opts.clusterIds.has(p.cluster_id ?? '')) continue;
    const ms = toEpochMs(p.observed_at ?? null);
    // A detection with no usable time cannot be placed on the timeline. Dropping it
    // is the only honest option; guessing zero would cut every road at the origin.
    if (ms === null) continue;
    out.push({
      id: p.id ?? f.id,
      lat,
      lon,
      atSeconds: Math.floor((ms - opts.originMs) / 1000),
      source: p.source ?? 'UNKNOWN',
      confidence: confidenceOf(p.confidence),
      clusterId: p.cluster_id ?? null,
    });
  }
  return out;
}

export function loadCapture(json: unknown): RawCapture {
  const raw = json as Partial<RawCapture>;
  if (!raw || !Array.isArray(raw.hotspots)) {
    throw new Error('capture file has no hotspots array');
  }
  return {
    scenario: raw.scenario ?? 'unknown',
    source: raw.source,
    window: raw.window,
    bbox: raw.bbox,
    hotspots: raw.hotspots,
    clusters: Array.isArray(raw.clusters) ? raw.clusters : [],
    perimeters: Array.isArray(raw.perimeters) ? raw.perimeters : [],
  };
}
