// Fetch the drivable road network around Los Gallardos and Bédar into a committed graph.
//
//     node scripts/fetch-roads.mjs
//
// Run once; the output is committed so the demo never touches the network. Re-run only
// when the bbox or the road classes need to change.
//
// Why the OSM /map API rather than the sources docs/work-plan.md decision 7 names:
//
//   * The local Overpass is gone — nothing listens on 127.0.0.1:12345, the `opdb` Docker
//     volume does not exist, and /tmp/df/osm/andalucia.osm.pbf is absent.
//   * Every public Overpass mirror is unreachable or serving canned empties.
//     overpass.osm.ch returns HTTP 200 with ways=0 for Barcelona, Madrid and all of
//     Andalucia, with a nonsense osm3s timestamp.
//   * Geofabrik does work (andalucia-latest.osm.pbf, 194 MB, real PBF, Sort.Type_then_ID).
//     That remains the fallback if a wider bbox is ever needed — see the note at the
//     bottom of this file — but it needs a PBF reader dependency and a 194 MB download
//     to produce the 600 KB of roads this actually needs.
//
// The /map endpoint is rate-limited and caps at 50,000 nodes per request, so the bbox is
// tiled and requests are spaced. Usage policy: https://operations.osmfoundation.org/policies/api/

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(ROOT, 'data/graph/los-gallardos.json');

// Covers the fire and every destination the egress solve can route to. A graph clipped
// around Bédar alone would leave every pocket with no route out.
const BBOX = { latMin: 37.08, latMax: 37.3, lonMin: -2.1, lonMax: -1.82 };
// The /map endpoint caps at 50,000 nodes per request and answers 400 above it, so tile
// size is set by node density, not area: the coastal strip around Mojácar and Garrucha
// needs tiles a third this size.
const TILE = { lat: 0.055, lon: 0.07, minLat: 0.012, minLon: 0.016 };
const DELAY_MS = 1200;

const HIGHWAY_SPEED_KMH = {
  motorway: 100, motorway_link: 60, trunk: 90, trunk_link: 60,
  primary: 80, primary_link: 50, secondary: 70, secondary_link: 45,
  tertiary: 60, tertiary_link: 40, unclassified: 50, residential: 30,
  living_street: 20, service: 20, track: 15, road: 30,
};

const ONEWAY_FORWARD = new Set(['yes', 'true', '1']);
const ONEWAY_REVERSE = new Set(['-1', 'reverse']);
const IMPLICIT_ONEWAY = new Set(['motorway', 'motorway_link', 'trunk', 'trunk_link']);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function decodeEntities(s) {
  return s
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, '&');
}

/**
 * Parse OSM XML into nodes and ways.
 *
 * Deliberately a scanner rather than a full XML parser: the /map output is machine
 * generated with a fixed attribute order, and this avoids a dependency for a build-time
 * script. It skips <relation> entirely — relations carry turn restrictions and route
 * refs that the egress solve does not use.
 */
function parseOsmXml(xml) {
  const nodes = new Map();
  for (const m of xml.matchAll(/<node\s+id="(-?\d+)"[^>]*?lat="(-?[\d.]+)"\s+lon="(-?[\d.]+)"/g)) {
    nodes.set(Number(m[1]), { lat: Number(m[2]), lon: Number(m[3]) });
  }
  const ways = [];
  for (const m of xml.matchAll(/<way\s+id="(-?\d+)"[^>]*>([\s\S]*?)<\/way>/g)) {
    const body = m[2];
    const tags = {};
    for (const t of body.matchAll(/<tag\s+k="([^"]*)"\s+v="([^"]*)"\s*\/>/g)) {
      tags[decodeEntities(t[1])] = decodeEntities(t[2]);
    }
    if (!tags.highway || !(tags.highway in HIGHWAY_SPEED_KMH)) continue;
    const refs = [...body.matchAll(/<nd\s+ref="(-?\d+)"/g)].map((r) => Number(r[1]));
    if (refs.length < 2) continue;
    const geometry = refs.map((r) => nodes.get(r)).filter(Boolean);
    if (geometry.length < 2) continue;
    ways.push({ id: `way/${m[1]}`, tags, geometry });
  }
  return { nodes, ways };
}

async function fetchTile(latMin, lonMin, latMax, lonMax) {
  const url =
    `https://api.openstreetmap.org/api/0.6/map?bbox=` +
    `${lonMin.toFixed(7)},${latMin.toFixed(7)},${lonMax.toFixed(7)},${latMax.toFixed(7)}`;
  const res = await fetch(url, { headers: { 'User-Agent': 'ojo-de-fuego/0.1 (HackBarna 2026)' } });
  if (res.ok) return res.text();
  const body = await res.text().catch(() => '');
  const tooBig = res.status === 400 && /too many nodes/i.test(body);
  const err = new Error(`OSM /map ${res.status}: ${body.slice(0, 80)}`);
  err.tooBig = tooBig;
  throw err;
}

