// Mock Deepfire API server for rehearsal and offline testing. Speaks the
// mocked raw shape from server/providers/normalize.ts on three endpoints:
//   GET /hotspots  GET /clusters  GET /spread
//
// The fire evolves on a simulated clock that starts at real boot time and
// then runs MOCK_SPEED times faster: the perimeter grows ~12% per simulated
// hour, one hotspot appears per simulated hour (up to 8 extra), and spread
// horizons are projected 2/4/6/8h ahead of the current perimeter. MOCK_SPEED
// sets simulated seconds per real second (default 120 = 1 real minute is
// 2 simulated hours), so a short recording captures hours of fire growth.
//
//   MOCK_SPEED=120 MOCK_PORT=4590 npm run mock:deepfire
//
// The mock derives its base state from data/snapshots/castelltallat-2025.json
// when present, otherwise it falls back to the castelltallat geometry baked
// in below. Swap the baked-in state when the real Deepfire spec arrives.

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';

const PORT = Number(process.env.MOCK_PORT ?? 4590);
const SPEED = Number(process.env.MOCK_SPEED ?? 120); // sim seconds per real second
const BASE_FILE = path.resolve(process.cwd(), 'data/snapshots/castelltallat-2025.json');

const BASE = {
  hotspots: [
    { id: 'hs-001', latitude: 41.802, longitude: 1.618, frp: 118.4, confidence: 0.97, acq_datetime: 'T0', cluster_id: 'cl-01' },
    { id: 'hs-002', latitude: 41.798, longitude: 1.625, frp: 96.2, confidence: 0.93, acq_datetime: 'T0', cluster_id: 'cl-01' },
    { id: 'hs-003', latitude: 41.806, longitude: 1.612, frp: 74.8, confidence: 0.88, acq_datetime: 'T0', cluster_id: 'cl-01' },
    { id: 'hs-004', latitude: 41.794, longitude: 1.63, frp: 61.5, confidence: 0.85, acq_datetime: 'T0', cluster_id: 'cl-01' },
    { id: 'hs-005', latitude: 41.8, longitude: 1.633, frp: 55, confidence: 0.82, acq_datetime: 'T0', cluster_id: 'cl-01' },
    { id: 'hs-006', latitude: 41.809, longitude: 1.622, frp: 42.7, confidence: 0.79, acq_datetime: 'T0', cluster_id: 'cl-01' },
    { id: 'hs-007', latitude: 41.791, longitude: 1.614, frp: 33.9, confidence: 0.74, acq_datetime: 'T0', cluster_id: 'cl-01' },
    { id: 'hs-008', latitude: 41.795, longitude: 1.606, frp: 22.4, confidence: 0.68, acq_datetime: 'T0', cluster_id: 'cl-01' },
    { id: 'hs-009', latitude: 41.811, longitude: 1.63, frp: 15.1, confidence: 0.61, acq_datetime: 'T0', cluster_id: 'cl-01' },
    { id: 'hs-010', latitude: 41.788, longitude: 1.624, frp: 8.6, confidence: 0.55, acq_datetime: 'T0', cluster_id: 'cl-01' },
  ],
  clusters: [
    {
      id: 'cl-01',
      label: 'IF Castelltallat',
      centroid: { lat: 41.799, lon: 1.62 },
      hotspot_ids: ['hs-001', 'hs-002', 'hs-003', 'hs-004', 'hs-005', 'hs-006', 'hs-007', 'hs-008', 'hs-009', 'hs-010'],
      first_seen: 'T0',
      last_seen: 'T0',
    },
  ],
  spread: [
    {
      cluster_id: 'cl-01',
      valid_time: 'T0',
      horizon_hours: 0,
      area_km2: 7.3,
      geometry: { type: 'Polygon', coordinates: [[
        [1.62, 41.814], [1.633, 41.81], [1.638, 41.8], [1.633, 41.79], [1.62, 41.786],
        [1.607, 41.79], [1.602, 41.8], [1.607, 41.81], [1.62, 41.814],
      ]] },
    },
  ],
};

async function loadBase() {
  try {
    const parsed = JSON.parse(await readFile(BASE_FILE, 'utf8'));
    if (Array.isArray(parsed.hotspots) && Array.isArray(parsed.clusters) && Array.isArray(parsed.spread)) {
      console.log('[mock] base state from castelltallat-2025.json');
      // The snapshot mixes string and numeric confidences. Normalize to
      // numbers so the growth math below stays numeric.
      const CONFIDENCE = { low: 0.3, nominal: 0.65, high: 0.9 };
      parsed.hotspots = parsed.hotspots.map((h) => ({
        ...h,
        confidence: typeof h.confidence === 'number' ? h.confidence : (CONFIDENCE[h.confidence] ?? 0.5),
      }));
      return parsed;
    }
  } catch {
    // fall through to baked-in state
  }
  console.log('[mock] base state from baked-in geometry');
  return BASE;
}

