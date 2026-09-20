// Situation agent: assembles a structured packet for one fire from computed
// geometry (perimeter, spread projection, threat rings) and narrates it.
// The narrator (LLM or template) only phrases the packet; every number the
// client renders comes from these computed fields, never from the model.
// Any LLM failure falls back to the deterministic template narrator, so the
// endpoint always answers, keyless demos included.

import { getFires } from './providers';
import { getThreats, latestPerimeter } from './threats';
import { pointInCoverage, INFRASTRUCTURE_COVERAGE } from './infrastructure';
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

function recommendationPriority(t: SituationPacket['threats'][number]): 1 | 2 | 3 {
  if (t.ring === 'inside' || (t.ring === 'ring-5km' && t.inSpreadCorridor)) return 1;
  if (t.ring === 'ring-5km' || (t.ring === 'ring-10km' && t.inSpreadCorridor)) return 2;
  return 3;
}

function reasonFor(t: SituationPacket['threats'][number]): string {
  const parts = [`${CATEGORY_LABEL[t.category]} ${t.name} ${RING_LABEL[t.ring]}`];
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

// --- Template narrator (fallback, also the keyless default) -----------

function templateNarrate(packet: SituationPacket): { summary: string; recommendations: EvacuationRecommendation[] } {
  const name = packet.fireName ?? packet.fireId;
  const area =
    packet.perimeterAreaKm2 != null
      ? ` The observed perimeter covers ${packet.perimeterAreaKm2.toFixed(0)} km2.`
      : ' No satellite perimeter has been observed yet.';
  // Gate on the computed heading, never a fallback literal: without a real
  // bearing the report must not invent one.
  const spread =
    packet.spreadHorizonHours > 0 && packet.spreadCompass != null && packet.spreadBearingDeg != null
      ? ` Projection over the next ${packet.spreadHorizonHours} h drifts ${packet.spreadCompass}` +
        ` (bearing ${Math.round(packet.spreadBearingDeg) % 360} deg), so spread is expected toward ${packet.spreadCompass}.`
      : packet.spreadHorizonHours > 0
        ? ` Projection over the next ${packet.spreadHorizonHours} h, no drift heading available.`
        : ' No spread projection is available.';
  const frp = ` ${packet.hotspotCount} satellite hotspots, total FRP ${Math.round(packet.totalFrpMw)} MW, first detected ${packet.firstDetectedAt.slice(0, 10)}.`;

  const insideCount = packet.threats.filter((t) => t.ring === 'inside').length;
  const corridorCount = packet.corridorCount;
  let threatLine: string;
  if (packet.threats.length === 0) {
    // An empty list means nothing is inside the rings when the fire is in the
    // covered region, and no data exists there otherwise; the claim must say
    // which one it is.
    threatLine =
      packet.infrastructureCoverage != null
        ? ` No bundled infrastructure within 20 km (coverage: ${packet.infrastructureCoverage.label}).`
        : ' No bundled infrastructure within 20 km, and this region is outside the infrastructure coverage area, so an empty list does not mean the area is safe.';
  } else {
    const bits: string[] = [];
    if (insideCount > 0) bits.push(`${insideCount} asset(s) already inside the perimeter`);
    if (corridorCount > 0) bits.push(`${corridorCount} in the projected spread corridor`);
    bits.push(`${packet.threats.length} threatened within 20 km`);
    threatLine = ` ${bits.join(', ')}.`;
  }

  const summary =
    `Situation report for fire ${name}.${area}${spread}${frp}${threatLine} ` +
    `Evacuation priorities below are ordered by proximity and projected impact.`;

  const recommendations = packet.threats.map((t) => ({
    assetId: t.assetId,
    name: t.name,
    category: t.category,
    ring: t.ring,
    distanceKm: t.distanceKm,
    inSpreadCorridor: t.inSpreadCorridor,
    reason: reasonFor(t),
    priority: recommendationPriority(t),
  }));

  return { summary, recommendations };
}

// --- LLM narrator ----------------------------------------------------

const LLM_BASE_URL = process.env.LLM_BASE_URL ?? 'https://api.openai.com/v1';
const LLM_API_KEY = process.env.LLM_API_KEY ?? '';
const LLM_MODEL = process.env.LLM_MODEL ?? 'gpt-4o-mini';
const LLM_TIMEOUT_MS = 15000;
const LLM_SUMMARY_MAX_CHARS = 1200;
const LLM_CACHE_TTL_MS = 60000;

const SYSTEM_PROMPT = `You are the situation officer of a wildfire intelligence console.
You receive a JSON situation packet with computed figures (perimeter area, spread heading, threat list).
Write a plain-language situation summary of AT MOST 6 sentences for emergency decision-makers.
Rules:
- Narrate only what is in the packet. Never invent numbers, asset names, or facts.
- Reference figures exactly as given (areas, distances, counts).
- If the packet's threats array is empty and infrastructureCoverage is null, say the region is outside the infrastructure data coverage; do not claim nothing is at risk.
- If the packet's threats array is empty and infrastructureCoverage is set, state that no bundled assets fall within the threat rings.
- Neutral, operational tone. No emojis, no markdown headings.
Return JSON: {"summary": string}`;

interface LlmChoice { message?: { content?: string } }

// Numeric cross-check: every number the summary states must be traceable to
// the packet, otherwise the model invented one and the response is discarded
// in favor of the template. A number passes when it appears in the serialized
// packet JSON, one of the packet's counts and rounded figures, the ring
// radii, the detection date components, or an asset name: those are
// packet-derived vocabulary a faithful summary is expected to print. Counts
// are not serialized by JSON.stringify (an array carries no length field), so
// they are added explicitly.
const RING_RADII = new Set(['5', '10', '20']);

function numbersGroundedInPacket(summary: string, packet: SituationPacket): boolean {
  const haystacks: string[] = [
    JSON.stringify(packet),
    String(packet.hotspotCount),
    String(packet.threats.length),
    String(packet.corridorCount),
    String(Math.round(packet.totalFrpMw)),
    String(packet.spreadHorizonHours),
    ...(packet.spreadBearingDeg != null ? [String(Math.round(packet.spreadBearingDeg) % 360)] : []),
    ...(packet.perimeterAreaKm2 != null ? [String(Math.round(packet.perimeterAreaKm2))] : []),
    packet.firstDetectedAt.slice(0, 10),
    packet.lastDetectedAt.slice(0, 10),
    ...RING_RADII,
    ...packet.threats.map((t) => t.name),
  ];
  const haystack = haystacks.join(' ');

  const stated = summary.match(/\d+(?:\.\d+)?/g) ?? [];
  for (const num of stated) {
    if (!haystack.includes(num)) return false;
  }
  return true;
}

// One completion per fire per TTL, and one in flight at a time, so reselect
// does not re-pay the round trip.
const llmCache = new Map<string, { summary: string; expiresAt: number }>();
const llmInFlight = new Map<string, Promise<string | null>>();

async function llmNarrateUncached(packet: SituationPacket): Promise<string | null> {
  if (!LLM_API_KEY) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS);
  try {
    const res = await fetch(`${LLM_BASE_URL.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${LLM_API_KEY}`,
      },
      body: JSON.stringify({
        model: LLM_MODEL,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: JSON.stringify(packet) },
        ],
        temperature: 0.2,
      }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`LLM returned ${res.status}`);
    // No response_format here: it is OpenAI-specific and some compatible
    // servers reject it, so we rely on the prompt asking for pure JSON and
    // tolerate a failure by falling back to the template.
    const body = (await res.json()) as { choices?: LlmChoice[] };
    const content = body.choices?.[0]?.message?.content;
    if (!content) throw new Error('LLM response missing content');
    const parsed = JSON.parse(content) as { summary?: unknown };
    if (typeof parsed.summary !== 'string' || parsed.summary.trim() === '') {
      throw new Error('LLM summary not a non-empty string');
    }
    const summary = parsed.summary.trim();
    if (summary.length > LLM_SUMMARY_MAX_CHARS) {
      throw new Error(`LLM summary exceeds ${LLM_SUMMARY_MAX_CHARS} chars`);
    }
    if (!numbersGroundedInPacket(summary, packet)) {
      throw new Error('LLM summary states numbers not present in the packet');
    }
    return summary;
  } catch (err) {
    console.warn('[situation] LLM narration failed, falling back to template:', err instanceof Error ? err.message : err);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function llmNarrate(packet: SituationPacket): Promise<string | null> {
  if (!LLM_API_KEY) return null;
  const now = Date.now();
  const hit = llmCache.get(packet.fireId);
  if (hit && hit.expiresAt > now) return hit.summary;
  const pending = llmInFlight.get(packet.fireId);
  if (pending) return pending;

  const task = llmNarrateUncached(packet).then((summary) => {
    if (summary != null) {
      llmCache.set(packet.fireId, { summary, expiresAt: Date.now() + LLM_CACHE_TTL_MS });
    }
    return summary;
  });
  llmInFlight.set(packet.fireId, task);
  try {
    return await task;
  } finally {
    llmInFlight.delete(packet.fireId);
  }
}

// --- Packet assembly -------------------------------------------------

export async function getSituation(fireId: string): Promise<SituationResponse | null> {
  // One fires fetch for both the packet and the threat analysis, so the
  // figures cannot come from different snapshots.
  const fires = await getFires();
  const cluster = fires.clusters.find((c) => c.id === fireId);
  if (!cluster) return null;
  const threats = await getThreats(fireId, fires);
  if (!threats) return null;

  const perimeter = latestPerimeter(fires, fireId);

  const steps = fires.spread
    .filter((s) => s.clusterId === fireId && s.horizonHours > 0 && s.polygon.length >= 4)
    .sort((a, b) => a.horizonHours - b.horizonHours);
  const furthest = steps.length > 0 ? steps[steps.length - 1] : null;

  // With no observed perimeter the bearing still derives from the cluster
  // centroid, matching how the threat analysis substitutes a point disc.
  const from = perimeter ? ringCentroid(perimeter.polygon) : cluster.centroid;
  const to = furthest ? ringCentroid(furthest.polygon) : null;
  const drift = from && to ? driftBearing(from, to) : null;

  const areaKm2 = perimeter
    ? perimeter.areaKm2 > 0
      ? perimeter.areaKm2
      : ringAreaKm2(perimeter.polygon)
    : null;

  const situationThreats = threats.threatened.map((t) => ({
    assetId: t.assetId,
    name: t.name,
    category: t.category,
    ring: t.ring,
    distanceKm: t.distanceKm,
    inSpreadCorridor: t.inSpreadCorridor,
  }));

  const packet: SituationPacket = {
    fireId,
    fireName: cluster.name,
    dataProvenance: fires.provenance,
    perimeterAreaKm2: areaKm2,
    perimeterObservedAt: perimeter?.observedAt ?? null,
    spreadHorizonHours: furthest?.horizonHours ?? 0,
    spreadBearingDeg: drift != null ? Math.round(((drift % 360) + 360) % 360 * 10) / 10 : null,
    spreadCompass: drift != null ? compassLabel(drift) : null,
    totalFrpMw: cluster.totalFrpMw,
    hotspotCount: cluster.hotspotIds.length,
    firstDetectedAt: cluster.firstDetectedAt,
    lastDetectedAt: cluster.lastDetectedAt,
    threats: situationThreats,
    corridorCount: threats.corridorCount,
    infrastructureCoverage: pointInCoverage(cluster.centroid) ? INFRASTRUCTURE_COVERAGE : null,
    computedAt: new Date().toISOString(),
  };

  const template = templateNarrate(packet);
  const llmSummary = await llmNarrate(packet);

  const recommendations = template.recommendations.sort(
    (a, b) =>
      a.priority - b.priority ||
      RING_SEVERITY[a.ring] - RING_SEVERITY[b.ring] ||
      Number(b.inSpreadCorridor) - Number(a.inSpreadCorridor) ||
      CATEGORY_WEIGHT[a.category] - CATEGORY_WEIGHT[b.category] ||
      a.distanceKm - b.distanceKm,
  );

  return {
    fireId,
    summary: llmSummary ?? template.summary,
    recommendations,
    narrator: llmSummary != null ? 'llm' : 'template',
    packet,
  };
}
