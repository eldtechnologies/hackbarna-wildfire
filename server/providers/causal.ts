import type { FiresResponse, ReplayTimeline } from '../../shared/fires';
import { normalize, normalizeHotspot, type RawCluster, type RawFiresPayload } from './normalize';
import { CAPTURE_AVAILABILITY_POLICY, detectionAvailableAt, epoch } from './availability';

export interface HistoricalCapture extends RawFiresPayload {
  scenario?: string;
  window?: { from: string; to: string };
}

// Retain the source feature (including recorded delivery) beside its validated
// observation. All timeline and cluster arithmetic uses this accepted shape.
function observations(raw: RawFiresPayload) {
  return (raw.hotspots ?? []).flatMap(feature => {
    const hotspot = normalizeHotspot(feature);
    if (!hotspot) return [];
    const observed = epoch(hotspot.detectedAt);
    const available = detectionAvailableAt({
      observed_at: hotspot.detectedAt ?? '', source: hotspot.satellite ?? '',
      available_at: feature.properties?.available_at,
    });
    return observed === null || available === null ? [] : [{feature, hotspot, observed, available}];
  });
}

export function captureTimeline(raw: HistoricalCapture, scenario: string): ReplayTimeline {
  const stamps = observations(raw).map(h => h.available);
  const start = epoch(raw.window?.from) ?? (stamps.length ? Math.min(...stamps) : null);
  const end = epoch(raw.window?.to) ?? (stamps.length ? Math.max(...stamps) : null);
  if (start === null || end === null || end < start) throw new Error('Capture has no valid replay window');
  const times = [...new Set([start, ...stamps.filter(t => t >= start && t <= end), end])].sort((a,b) => a-b);
  return { scenario, start: new Date(start).toISOString(), end: new Date(end).toISOString(),
    durationSeconds: Math.ceil((end-start)/1000), frames: times.map(t => new Date(t).toISOString()) };
}

// Cluster association is retrospective upstream metadata. Geometry and first/last
// observations are rebuilt from evidence in hand; no final centroid reaches replay.
export function causalResponse(raw: RawFiresPayload, scenario: string, issueMs: number): FiresResponse {
  const accepted = observations(raw).filter(h => h.available <= issueMs);
  const hotspots = accepted.map(h => h.feature);
  const groups = new Map<string, typeof accepted>();
  for (const h of accepted) {
    const id = h.hotspot.clusterId;
    if (!id) continue;
    const group = groups.get(id) ?? [];
    group.push(h); groups.set(id, group);
  }
  const clusters: RawCluster[] = [...groups].map(([id, members]) => {
    const stamps = members.map(h => h.observed);
    const coordinates: [number, number] = [0, 0];
    for (const {hotspot} of members) {
      coordinates[0] += hotspot.position.lon / members.length;
      coordinates[1] += hotspot.position.lat / members.length;
    }
    return {type:'Feature', geometry:{type:'Point',coordinates}, properties:{id,
      first_observed:new Date(Math.min(...stamps)).toISOString(),
      last_observed:new Date(Math.max(...stamps)).toISOString(), active:true}};
  });
  const perimeters = (raw.perimeters ?? []).filter(p => {
    const computed = epoch(p?.properties?.computed_at);
    const observed = epoch(p?.properties?.observed_watermark);
    return computed !== null && observed !== null && Math.max(computed, observed) <= issueMs;
  });
  // A future valid time is allowed only for a forecast issued by this cursor.
  // Old synthetic recordings without issue times cannot prove that fact.
  const spread = (raw.spread ?? []).filter(s => {
    const issued = epoch(s?.issued_at);
    const valid = epoch(s?.valid_time);
    return issued !== null && issued <= issueMs && valid !== null
      && typeof s.horizon_hours === 'number' && Number.isFinite(s.horizon_hours) && s.horizon_hours >= 0
      && (s.horizon_hours === 0 ? valid <= issueMs : valid >= issued);
  });
  const result = normalize({hotspots, clusters, perimeters, spread}, 'replay', scenario);
  result.asOf = new Date(issueMs).toISOString();
  result.availability = {policy:CAPTURE_AVAILABILITY_POLICY, deliveryTimes:'assumed_unless_recorded',
    clusterAssociation:'retrospective', perimeterAvailability:'computed_at_lower_bound'};
  return result;
}
