// Fetch Catastro building footprints around each settlement into a committed fixture.
//
//     node scripts/fetch-pockets.mjs
//
// Catastro INSPIRE building footprints are the values-at-risk input. OSM cannot serve
// here: it carries 3 buildings within 1 km of Bédar, against 223 from Catastro for a
// single 500 m box.
//
// The service is fussy in three ways the spike documented and this script encodes:
//
//   * TYPENAMES is uppercase, and the type is bu:Building
//   * the CRS must be EPSG:25830 (ETRS89 / UTM 30N), not WGS84
//   * the bbox must be small — a large one is refused with "Area of extension out of
//     limits" — so each settlement is tiled in ~500 m boxes
//
// Output is raw footprints plus a convex hull per settlement, so the engine gets both a
// building count and a pocket polygon without a geometry library.

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(ROOT, 'data/pockets/buildings.json');
const SETTLEMENTS = resolve(ROOT, 'data/pockets/settlements.json');

const WFS = 'https://ovc.catastro.meh.es/INSPIRE/wfsBU.aspx';
const TILE_M = 500;
const HALF_SPAN_M = 1500;
const DELAY_MS = 350;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** WGS84 -> ETRS89 / UTM zone 30N. The central meridian is 3 degrees WEST. */
function utm30n(lat, lon) {
  const a = 6378137.0;
  const f = 1 / 298.257223563;
  const e2 = f * (2 - f);
  const k0 = 0.9996;
  const lon0 = -3.0;
  const rad = Math.PI / 180;
  const p = lat * rad;
  const l = (lon - lon0) * rad;
  const ep2 = e2 / (1 - e2);
  const N = a / Math.sqrt(1 - e2 * Math.sin(p) ** 2);
  const T = Math.tan(p) ** 2;
  const C = ep2 * Math.cos(p) ** 2;
  const A = Math.cos(p) * l;
  const M =
    a * ((1 - e2 / 4 - (3 * e2 ** 2) / 64) * p
      - ((3 * e2) / 8 + (3 * e2 ** 2) / 32) * Math.sin(2 * p)
      + ((15 * e2 ** 2) / 256) * Math.sin(4 * p));
  const E = k0 * N * (A + ((1 - T + C) * A ** 3) / 6 + ((5 - 18 * T + T * T) * A ** 5) / 120) + 500000.0;
  const Nn =
    k0 * (M + N * Math.tan(p) * ((A * A) / 2
      + ((5 - T + 9 * C + 4 * C * C) * A ** 4) / 24
      + ((61 - 58 * T + T * T) * A ** 6) / 720));
  return { E, N: Nn };
}

/** One building per <bu-ext2d:Building>, with its exterior ring from gml:posList. */
function parseBuildings(xml) {
  const out = [];
  for (const m of xml.matchAll(/<bu-ext2d:Building[^>]*gml:id="([^"]+)"([\s\S]*?)<\/bu-ext2d:Building>/g)) {
    const gmlId = m[1];
    const body = m[2];
    // The exterior ring is the first posList in the feature; interior rings (courtyards)
    // follow and are ignored, which is all a footprint count and a hull need.
    const pos = body.match(/<gml:exterior>[\s\S]*?<gml:posList[^>]*>([\s\S]*?)<\/gml:posList>/);
    if (!pos) continue;
    const nums = pos[1].trim().split(/\s+/).map(Number);
    if (nums.length < 6 || nums.length % 2 !== 0) continue;
    const ring = [];
    for (let i = 0; i + 1 < nums.length; i += 2) {
      if (Number.isFinite(nums[i]) && Number.isFinite(nums[i + 1])) ring.push([nums[i], nums[i + 1]]);
    }
    if (ring.length >= 3) out.push({ id: gmlId, ring });
  }
  return out;
}

