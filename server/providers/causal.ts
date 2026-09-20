import type { FiresResponse, ReplayTimeline } from '../../shared/fires';
import { normalize, type RawCluster, type RawFiresPayload } from './normalize';
import { CAPTURE_AVAILABILITY_POLICY, detectionAvailableAt, epoch } from './availability';

export interface HistoricalCapture extends RawFiresPayload {
  scenario?: string;
  window?: { from: string; to: string };
}

export function captureTimeline(raw: HistoricalCapture, scenario: string): ReplayTimeline {
  const stamps = raw.hotspots.map(h => detectionAvailableAt(h.properties)).filter((t): t is number => t !== null);
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
  const hotspots = raw.hotspots.filter(h => {
    const available = detectionAvailableAt(h.properties);
    return available !== null && available <= issueMs;
  });
  const groups = new Map<string, typeof hotspots>();
  for (const h of hotspots) {
    const id = h.properties.cluster_id;
    if (id === null || id === '') continue;
    const coords = h.geometry?.coordinates;
    if (!coords || !coords.every(Number.isFinite)) continue;
    const group = groups.get(id) ?? [];
    group.push(h); groups.set(id, group);
  }
  const clusters: RawCluster[] = [...groups].map(([id, members]) => {
    const stamps = members.map(h => epoch(h.properties.observed_at)!);
    const coordinates: [number, number] = [0, 0];
    for (const h of members) {
      coordinates[0] += h.geometry!.coordinates[0]/members.length;
      coordinates[1] += h.geometry!.coordinates[1]/members.length;
    }
    return {type:'Feature', geometry:{type:'Point',coordinates}, properties:{id,
      first_observed:new Date(Math.min(...stamps)).toISOString(),
      last_observed:new Date(Math.max(...stamps)).toISOString(), active:true}};
  });
  const perimeters = (raw.perimeters ?? []).filter(p => {
    const computed = epoch(p.properties.computed_at);
    const observed = epoch(p.properties.observed_watermark);
    return computed !== null && observed !== null && Math.max(computed, observed) <= issueMs;
  });
  // A future valid time is allowed only for a forecast issued by this cursor.
  // Old synthetic recordings without issue times cannot prove that fact.
  const spread = (raw.spread ?? []).filter(s => {
    const issued = epoch(s.issued_at);
    const valid = epoch(s.valid_time);
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
