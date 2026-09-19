// Situation agent: assembles a structured packet for one fire from computed
// geometry (perimeter, spread projection, threat rings) and narrates it.
// The narrator (LLM or template) only phrases the packet; every number the
// client renders comes from these computed fields, never from the model.
// Any LLM failure falls back to the deterministic template narrator, so the
// endpoint always answers, keyless demos included.

import { getFires } from './providers';
import { getThreats } from './threats';
import { getInfrastructure } from './infrastructure';
import type { LatLon } from '../shared/fires';
import type { ThreatRing } from '../shared/threats';
import type {
  EvacuationRecommendation,
  SituationPacket,
  SituationResponse,
} from '../shared/situation';

const RING_SEVERITY: Record<ThreatRing, number> = {
  inside: 0,
  'ring-5km': 1,
  'ring-10km': 2,
  'ring-20km': 3,
};

const CATEGORY_WEIGHT: Record<EvacuationRecommendation['category'], number> = {
  hospital: 0,
  town: 1,
  school: 1,
  'power-line': 2,
};

const CATEGORY_LABEL: Record<EvacuationRecommendation['category'], string> = {
  hospital: 'hospital',
  town: 'town',
  school: 'school',
  'power-line': 'power line',
};

const RING_LABEL: Record<ThreatRing, string> = {
  inside: 'inside the fire perimeter',
  'ring-5km': 'within 5 km',
  'ring-10km': 'within 10 km',
  'ring-20km': 'within 20 km',
};