const bootWall = Date.now();
const bootSimMs = Date.now(); // sim clock starts at real boot time
const simStartIso = new Date(bootSimMs).toISOString();

function simNow() {
  return new Date(bootSimMs + (Date.now() - bootWall) * SPEED);
}

// Simulated hours elapsed since boot.
function simHours() {
  return ((Date.now() - bootWall) * SPEED) / 3_600_000;
}

// Scale a ring around its center by the given factor.
function scaleRing(ring, factor) {
  let clat = 0;
  let clon = 0;
  for (const [lon, lat] of ring) {
    clat += lat;
    clon += lon;
  }
  clat /= ring.length;
  clon /= ring.length;
  return ring.map(([lon, lat]) => [clon + (lon - clon) * factor, clat + (lat - clat) * factor]);
}

const GROWTH_PER_HOUR = 1.12; // perimeter area grows ~12% per simulated hour
const NEW_HOTSPOT_INTERVAL_H = 1; // one new hotspot per simulated hour
const MAX_EXTRA_HOTSPOTS = 8;

function stateAt(simDate, hours) {
  const scale = GROWTH_PER_HOUR ** hours;
  const iso = simDate.toISOString();

  const extraCount = Math.min(MAX_EXTRA_HOTSPOTS, Math.floor(hours / NEW_HOTSPOT_INTERVAL_H));
  const baseCount = BASE.hotspots.length;
  const hotspots = BASE.hotspots.map((h) => ({
    ...h,
    // Fires intensify as they grow: FRP scales with the perimeter.
    frp: Math.round(h.frp * scale * 10) / 10,
    confidence: Math.round(Math.min(0.99, h.confidence + hours * 0.005) * 1000) / 1000,
    acq_datetime: iso,
  }));
  for (let i = 0; i < extraCount; i++) {
    const h = baseCount + i + 1;
    // New detections flare up along the spreading eastern edge.
    const edge = 1.63 + 0.012 * (i + 1) + hours * 0.002;
    const lat = 41.79 + 0.03 * ((i * 2.399) % 1);
    hotspots.push({
      id: `hs-${String(h).padStart(3, '0')}`,
      latitude: Math.round(lat * 1000) / 1000,
      longitude: Math.round(edge * 1000) / 1000,
      frp: Math.round((20 + 15 * ((i * 1.7) % 1)) * 10) / 10,
      confidence: 'high',
      acq_datetime: iso,
      cluster_id: 'cl-01',
    });
  }

  const clusters = BASE.clusters.map((c) => ({
    ...c,
    hotspot_ids: hotspots.map((h) => h.id),
    first_seen: simStartIso,
    last_seen: iso,
  }));

  const spread = [];
  for (const s of BASE.spread) {
    const ring = s.geometry.coordinates[0];
    const perimeter = scaleRing(ring, Math.sqrt(scale));
    const perimeterArea = Math.round((s.area_km2 * scale) * 10) / 10;
    spread.push({
      cluster_id: s.cluster_id,
      valid_time: iso,
      horizon_hours: 0,
      area_km2: perimeterArea,
      geometry: { type: 'Polygon', coordinates: [perimeter] },
    });
    // Projected horizons keep growing with the current perimeter.
    for (const horizon of [2, 4, 6, 8]) {
      const hScale = GROWTH_PER_HOUR ** (hours + horizon);
      spread.push({
        cluster_id: s.cluster_id,
        valid_time: new Date(simDate.getTime() + horizon * 3_600_000).toISOString(),
        horizon_hours: horizon,
        geometry: { type: 'Polygon', coordinates: [scaleRing(ring, Math.sqrt(hScale))] },
      });
    }
  }

  return { hotspots, clusters, spread };
}

const base = await loadBase();
// Replace BASE hotspots/cluster/spread with the loaded state when available,
// so the mock derives from the real snapshot when present.
BASE.hotspots = base.hotspots ?? BASE.hotspots;
BASE.clusters = base.clusters ?? BASE.clusters;
BASE.spread = (base.spread ?? []).filter((s) => (s.horizon_hours ?? 0) <= 0);

const server = http.createServer((req, res) => {
  const simDate = simNow();
  const hours = simHours();
  const state = stateAt(simDate, hours);

  const routes = {
    '/hotspots': state.hotspots,
    '/clusters': state.clusters,
    '/spread': state.spread,
  };
  const body = routes[req.url?.split('?')[0]];
  res.setHeader('Content-Type', 'application/json');
  if (body) {
    res.end(JSON.stringify(body));
  } else {
    res.statusCode = 404;
    res.end(JSON.stringify({ error: 'not found' }));
  }
});

server.listen(PORT, () => {
  console.log(`[mock] Deepfire mock on http://localhost:${PORT} (speed ${SPEED}x, sim clock ${simNow().toISOString()})`);
});
