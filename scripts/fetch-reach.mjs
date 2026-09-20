#!/usr/bin/env node
// Fetch OpenCelliD cells for the demo region into a committed fixture.
//
// Reach is the over-alerting number: how many people a cell broadcast would wake for a fire
// that does not threaten them. It needs the cells, and the cells come from an API that is
// rate-limited, keyed, and refuses any box over 4,000,000 m² — so the fetch happens here,
// once, and the engine reads `data/reach/cells.json`.
//
// Run: node scripts/fetch-reach.mjs
//   OPENCELLID_TOKEN must be set, in the environment or in .env.
//
// WHY THE FAILURE ACCOUNTING IS THE POINT. The API fails per tile, and coverage is stored as
// "cells found". A tile whose request failed therefore looks exactly like a tile with no
// towers in it — and the honest reading of the region's coverage turns into an artefact of
// the network. So the script counts the tiles it could not complete, names them, and writes
// that count into the fixture beside the cells. A reader can then tell "no coverage here"
// from "we did not manage to ask".

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_PATH = resolve(HERE, '../data/reach/cells.json');
const ENV_PATH = resolve(HERE, '../.env');

/** The demo region: the fire, the settlements around it, and a margin. */
// Sized to the five settlements the engine reasons about, plus a margin: the region a
// broadcast for this fire could plausibly reach. Not the whole province, because the API
// meters requests and a box over 4,000,000 m² is refused, so the area is paid for in calls.
const REGION = { south: 37.12, west: -2.062, north: 37.264, east: -1.831 };

const MAX_AREA_M2 = 4_000_000;
const REQUEST_TIMEOUT_MS = 30_000;
const RETRIES = 3;
const DEFAULT_BASE = 'https://opencellid.org';

