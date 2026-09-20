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

// Rounded to 0.1 deg and normalized to [0, 360); a drift just under 360
// rounds to 360.0, which reads as a fourth rotation, so it maps to 0.
function normalizeBearingDeg(bearing: number): number {
  const norm = Math.round(((bearing % 360) + 360) % 360 * 10) / 10;
  return norm >= 360 ? 0 : norm;
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
  let spread: string;
  if (packet.spreadHorizonHours <= 0) {
    spread = ' No spread projection is available.';
  } else if (packet.spreadCompass == null || packet.spreadBearingDeg == null) {
    spread = ` Projection over the next ${packet.spreadHorizonHours} h, no drift heading available.`;
  } else {
    spread =
      ` Projection over the next ${packet.spreadHorizonHours} h drifts ${packet.spreadCompass}` +
      ` (bearing ${Math.round(packet.spreadBearingDeg) % 360} deg), so spread is expected toward ${packet.spreadCompass}.`;
  }

  const detected =
    packet.firstDetectedAt != null
      ? ` ${packet.hotspotCount} satellite hotspots, total FRP ${packet.totalFrpMw != null ? Math.round(packet.totalFrpMw) : 'unmeasured'} MW, first detected ${packet.firstDetectedAt.slice(0, 10)}.`
      : ` ${packet.hotspotCount} satellite hotspots, total FRP ${packet.totalFrpMw != null ? Math.round(packet.totalFrpMw) : 'unmeasured'} MW.`;

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
    `Situation report for fire ${name}.${area}${spread}${detected}${threatLine} ` +
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
// LLM_TIMEOUT_MS is the hard abort for the completion call. On the request
// path the template is already computed synchronously, so the panel waits
// LLM_REQUEST_BUDGET_MS at most for the LLM before the template answer ships;
// both are constants, not env overrides (the only configurable knob is
// LLM_API_KEY, per the README).
const LLM_TIMEOUT_MS = 15000;
const LLM_REQUEST_BUDGET_MS = 4000;
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

// Numeric cross-check: every number the summary states must equal a number
// the packet actually carries, otherwise the model invented one and the
// response is discarded in favor of the template. The allowed set is built
// explicitly from the packet's figures in raw and rendered form (counts,
// rounded values, ring radii, the detection date components, per-threat
// distances); membership is numeric, not substring, so "100" does not pass
// because "10" is allowed. Asset names are not enforced here: the prompt
// forbids inventing them, but string-level verification would false-reject
// ordinary capitalized prose, so the enforced guarantee is numeric only.
// This enforces "the model only narrates the packet" on the LLM output's
// figures.
const RING_RADII = [5, 10, 20]; // ring radii, from shared RING_RADII_KM vocabulary

function numbersGroundedInPacket(summary: string, packet: SituationPacket): boolean {
  const allowed = new Set<number>();
  const add = (n: number) => {
    if (Number.isFinite(n)) allowed.add(n);
  };
  add(packet.hotspotCount);
  add(packet.threats.length);
  add(packet.corridorCount);
  if (packet.totalFrpMw != null) {
    add(packet.totalFrpMw);
    add(Math.round(packet.totalFrpMw));
  }
  add(packet.spreadHorizonHours);
  if (packet.spreadBearingDeg != null) {
    add(packet.spreadBearingDeg);
    const norm = Math.round(((packet.spreadBearingDeg % 360) + 360) % 360);
    add(norm === 360 ? 0 : norm);
  }
  if (packet.perimeterAreaKm2 != null) {
    add(packet.perimeterAreaKm2);
    add(Math.round(packet.perimeterAreaKm2));
  }
  for (const r of RING_RADII) add(r);
  for (const t of packet.threats) {
    add(t.distanceKm);
    add(Number(t.distanceKm.toFixed(1)));
  }
  for (const at of [packet.firstDetectedAt, packet.lastDetectedAt]) {
    if (at == null) continue;
    // Date components (year, month, day) are packet-derived but small, so
    // they are only allowed when the summary actually states a date token:
    // otherwise a fabricated "12 structures" would pass because 12 matches
    // a month.
    const hasDateToken = new RegExp(at.slice(0, 10).replace(/-/g, '\\-')).test(summary);
    if (hasDateToken) {
      add(Number(at.slice(0, 4))); // year
      add(Number(at.slice(5, 7))); // month
      add(Number(at.slice(8, 10))); // day
    }
  }

  const stated = summary
    // "km2" is the area unit the template prints; its trailing 2 is not a
    // figure, so strip it before matching.
    .replace(/km2/gi, ' km ')
    .match(/\d+(?:\.\d+)?/g) ?? [];
  for (const num of stated) {
    if (!allowed.has(Number(num))) return false;
  }
  return true;
}

// One completion per fire and fires-snapshot per TTL, and one in flight at a
// time, so reselect does not re-pay the round trip. The key is
// fireId@fires.fetchedAt, which is stable while the fires memoization window
// (providers/index.ts) holds: same snapshot, same summary. A new snapshot
// (fresh data or a scrubbed timeline) stamps a new fetchedAt, so the key
// changes and the packet is narrated from its own data rather than reusing a
// summary for older data. The key must not use packet.computedAt: that
// changes on every request and would defeat the cache.
const llmCache = new Map<string, { summary: string; expiresAt: number }>();
const llmInFlight = new Map<string, Promise<string | null>>();

async function llmNarrateUncached(packet: SituationPacket): Promise<string | null> {
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

async function llmNarrate(packet: SituationPacket, snapshotKey: string): Promise<string | null> {
  // Fast-fail keyless: without a key there is nothing to call, so the
  // keyless demo works offline instead of hanging toward the request
  // timeout on an unauthenticated fetch.
  if (!LLM_API_KEY) return null;
  const key = `${packet.fireId}@${snapshotKey}`;
  const now = Date.now();
  const hit = llmCache.get(key);
  if (hit && hit.expiresAt > now) return hit.summary;
  const pending = llmInFlight.get(key);
  if (pending) return pending;

  // The template summary is already computed and is the fallback, so the
  // panel response waits at most LLM_REQUEST_BUDGET_MS for the narration
  // before shipping the template answer; the completion itself is aborted
  // by LLM_TIMEOUT_MS inside llmNarrateUncached.
  const task = llmNarrateUncached(packet).then((summary) => {
    if (summary != null) {
      llmCache.set(key, { summary, expiresAt: Date.now() + LLM_CACHE_TTL_MS });
    }
    return summary;
  });
  llmInFlight.set(key, task);
  const budget = new Promise<null>((resolve) =>
    setTimeout(() => resolve(null), LLM_REQUEST_BUDGET_MS),
  );
  try {
    return await Promise.race([task, budget]);
  } finally {
    llmInFlight.delete(key);
  }
}

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
    .filter((s) => s.clusterId === fireId && s.horizonHours > 0 && s.polygon.length >= 4)
    .sort((a, b) => a.horizonHours - b.horizonHours);
  const furthest = steps.length > 0 ? steps[steps.length - 1] : null;

  // With no observed perimeter the bearing still derives from the cluster
  // centroid, matching how the threat analysis substitutes a point disc.
  const from = perimeter ? ringCentroid(perimeter.polygon) : cluster.centroid;
  const to = furthest ? ringCentroid(furthest.polygon) : null;
  const drift = from && to ? driftBearing(from, to) : null;

  const areaKm2 = perimeter
    ? perimeter.areaKm2 != null && perimeter.areaKm2 > 0
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
    spreadBearingDeg: drift != null ? normalizeBearingDeg(drift) : null,
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
  const llmSummary = await llmNarrate(packet, fires.fetchedAt);

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
