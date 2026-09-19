// Mock Deepfire API server for rehearsal and offline testing. Speaks the OGC
// raw shape from server/providers/normalize.ts on three endpoints:
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
// Hotspots and clusters are OGC Features (geometry + properties), spread
// records are the plain mock shape the normalizer maps to perimeters
// (horizon 0) and projected steps (horizon > 0).

import http from 'node:http';

const PORT = Number(process.env.MOCK_PORT ?? 4590);
const SPEED = Number(process.env.MOCK_SPEED ?? 120); // sim seconds per real second

// Numeric confidence to the API's word scale (LOW|MEDIUM|HIGH).
function confidenceWord(value) {
  if (value >= 0.8) return 'HIGH';
  if (value >= 0.5) return 'MEDIUM';
  return 'LOW';
}

function hotspotFeature(id, lon, lat, frp, confidence, iso) {
  return {
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [lon, lat] },
    properties: {
      id,
      cluster_id: 'cl-01',
      observed_at: iso,
      source: 'MTG_I1',
      confidence: confidenceWord(confidence),
      fire_radiative_power: frp,
      country: 'ES',
      active: true,
    },
  };
}

const BASE_HOTSPOTS = [
  { id: 'hs-001', lat: 41.802, lon: 1.618, frp: 118.4, confidence: 0.97 },
  { id: 'hs-002', lat: 41.798, lon: 1.625, frp: 96.2, confidence: 0.93 },
  { id: 'hs-003', lat: 41.806, lon: 1.612, frp: 74.8, confidence: 0.88 },
  { id: 'hs-004', lat: 41.794, lon: 1.63, frp: 61.5, confidence: 0.85 },
  { id: 'hs-005', lat: 41.8, lon: 1.633, frp: 55, confidence: 0.82 },
  { id: 'hs-006', lat: 41.809, lon: 1.622, frp: 42.7, confidence: 0.79 },
  { id: 'hs-007', lat: 41.791, lon: 1.614, frp: 33.9, confidence: 0.74 },
  { id: 'hs-008', lat: 41.795, lon: 1.606, frp: 22.4, confidence: 0.68 },
  { id: 'hs-009', lat: 41.811, lon: 1.63, frp: 15.1, confidence: 0.61 },
  { id: 'hs-010', lat: 41.788, lon: 1.624, frp: 8.6, confidence: 0.55 },
];

const CLUSTER = { id: 'cl-01', centroid: { lat: 41.799, lon: 1.62 } };

const BASE_RING = [
  [1.62, 41.814], [1.633, 41.81], [1.638, 41.8], [1.633, 41.79], [1.62, 41.786],
  [1.607, 41.79], [1.602, 41.8], [1.607, 41.81], [1.62, 41.814],
];
const BASE_AREA_KM2 = 7.3;

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
  // Fires intensify as they grow: FRP scales with the perimeter.
  const hotspots = BASE_HOTSPOTS.map((h) =>
    hotspotFeature(
      h.id,
      h.lon,
      h.lat,
      Math.round(h.frp * scale * 10) / 10,
      Math.min(0.99, h.confidence + hours * 0.005),
      iso,
    ),
  );
  for (let i = 0; i < extraCount; i++) {
    const n = BASE_HOTSPOTS.length + i + 1;
    // New detections flare up along the spreading eastern edge.
    const edge = 1.63 + 0.012 * (i + 1) + hours * 0.002;
    const lat = 41.79 + 0.03 * ((i * 2.399) % 1);
    hotspots.push(
      hotspotFeature(
        `hs-${String(n).padStart(3, '0')}`,
        Math.round(edge * 1000) / 1000,
        Math.round(lat * 1000) / 1000,
        Math.round((20 + 15 * ((i * 1.7) % 1)) * 10) / 10,
        0.9,
        iso,
      ),
    );
  }

  const clusters = [
    {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [CLUSTER.centroid.lon, CLUSTER.centroid.lat] },
      properties: {
        id: CLUSTER.id,
        first_observed: simStartIso,
        last_observed: iso,
        active: true,
      },
    },
  ];

  const spread = [
    {
      cluster_id: CLUSTER.id,
      valid_time: iso,
      horizon_hours: 0,
      area_km2: Math.round(BASE_AREA_KM2 * scale * 10) / 10,
      geometry: { type: 'Polygon', coordinates: [scaleRing(BASE_RING, Math.sqrt(scale))] },
    },
  ];
  // Projected horizons keep growing with the current perimeter.
  for (const horizon of [2, 4, 6, 8]) {
    const hScale = GROWTH_PER_HOUR ** (hours + horizon);
    spread.push({
      cluster_id: CLUSTER.id,
      valid_time: new Date(simDate.getTime() + horizon * 3_600_000).toISOString(),
      horizon_hours: horizon,
      geometry: { type: 'Polygon', coordinates: [scaleRing(BASE_RING, Math.sqrt(hScale))] },
    });
  }

  return { hotspots, clusters, spread };
}

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