function readToken() {
  if (process.env.OPENCELLID_TOKEN) return process.env.OPENCELLID_TOKEN;
  let env;
  try {
    env = readFileSync(ENV_PATH, 'utf8');
  } catch {
    throw new Error(`no OPENCELLID_TOKEN in the environment and no .env at ${ENV_PATH}`);
  }
  const line = env.split('\n').find((l) => /^\s*OPENCELLID_TOKEN\s*=/.test(l));
  if (!line) throw new Error(`OPENCELLID_TOKEN is not set in ${ENV_PATH}`);
  const value = line.slice(line.indexOf('=') + 1).trim().replace(/^["']|["']$/g, '');
  if (!value) throw new Error('OPENCELLID_TOKEN is present but empty');
  return value;
}

// The tiling lives in server/reach.ts so its arithmetic is testable without a network call.
// Duplicated here in four lines rather than imported, because this script is .mjs and the
// module is TypeScript; the test in reach.test.ts asserts the tiling respects the limit, and
// this script asserts it again on its own output below.
const M_PER_DEG_LAT = 110_977;
const metresPerDegLon = (lat) => Math.max(1, 111_320 * Math.cos((lat * Math.PI) / 180));

function tileBounds(bounds, maxAreaM2) {
  const midLat = (bounds.south + bounds.north) / 2;
  const sideM = Math.sqrt(maxAreaM2);
  const dLat = sideM / M_PER_DEG_LAT;
  const dLon = sideM / metresPerDegLon(midLat);
  const tiles = [];
  const stepsLat = Math.max(1, Math.ceil((bounds.north - bounds.south) / dLat));
  const stepsLon = Math.max(1, Math.ceil((bounds.east - bounds.west) / dLon));
  for (let i = 0; i < stepsLat; i++) {
    for (let j = 0; j < stepsLon; j++) {
      tiles.push({
        south: bounds.south + (i * (bounds.north - bounds.south)) / stepsLat,
        north: bounds.south + ((i + 1) * (bounds.north - bounds.south)) / stepsLat,
        west: bounds.west + (j * (bounds.east - bounds.west)) / stepsLon,
        east: bounds.west + ((j + 1) * (bounds.east - bounds.west)) / stepsLon,
      });
    }
  }
  return tiles;
}

const areaOf = (t) => {
  const midLat = (t.south + t.north) / 2;
  return (t.north - t.south) * M_PER_DEG_LAT * (t.east - t.west) * metresPerDegLon(midLat);
};

const cellId = (c) => [c.mcc, c.mnc, c.lac, c.cellid].map((v) => String(v ?? '?')).join('-');

async function fetchTile(tile, token, base) {
  const bbox = [tile.south, tile.west, tile.north, tile.east].map((v) => v.toFixed(5)).join(',');
  const url = `${base}/cell/getInArea?key=${encodeURIComponent(token)}&BBOX=${bbox}&format=json`;
  let lastError;
  for (let attempt = 1; attempt <= RETRIES; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      const body = await res.text();
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${body.slice(0, 120)}`);
      const parsed = JSON.parse(body);
      // The API reports refusals in the body with a 200 in some deployments, so a body-level
      // error is treated as a failure rather than as an empty tile.
      if (parsed && typeof parsed === 'object' && parsed.error) {
        throw new Error(`API refused: ${parsed.error}`);
      }
      if (!Array.isArray(parsed.cells)) throw new Error(`no cells array: ${body.slice(0, 120)}`);
      return { ok: true, cells: parsed.cells };
    } catch (err) {
      lastError = err;
      if (attempt < RETRIES) await new Promise((r) => setTimeout(r, 500 * attempt));
    }
  }
  return { ok: false, bbox, reason: lastError instanceof Error ? lastError.message : String(lastError) };
}

async function main() {
  const token = readToken();
  const base = process.env.OPENCELLID_BASE_URL ?? DEFAULT_BASE;
  const tiles = tileBounds(REGION, MAX_AREA_M2);

  // Asserted on the script's own output, not only in the module: the API's limit is what the
  // tiling exists for, and a box over it is refused with a message that reads like a data
  // problem rather than a request problem.
  const over = tiles.filter((t) => areaOf(t) > MAX_AREA_M2);
  if (over.length > 0) throw new Error(`${over.length} of ${tiles.length} tiles exceed ${MAX_AREA_M2} m²`);

  console.log(`[reach] ${tiles.length} tiles over ${JSON.stringify(REGION)}`);

  const byId = new Map();
  const failed = [];
  for (const [index, tile] of tiles.entries()) {
    const result = await fetchTile(tile, token, base);
    if (result.ok) {
      for (const cell of result.cells) byId.set(cellId(cell), cell);
      process.stdout.write(`\r[reach] ${index + 1}/${tiles.length} tiles, ${byId.size} cells, ${failed.length} failed`);
    } else {
      failed.push(result);
    }
    // The API is metered; a small gap between requests is cheaper than a ban.
    await new Promise((r) => setTimeout(r, 250));
  }
  process.stdout.write('\n');

  const cells = [...byId.values()];
  const measured = cells.filter((c) => typeof c.range === 'number' && c.range !== 1000).length;
  const payload = {
    source: 'OpenCelliD',
    endpoint: `${base}/cell/getInArea`,
    fetchedAt: new Date().toISOString(),
    region: REGION,
    maxAreaM2: MAX_AREA_M2,
    tilesRequested: tiles.length,
    // The number that makes the coverage claim readable. A failed tile and an empty tile are
    // the same observation from outside; this is what tells them apart.
    tilesFailed: failed.length,
    failures: failed,
    cells,
    measuredRangeCells: measured,
  };

  mkdirSync(dirname(OUT_PATH), { recursive: true });
  writeFileSync(OUT_PATH, `${JSON.stringify(payload, null, 1)}\n`);
  console.log(
    `[reach] wrote ${cells.length} cells to ${OUT_PATH} ` +
      `(${measured} with a non-fallback range, ${failed.length} tiles failed)`,
  );
  if (failed.length > 0) {
    console.warn(`[reach] ${failed.length} tiles could not be fetched — coverage in those boxes is UNKNOWN, not empty`);
    for (const f of failed) console.warn(`[reach]   ${f.bbox}: ${f.reason}`);
  }
}

main().catch((err) => {
  console.error(`[reach] ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
