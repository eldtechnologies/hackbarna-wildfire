// Situation agent: assembles a structured packet for one fire from computed
// geometry (perimeter, spread projection, threat rings) and narrates it.
// The model can only order server-rendered facts. It cannot write names,
// measurements, safety claims, recommendations, or coverage limits.
// Any LLM failure falls back to the deterministic template narrator, so the
// endpoint always answers, keyless demos included.

import { getFires } from './providers';
import {FactNarrator, type NarrationFact} from './narration';
import { getThreats, latestPerimeter, futureSpreadSteps } from './threats';
import type { LatLon } from '../shared/fires';
import { CATEGORY_LABEL, RING_SEVERITY } from '../shared/threats';
import type {
  EvacuationRecommendation,
  SituationPacket,
  SituationResponse,
} from '../shared/situation';

const CATEGORY_WEIGHT: Record<EvacuationRecommendation['category'], number> = {
  hospital: 0,
  town: 1,
  school: 1,
  'power-line': 2,
};

const RING_LABEL: Record<EvacuationRecommendation['ring'], string> = {
  inside: 'inside the fire perimeter',
  'ring-5km': 'within 5 km',
  'ring-10km': 'within 10 km',
  'ring-20km': 'within 20 km',
};

// 16-point compass label for a bearing.
const COMPASS_POINTS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];

function compassLabel(deg: number): string {
  return COMPASS_POINTS[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16];
}

function bearingDeg(from: LatLon, to: LatLon): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const φ1 = toRad(from.lat);
  const φ2 = toRad(to.lat);
  const Δλ = toRad(to.lon - from.lon);
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return (Math.atan2(y, x) * 180) / Math.PI;
}

// Averaged over the open ring (the first vertex is repeated at the end, so
// averaging the closed ring would double-count vertex 0).
function ringCentroid(ring: LatLon[]): LatLon | null {
  const pts = ring.length >= 4 ? ring.slice(0, -1) : ring;
  if (pts.length === 0) return null;
  let lat = 0;
  let lon = 0;
  for (const p of pts) {
    lat += p.lat;
    lon += p.lon;
  }
  return { lat: lat / pts.length, lon: lon / pts.length };
}

function ringAreaKm2(ring: LatLon[]): number {
  // Spherical excess (shoelace on the sphere). Ring is a closed loop (first
  // point repeated at the end).
  // Deliberate divergence from src/fires/geometry.ts ringAreaKm2, which uses
  // a local equirectangular projection: that variant is tuned for client-side
  // interpolation performance, this one is the more accurate spherical form
  // used for server-side reported figures. Not consolidated because the two
  // have different precision/performance tradeoffs.
  const R = 6371.0088;
  const toRad = (d: number) => (d * Math.PI) / 180;
  let sum = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    const [lon1, lat1] = [toRad(ring[i].lon), toRad(ring[i].lat)];
    const [lon2, lat2] = [toRad(ring[i + 1].lon), toRad(ring[i + 1].lat)];
    sum += (lon2 - lon1) * (2 + Math.sin(lat1) + Math.sin(lat2));
  }
  return Math.abs((sum * R * R) / 2);
}

// --- Evacuation ordering ---------------------------------------------
// Deterministic severity order so the list is defensible: ring first (how
// close the fire is), corridor second (projected impact), category third
// (people density: hospitals and towns/schools before power lines), then
// distance as tie-breaker.

function recommendationPriority(t: SituationPacket['threats'][number], hasPerimeter: boolean): 1 | 2 | 3 {
  if (!hasPerimeter && t.ring === 'inside') return t.inSpreadCorridor ? 1 : 2;
  if (t.ring === 'inside' || (t.ring === 'ring-5km' && t.inSpreadCorridor)) return 1;
  if (t.ring === 'ring-5km' || (t.ring === 'ring-10km' && t.inSpreadCorridor)) return 2;
  return 3;
}

function reasonFor(t: SituationPacket['threats'][number], hasPerimeter: boolean): string {
  const proximity = !hasPerimeter && t.ring === 'inside'
    ? 'within the 50 m detection-centroid search disc' : RING_LABEL[t.ring];
  const parts = [`${CATEGORY_LABEL[t.category]} ${t.name} ${proximity}`];
  if (!hasPerimeter && t.ring !== 'inside') parts[0] += ' of the detection-centroid search disc';
  if (t.ring !== 'inside') parts[0] += ` (${t.distanceKm.toFixed(1)} km)`;
  if (t.inSpreadCorridor) parts.push('in the projected spread corridor');
  return parts.join(', ');
}