/**
 * Fetch a region, quartering it whenever the server says the request is too large.
 * Density varies enormously across this bbox — farmland against the Mojácar coast —
 * so a fixed tile size either blows the node cap or wastes requests.
 */
async function collectRegion(latMin, lonMin, latMax, lonMax, ways) {
  const midLat = (latMin + latMax) / 2;
  const midLon = (lonMin + lonMax) / 2;
  const spanLat = latMax - latMin;
  const spanLon = lonMax - lonMin;

  process.stdout.write(
    `[roads] tile ${latMin.toFixed(3)},${lonMin.toFixed(3)} ${spanLat.toFixed(3)}x${spanLon.toFixed(3)} ... `,
  );
  let xml;
  try {
    xml = await fetchTile(latMin, lonMin, latMax, lonMax);
  } catch (err) {
    const splittable = err.tooBig && spanLat > TILE.minLat && spanLon > TILE.minLon;
    if (!splittable) {
      console.log(`SKIPPED (${err.message})`);
      return 0;
    }
    console.log('too many nodes, splitting');
    await sleep(DELAY_MS);
    let n = 0;
    for (const [a, b, c, d] of [
      [latMin, lonMin, midLat, midLon], [latMin, midLon, midLat, lonMax],
      [midLat, lonMin, latMax, midLon], [midLat, midLon, latMax, lonMax],
    ]) {
      n += await collectRegion(a, b, c, d, ways);
    }
    return n;
  }

  const parsed = parseOsmXml(xml);
  let added = 0;
  for (const w of parsed.ways) if (!ways.has(w.id)) { ways.set(w.id, w); added += 1; }
  console.log(`${parsed.ways.length} ways (${added} new)`);
  await sleep(DELAY_MS);
  return 1;
}