/** Andrew's monotone chain. Enough for a pocket outline, no dependency. */
function convexHull(points) {
  if (points.length < 3) return points.slice();
  const pts = [...points].sort((p, q) => (p[0] - q[0]) || (p[1] - q[1]));
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper = [];
  for (const p of [...pts].reverse()) {
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

async function fetchBox(e, n, half) {
  const params = new URLSearchParams({
    service: 'WFS', version: '2.0.0', request: 'GetFeature',
    TYPENAMES: 'bu:Building', SRSNAME: 'EPSG:25830',
    BBOX: `${e - half},${n - half},${e + half},${n + half},EPSG:25830`,
    COUNT: '1000',
  });
  // Catastro is slow and occasionally holds a connection open indefinitely. Without a
  // deadline one hung request stalls the whole run, which is what happened on the first
  // attempt: fourteen minutes with no output and no way to tell progress from a stall.
  const res = await fetch(`${WFS}?${params}`, {
    headers: { 'User-Agent': 'ojo-de-fuego/0.1 (HackBarna 2026)' },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`Catastro WFS ${res.status}`);
  return res.text();
}

async function main() {
  const { settlements } = JSON.parse(await (await import('node:fs/promises')).readFile(SETTLEMENTS, 'utf8'));
  const out = {
    source: 'Catastro INSPIRE building footprints (bu:Building), WFS, EPSG:25830, tiled at 500 m. Coordinates converted to WGS84 for this fixture.',
    fetched: new Date().toISOString().slice(0, 10),
    tileMetres: TILE_M,
    settlements: [],
  };

  for (const s of settlements) {
    const centre = utm30n(s.lat, s.lon);
    const seen = new Map();
    let boxes = 0;
    // A failed box leaves buildings out of the hull and the count, so the pocket outline
    // and the clearance figure both come from partial data. Counted, and the run fails.
    const failedBoxes = [];
    const step = TILE_M;
    for (let dE = -HALF_SPAN_M; dE < HALF_SPAN_M; dE += step) {
      for (let dN = -HALF_SPAN_M; dN < HALF_SPAN_M; dN += step) {
        const e = centre.E + dE + step / 2;
        const n = centre.N + dN + step / 2;
        try {
          const xml = await fetchBox(e, n, step / 2);
          for (const b of parseBuildings(xml)) seen.set(b.id, b);
          boxes += 1;
          process.stdout.write(`\r  ${s.name.padEnd(15)} box ${String(boxes).padStart(2)}  ${String(seen.size).padStart(5)} buildings`);
        } catch (err) {
          console.warn(`\n  ${s.name}: box ${boxes} failed: ${err.message}`);
          failedBoxes.push(err.message);
        }
        await sleep(DELAY_MS);
      }
    }
    const rings = [...seen.values()].map((b) => b.ring);
    // gml:posList is `easting northing` pairs, so a ring point is [e, n] and the
    // centroid must be built in the same order. Reading it as [n, e] puts the hull in
    // the wrong hemisphere and every CAP polygon drawn from it off the coast of Africa.
    const centroids = rings.map((r) => [
      r.reduce((t, p) => t + p[0], 0) / r.length,
      r.reduce((t, p) => t + p[1], 0) / r.length,
    ]);
    const hull = convexHull(centroids);
    out.settlements.push({
      id: s.id,
      name: s.name,
      population: s.population,
      buildings: rings.length,
      // Hull of the building centroids, in UTM30N. The engine converts on load, so the
      // fixture stays in the CRS the source speaks and no conversion error is baked in.
      hullUtm30n: hull,
      failedBoxes: failedBoxes.length,
      centreUtm30n: [centre.E, centre.N],
      footprints: rings,
    });
    console.log(`  ${s.name.padEnd(15)} ${boxes} boxes -> ${rings.length} buildings, hull ${hull.length} points`);
  }

  const incomplete = out.settlements.filter((s) => s.failedBoxes > 0);
  if (incomplete.length > 0) {
    console.error(`[pockets] ${incomplete.length} settlement(s) had failed tiles; refusing to commit a partial fixture:`);
    for (const s of incomplete) console.error(`  ${s.name}: ${s.failedBoxes} box(es) failed`);
    console.error('[pockets] re-run when the service is available; the committed fixture is unchanged.');
    process.exitCode = 1;
    return;
  }

  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(out));
  console.log(`  -> ${OUT}`);
}

// The fixture stays in EPSG:25830 because that is what Catastro speaks, and converting
// on the way in would bake a projection error into the committed data with nothing to
// check it against. The engine converts on load.

main().catch((err) => {
  console.error('[pockets] failed:', err);
  process.exitCode = 1;
});