// A heading is only real when both centroids are known and distinct; two
// coincident points give atan2(0,0)=0, a confident "drifts N" for a
// degenerate case.
function driftBearing(from: LatLon, to: LatLon): number | null {
  if (from.lat === to.lat && from.lon === to.lon) return null;
  const bearing = bearingDeg(from, to);
  return Number.isFinite(bearing) ? bearing : null;
}

// Rounded to 0.1 deg and normalized to [0, 360); a drift just under 360
// rounds to 360.0, which reads as a fourth rotation, so it maps to 0.
function normalizeBearingDeg(bearing: number): number {
  const norm = Math.round(((bearing % 360) + 360) % 360 * 10) / 10;
  return norm >= 360 ? 0 : norm;
}

// --- Template narrator (fallback, also the keyless default) -----------

export function situationFacts(packet: SituationPacket): NarrationFact[] {
  const area =
    packet.perimeterAreaKm2 != null
      ? ` The observed perimeter covers ${packet.perimeterAreaKm2.toFixed(0)} km2.`
      : ' No satellite perimeter has been observed yet.';
  // Gate on the computed heading, never a fallback literal: without a real
  // bearing the report must not invent one.
  let spread: string;
  if (packet.spreadStatus === 'unavailable') {
    spread = ' No spread projection is available.';
  } else if (packet.spreadStatus === 'expired') {
    spread = ` Latest available projection expired at ${packet.spreadValidAt}; no future spread projection is available.`;
  } else {
    const validity = ` Projection valid at ${packet.spreadValidAt} (${packet.spreadHorizonHours} h after the perimeter observation)`;
    spread = packet.spreadCompass == null || packet.spreadBearingDeg == null
      ? `${validity}, no drift heading available.`
      : `${validity} drifts ${packet.spreadCompass}`
        + ` (bearing ${Math.round(packet.spreadBearingDeg) % 360} deg), a geometric projection rather than measured wind.`;
  }

  const detectionFacts = ` ${packet.hotspotCount} recorded satellite hotspots, recorded FRP sum ${packet.totalFrpMw != null ? Math.round(packet.totalFrpMw) : 'unmeasured'} MW`;
  const detected = detectionFacts + (packet.firstDetectedAt != null
    ? `, first detected ${packet.firstDetectedAt.slice(0, 10)}.` : '.');

  const insideCount = packet.threats.filter((t) => t.ring === 'inside').length;
  const corridorCount = packet.corridorCount;
  let threatLine: string;
  if (packet.infrastructureStatus.state !== 'available') {
    threatLine = ` Infrastructure data ${packet.infrastructureStatus.state}; the loaded subset contains ${packet.threats.length} proximity matches. Missing data prevents a complete assessment.`;
  } else if (packet.threats.length === 0) {
    // An empty list means nothing is inside the rings when the fire is in the
    // covered region, and no data exists there otherwise; the claim must say
    // which one it is.
    threatLine =
      packet.infrastructureCoverage != null
        ? ` No bundled infrastructure within 20 km (coverage: ${packet.infrastructureCoverage.label}).`
        : ' No bundled infrastructure within 20 km, and this region is outside the infrastructure coverage area, so an empty list does not mean the area is safe.';
  } else {
    const bits: string[] = [];
    if (insideCount > 0) bits.push(packet.hasPerimeter
      ? `${insideCount} asset(s) inside the observed perimeter`
      : `${insideCount} asset(s) within the 50 m detection-centroid search disc`);
    if (corridorCount > 0) bits.push(`${corridorCount} in the projected spread corridor`);
    bits.push(`${packet.threats.length} proximity matches within 20 km`);
    threatLine = ` ${bits.join(', ')}.`;
  }

  if (packet.infrastructureCoverage?.note) threatLine += ` ${packet.infrastructureCoverage.note}`;

  return [
    {id:'perimeter',text:area.trim()}, {id:'spread',text:spread.trim()},
    {id:'detections',text:detected.trim()}, {id:'threats',text:threatLine.trim()},
  ];
}