async function main() {
  const ways = new Map();
  let tiles = 0;
  for (let lat = BBOX.latMin; lat < BBOX.latMax; lat += TILE.lat) {
    for (let lon = BBOX.lonMin; lon < BBOX.lonMax; lon += TILE.lon) {
      tiles += await collectRegion(
        lat, lon,
        Math.min(lat + TILE.lat, BBOX.latMax),
        Math.min(lon + TILE.lon, BBOX.lonMax),
        ways,
      );
    }
  }

  // Graph nodes go at junctions, not merely at way ends.
  //
  // OSM convention says ways are split at intersections, but rural Spain does not
  // follow it: a `track` routinely runs straight through a junction that another way
  // terminates at. Keying nodes on way endpoints alone leaves those ways touching
  // without connecting — measured on this bbox, it produced 1,695 weakly-connected
  // components with the largest holding only a fifth of the nodes, and no route could
  // cross between them. Every vertex shared by two ways must become a node.
  const key = (p) => `${p.lat.toFixed(7)},${p.lon.toFixed(7)}`;
  const appearances = new Map();
  for (const way of ways.values()) {
    const pts = way.geometry;
    pts.forEach((p, i) => {
      const k = key(p);
      const entry = appearances.get(k) ?? { count: 0, endpoint: false };
      entry.count += 1;
      if (i === 0 || i === pts.length - 1) entry.endpoint = true;
      appearances.set(k, entry);
    });
  }
  const isNode = (p) => {
    const entry = appearances.get(key(p));
    return entry ? entry.count >= 2 || entry.endpoint : false;
  };

  const edges = [];
  const nodeKey = new Map();
  const nodes = [];
  const indexOf = (p) => {
    const k = key(p);
    let idx = nodeKey.get(k);
    if (idx === undefined) {
      idx = nodes.length;
      nodes.push({ lat: p.lat, lon: p.lon });
      nodeKey.set(k, idx);
    }
    return idx;
  };

  for (const way of ways.values()) {
    const oneway = way.tags.oneway ?? '';
    const implicit = IMPLICIT_ONEWAY.has(way.tags.highway) || way.tags.junction === 'roundabout';
    const forward = !ONEWAY_REVERSE.has(oneway);
    const backward = !ONEWAY_FORWARD.has(oneway) && !implicit;
    const name = way.tags.name ?? way.tags.ref ?? null;
    const highway = way.tags.highway;
    const points = way.geometry;

    // Split the way into runs between consecutive junctions, keeping every vertex in
    // the run so distances stay accurate and a segment's id means a whole stretch of
    // road rather than one 20 m hop.
    const cutIndices = [0];
    for (let i = 1; i < points.length - 1; i++) if (isNode(points[i])) cutIndices.push(i);
    cutIndices.push(points.length - 1);

    for (let c = 0; c + 1 < cutIndices.length; c++) {
      const run = points.slice(cutIndices[c], cutIndices[c + 1] + 1);
      if (run.length < 2) continue;
      const travelSeconds = Math.max(1, Math.round((polylineKm(run) / HIGHWAY_SPEED_KMH[highway]) * 3600));
      const fromIdx = indexOf(run[0]);
      const toIdx = indexOf(run[run.length - 1]);
      if (fromIdx === toIdx) continue;
      const suffix = cutIndices.length > 2 ? `#${c}` : '';
      if (forward) {
        edges.push({
          id: `${way.id}${suffix}`, from: fromIdx, to: toIdx,
          geometry: run, highway, name, travelSeconds,
        });
      }
      if (backward) {
        edges.push({
          id: `${way.id}${suffix}#rev`, from: toIdx, to: fromIdx,
          geometry: [...run].reverse(), highway, name, travelSeconds,
        });
      }
    }
  }

  // Drop self-loops: they cannot improve a label and only add edges to walk.
  const kept = edges.filter((e) => e.from !== e.to);

  const outgoing = Array.from({ length: nodes.length }, () => []);
  const incoming = Array.from({ length: nodes.length }, () => []);
  kept.forEach((e, i) => {
    outgoing[e.from].push(i);
    incoming[e.to].push(i);
  });

  // Geometry is stored once per undirected way-run, and a reversed edge points at the
  // same entry. Storing the reverse copy inline doubled the file for no information.
  const geometryRows = [];
  const geometryKey = new Map();
  /** Key on the two endpoints in canonical order, so a reverse edge reuses the row. */
  const geometryIndexOf = (points) => {
    const a = `${points[0].lat.toFixed(6)},${points[0].lon.toFixed(6)}`;
    const b = `${points[points.length - 1].lat.toFixed(6)},${points[points.length - 1].lon.toFixed(6)}`;
    const k = `${a < b ? a + '|' + b : b + '|' + a}|${points.length}`;
    let idx = geometryKey.get(k);
    if (idx === undefined) {
      idx = geometryRows.length;
      geometryRows.push(points.map((p) => [Number(p.lat.toFixed(6)), Number(p.lon.toFixed(6))]));
      geometryKey.set(k, idx);
    }
    return idx;
  };

  const rows = kept.map((e) => {
    const reversed = e.id.endsWith('#rev');
    return {
      id: e.id,
      from: e.from,
      to: e.to,
      highway: e.highway,
      name: e.name,
      travelSeconds: e.travelSeconds,
      geometryIndex: geometryIndexOf(e.geometry),
      // The loader needs to know whether to walk the shared row forwards or backwards.
      reversed,
    };
  });

  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(
    OUT,
    `${JSON.stringify({
      source: 'OpenStreetMap via api.openstreetmap.org /api/0.6/map (ODbL 1.0)',
      fetched: new Date().toISOString().slice(0, 10),
      bbox: [BBOX.latMin, BBOX.lonMin, BBOX.latMax, BBOX.lonMax],
      speedByHighway: HIGHWAY_SPEED_KMH,
      nodes: nodes.map((p) => [Number(p.lat.toFixed(6)), Number(p.lon.toFixed(6))]),
      geometries: geometryRows,
      edges: rows,
      outgoing,
      incoming,
    })}\n`,
  );

  const names = kept.filter((e) => e.name).length;
  console.log(
    `[roads] ${tiles} tiles -> ${ways.size} ways, ${nodes.length} nodes, ${kept.length} directed edges ` +
      `(${names} named), ${geometryRows.length} distinct geometries -> ${OUT}`,
  );
}

function polylineKm(points) {
  let total = 0;
  for (let i = 0; i + 1 < points.length; i++) {
    const dLat = (points[i + 1].lat - points[i].lat) * 110977;
    const dLon = (points[i + 1].lon - points[i].lon) * 111320 * Math.cos((points[i].lat * Math.PI) / 180);
    total += Math.hypot(dLat, dLon);
  }
  return total / 1000;
}

// Fallback if a wider bbox is ever needed: download
// https://download.geofabrik.de/europe/spain/andalucia-latest.osm.pbf (194 MB, verified
// real and Sort.Type_then_ID), stream it with a PBF reader, keep nodes inside the bbox
// plus highway ways, and emit the same graph shape. That path needs an added dependency;
// this one does not.

main().catch((err) => {
  console.error('[roads] failed:', err);
  process.exitCode = 1;
});