// 16-point compass label for a bearing.
function compassLabel(deg: number): string {
  const points = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
  return points[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16];
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

function ringCentroid(ring: LatLon[]): LatLon {
  let lat = 0;
  let lon = 0;
  for (const p of ring) {
    lat += p.lat;
    lon += p.lon;
  }
  return { lat: lat / ring.length, lon: lon / ring.length };
}

function ringAreaKm2(ring: LatLon[]): number {
  // Spherical excess (shoelace on the sphere), same approach as the client
  // spread model. Ring is a closed loop (first point repeated at the end).
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
// population and distance as tie-breakers.

function recommendationPriority(t: SituationPacket['threats'][number]): 1 | 2 | 3 {
  if (t.ring === 'inside' || (t.ring === 'ring-5km' && t.inSpreadCorridor)) return 1;
  if (t.ring === 'ring-5km' || (t.ring === 'ring-10km' && t.inSpreadCorridor)) return 2;
  return 3;
}

function reasonFor(t: SituationPacket['threats'][number]): string {
  const parts = [`${CATEGORY_LABEL[t.category]} ${t.name} ${RING_LABEL[t.ring]}`];
  if (t.ring !== 'inside') parts[0] += ` (${t.distanceKm.toFixed(1)} km)`;
  if (t.inSpreadCorridor) parts.push('in the projected spread corridor');
  if (t.population != null) parts.push(`population ${t.population.toLocaleString('en-US')}`);
  return parts.join(', ');
}

// --- Template narrator (fallback, also the keyless default) -----------

function templateNarrate(packet: SituationPacket): { summary: string; recommendations: EvacuationRecommendation[] } {
  const name = packet.fireName ?? packet.fireId;
  const area =
    packet.perimeterAreaKm2 != null
      ? ` The observed perimeter covers ${packet.perimeterAreaKm2.toFixed(0)} km2.`
      : ' No satellite perimeter has been observed yet.';
  const spread =
    packet.spreadHorizonHours > 0
      ? ` Projection over the next ${packet.spreadHorizonHours} h drifts ${packet.spreadCompass ?? '?'}` +
        ` (bearing ${Math.round(packet.spreadBearingDeg ?? 0)} deg), so spread is expected toward ${packet.spreadCompass ?? '?'}.`
      : ' No spread projection is available.';
  const frp = ` ${packet.hotspotCount} satellite hotspots, total FRP ${Math.round(packet.totalFrpMw)} MW, first detected ${packet.firstDetectedAt.slice(0, 10)}.`;

  const insideCount = packet.threats.filter((t) => t.ring === 'inside').length;
  const corridorCount = packet.corridorCount;
  let threatLine: string;
  if (packet.threats.length === 0) {
    threatLine = ' No infrastructure or population centers fall within 20 km.';
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
    population: t.population,
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

const SYSTEM_PROMPT = `You are the situation officer of a wildfire intelligence console.
You receive a JSON situation packet with computed figures (perimeter area, spread bearing, threat list).
Write a plain-language situation summary of AT MOST 6 sentences for emergency decision-makers.
Rules:
- Narrate only what is in the packet. Never invent numbers, asset names, or facts.
- Reference figures exactly as given (areas, distances, populations, counts).
- Neutral, operational tone. No emojis, no markdown headings.
Return JSON: {"summary": string}`;

interface LlmChoice { message?: { content?: string } }

async function llmNarrate(packet: SituationPacket): Promise<string | null> {
  if (!LLM_API_KEY) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS);
  try {
    const res = await fetch(`${LLM_BASE_URL}/chat/completions`, {
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
        response_format: { type: 'json_object' },
      }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`LLM returned ${res.status}`);
    const body = (await res.json()) as { choices?: LlmChoice[] };
    const content = body.choices?.[0]?.message?.content;
    if (!content) throw new Error('LLM response missing content');
    const parsed = JSON.parse(content) as { summary?: unknown };
    if (typeof parsed.summary !== 'string' || parsed.summary.trim() === '') {
      throw new Error('LLM summary not a non-empty string');
    }
    return parsed.summary.trim();
  } catch (err) {
    console.warn('[situation] LLM narration failed, falling back to template:', err instanceof Error ? err.message : err);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// --- Packet assembly -------------------------------------------------

export async function getSituation(fireId: string): Promise<SituationResponse | null> {
  const [fires, threats] = await Promise.all([getFires(), getThreats(fireId)]);
  if (!threats) return null;

  const cluster = fires.clusters.find((c) => c.id === fireId);
  if (!cluster) return null;

  // Latest observed perimeter (same pick as the threat analysis and the
  // client spread model: most recent observedAt).
  let perimeter = null as (typeof fires.perimeters)[number] | null;
  for (const p of fires.perimeters) {
    if (p.clusterId === fireId && (!perimeter || p.observedAt > perimeter.observedAt)) {
      perimeter = p;
    }
  }

  const steps = fires.spread
    .filter((s) => s.clusterId === fireId && s.horizonHours > 0)
    .sort((a, b) => a.horizonHours - b.horizonHours);
  const furthest = steps.length > 0 ? steps[steps.length - 1] : null;

  const centroid = perimeter ? ringCentroid(perimeter.polygon) : cluster.centroid;
  const spreadBearingDeg = perimeter && furthest
    ? bearingDeg(centroid, ringCentroid(furthest.polygon))
    : null;

  const areaKm2 = perimeter
    ? perimeter.areaKm2 > 0
      ? perimeter.areaKm2
      : ringAreaKm2(perimeter.polygon)
    : null;

  // Enrich threatened towns with population (the threat analysis returns
  // positions already, but not population).
  const { assets } = await getInfrastructure();
  const populationByAsset = new Map(assets.map((a) => [a.id, a.population]));

  const situationThreats = threats.threatened.map((t) => ({
    assetId: t.assetId,
    name: t.name,
    category: t.category,
    ring: t.ring,
    distanceKm: t.distanceKm,
    inSpreadCorridor: t.inSpreadCorridor,
    population: t.category === 'town' ? populationByAsset.get(t.assetId) ?? null : null,
  }));

  const packet: SituationPacket = {
    fireId,
    fireName: cluster.name,
    dataProvenance: fires.provenance,
    perimeterAreaKm2: areaKm2,
    perimeterObservedAt: perimeter?.observedAt ?? null,
    spreadHorizonHours: furthest?.horizonHours ?? 0,
    spreadBearingDeg: spreadBearingDeg != null ? Math.round(((spreadBearingDeg + 360) % 360) * 10) / 10 : null,
    spreadCompass: spreadBearingDeg != null ? compassLabel(spreadBearingDeg) : null,
    totalFrpMw: cluster.totalFrpMw,
    hotspotCount: cluster.hotspotIds.length,
    firstDetectedAt: cluster.firstDetectedAt,
    lastDetectedAt: cluster.lastDetectedAt,
    threats: situationThreats,
    corridorCount: threats.corridorCount,
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
      (b.population ?? 0) - (a.population ?? 0) ||
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