function recommendationsFor(packet:SituationPacket): EvacuationRecommendation[] {
  const recommendations = packet.threats.map((t) => ({
    ...t,
    reason: reasonFor(t, packet.hasPerimeter),
    priority: recommendationPriority(t, packet.hasPerimeter),
  }));

  return recommendations;
}

const narrator=new FactNarrator({
  apiKey:process.env.LLM_API_KEY??'',
  baseUrl:process.env.LLM_BASE_URL??'https://api.openai.com/v1',
  model:process.env.LLM_MODEL??'gpt-4o-mini',
});

// --- Packet assembly -------------------------------------------------

export async function getSituation(fireId: string, atSeconds?: number): Promise<SituationResponse | null> {
  // One fires fetch for both the packet and the threat analysis, so the
  // figures cannot come from different snapshots. atSeconds scrubs a recorded
  // timeline (same semantics as /api/fires?at=); absent serves the live edge.
  const fires = await getFires(atSeconds);
  const cluster = fires.clusters.find((c) => c.id === fireId);
  if (!cluster) return null;
  const threats = await getThreats(fireId, fires);
  if (!threats) return null;

  const perimeter = latestPerimeter(fires, fireId);

  const steps = fires.spread
    .filter(s => s.clusterId === fireId && s.horizonHours > 0 && s.polygon.length >= 4 && Number.isFinite(Date.parse(s.at)))
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const future = futureSpreadSteps(fires, fireId);
  const furthest = steps.at(-1) ?? null;
  const spreadStatus = future.length > 0 ? 'future' : furthest ? 'expired' : 'unavailable';

  // With no observed perimeter the bearing still derives from the cluster
  // centroid, matching how the threat analysis substitutes a point disc.
  const from = perimeter ? ringCentroid(perimeter.polygon) : cluster.centroid;
  const to = spreadStatus === 'future' && furthest ? ringCentroid(furthest.polygon) : null;
  const drift = from && to ? driftBearing(from, to) : null;

  const areaKm2 = perimeter
    ? perimeter.areaKm2 != null && perimeter.areaKm2 > 0
      ? perimeter.areaKm2
      : ringAreaKm2(perimeter.polygon)
    : null;

  const situationThreats = threats.threatened.map((t) => ({
    ...t,
  }));

  const packet: SituationPacket = {
    fireId,
    fireName: cluster.name,
    dataProvenance: fires.provenance,
    hasPerimeter: threats.hasPerimeter,
    perimeterAreaKm2: areaKm2,
    perimeterObservedAt: perimeter?.observedAt ?? null,
    spreadHorizonHours: furthest?.horizonHours ?? 0,
    spreadValidAt: furthest?.at ?? null,
    spreadStatus,
    spreadBearingDeg: drift != null ? normalizeBearingDeg(drift) : null,
    spreadCompass: drift != null ? compassLabel(drift) : null,
    totalFrpMw: cluster.totalFrpMw,
    hotspotCount: cluster.hotspotIds.length,
    firstDetectedAt: cluster.firstDetectedAt,
    lastDetectedAt: cluster.lastDetectedAt,
    threats: situationThreats,
    corridorCount: threats.corridorCount,
    infrastructureCoverage: threats.infrastructureCoverage,
    infrastructureStatus: threats.infrastructureStatus,
    evidenceAsOf: fires.asOf ?? null,
    availabilityPolicy: fires.availability?.policy ?? null,
    computedAt: new Date().toISOString(),
  };

  const facts=situationFacts(packet);
  const order=await narrator.order(facts);
  const sentences=(order??facts.map(f=>f.id)).map(id=>facts.find(f=>f.id===id)!.text);
  const summary=`Situation report for fire ${packet.fireName??packet.fireId}. ${sentences.join(' ')} `
    + 'Proximity screening only. These priorities are not evacuation orders or road-access decisions.';

  const recommendations = recommendationsFor(packet).sort(
    (a, b) =>
      a.priority - b.priority ||
      RING_SEVERITY[a.ring] - RING_SEVERITY[b.ring] ||
      Number(b.inSpreadCorridor) - Number(a.inSpreadCorridor) ||
      CATEGORY_WEIGHT[a.category] - CATEGORY_WEIGHT[b.category] ||
      a.distanceKm - b.distanceKm,
  );

  return {
    fireId,
    summary,
    recommendations,
    narrator: order !== null ? 'llm' : 'template',
    packet,
  };
}
