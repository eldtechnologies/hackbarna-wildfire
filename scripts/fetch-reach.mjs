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

// The token rides in the query string, and upstream transport text comes back through every
// failure path: `reason` -> `failures` -> the COMMITTED fixture -> the unauthenticated
// `/api/reach` response, and to stderr. Reproduced against the live API: a 401 returns
// `{"error":"API Key not known: <key>","code":2}`, so an expired, revoked or simply wrong key
// puts itself in the repository and in its history with no misconfiguration required. A
// malformed base URL throws a TypeError quoting the whole URL, key included.
//
// Scrubbed at the one place a reason is built, rather than at each of the places one is stored,
// so a new caller cannot reintroduce the leak. Both encodings, because an upstream may echo
// either form back.
function safeText(text, token) {
  let out = String(text);
  // Three encodings, because a mirror or proxy may echo any of them: the raw key, the
  // query-string form `encodeURIComponent` produces, and the FORM-encoded form, which differs
  // from both whenever the key holds a character encodeURIComponent leaves alone but
  // application/x-www-form-urlencoded escapes — `!`, `'`, `(`, `)`, `*` and space. An
  // alphanumeric key makes all three identical, which is why this is easy to miss.
  for (const form of [token, encodeURIComponent(token), new URLSearchParams({ k: token }).toString().slice(2)]) {
    if (form) out = out.split(form).join('<redacted>');
  }
  // Control characters would let an upstream — or a mirror set through OPENCELLID_BASE_URL —
  // write terminal escapes into a CI log from inside the fixture. The C0 range alone was not
  // enough: C1 (U+0080–U+009F, including the 8-bit CSI at U+009B) and the bidi overrides
  // (U+202A–U+202E, U+2066–U+2069) are the same trick spelled differently.
  out = out.replace(/[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/g, ' ');
  return out.length > 160 ? `${out.slice(0, 160)}...` : out;
}

/** The statuses that mean the credential was refused rather than this one request failing. */
const isAuthFailure = (status) => status === 401 || status === 403;

async function fetchTile(tile, token, base) {
  const bbox = [tile.south, tile.west, tile.north, tile.east].map((v) => v.toFixed(5)).join(',');
  const url = `${base}/cell/getInArea?key=${encodeURIComponent(token)}&BBOX=${bbox}&format=json`;
  let lastError;
  for (let attempt = 1; attempt <= RETRIES; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      const body = await res.text();
      if (!res.ok) {
        // SCRUB FIRST, BOUND SECOND. `safeText(body.slice(0, 120), token)` truncates before the
        // scrub runs, so a key straddling the cut is never matched and its surviving PREFIX is
        // written to the committed fixture and republished on `/api/reach`. Reproduced: a body
        // padded so the key began at index 100 put 20 of its 24 characters into the fixture.
        const detail = safeText(body, token).slice(0, 120);
        // A refused credential fails every tile identically. Retrying the other 87 and then
        // writing what they returned produces a fixture with no cells that reads as "this region
        // has no towers" — the empty-reads-as-fact inversion, plus a key in the file.
        if (isAuthFailure(res.status)) {
          return { ok: false, bbox, reason: `HTTP ${res.status}: ${detail}`, fatal: true };
        }
        throw new Error(`HTTP ${res.status}: ${detail}`);
      }
      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch {
        // Deliberately NOT `err.message`. `JSON.parse`'s SyntaxError QUOTES the opening of the body
        // — `Unexpected token 'K', "Kf3c1d9e2b..." is not valid JSON` — so a non-JSON response that
        // begins with the key puts a PREFIX of it into a string that no exact-match scrub can
        // match, because the token is not present in full anywhere. Verified: 10 characters of a
        // 36-character key reached the committed fixture and then the unauthenticated `/api/reach`.
        // A scrub cannot close this class, so the parser's own words are never persisted: only a
        // length, which is a number and carries nothing.
        throw new Error(`the response body was not JSON (${body.length} bytes)`);
      }
      // The API reports refusals in the body with a 200 in some deployments, so a body-level
      // error is treated as a failure rather than as an empty tile.
      if (parsed && typeof parsed === 'object' && parsed.error) {
        // Bounded and scrubbed like the body path: `parsed.error` is an upstream-controlled
        // string, and a mirror configured through OPENCELLID_BASE_URL controls it entirely.
        throw new Error(`API refused: ${safeText(parsed.error, token)}`);
      }
      if (!Array.isArray(parsed.cells)) {
        throw new Error(`no cells array: ${safeText(body, token).slice(0, 120)}`);
      }
      return { ok: true, cells: parsed.cells };
    } catch (err) {
      lastError = err;
      if (attempt < RETRIES) await new Promise((r) => setTimeout(r, 500 * attempt));
    }
  }
  // Scrubbed again here rather than only at the construction sites above, because a fetch-level
  // TypeError carries the whole URL and is built by the runtime, not by this file.
  return {
    ok: false,
    bbox,
    reason: safeText(lastError instanceof Error ? lastError.message : String(lastError), token),
  };
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
    } else if (result.fatal) {
      // Abort here rather than fail 88 tiles and write what is left. A refused credential is not a
      // coverage fact about the region, and writing the result would replace a good fixture with
      // an empty one that reads as "these villages have no towers".
      throw new Error(
        `the API refused the credential at tile ${index + 1}/${tiles.length}: ${result.reason}\n` +
          '        check OPENCELLID_TOKEN in .env. No fixture was written.',
      );
    } else {
      failed.push(result);
    }
    // The API is metered; a small gap between requests is cheaper than a ban.
    await new Promise((r) => setTimeout(r, 250));
  }
  process.stdout.write('\n');

  const cells = [...byId.values()];
  const measured = cells.filter((c) => typeof c.range === 'number' && c.range !== 1000).length;

  // The usability rule `servedFootprints` applies, duplicated for the same reason the tiling is:
  // this script is .mjs and cannot import the TypeScript module. It matters because counting cells
  // is not counting USABLE cells — a survey whose entries carry no position or no radius passes a
  // `cells.length` test, reports `0 tiles failed`, and exits 0, and the module then refuses the
  // fixture it was just handed. The failure would surface as a 502 against a file the script
  // called a success.
  //
  // Computed BEFORE the payload is built: the payload carries `unusableCells`, and declaring it
  // after the payload is a temporal-dead-zone crash at write time — which is how this was found,
  // by running the script rather than reading it.
  const usable = cells.filter(
    (c) =>
      typeof c.lat === 'number' && Number.isFinite(c.lat) &&
      typeof c.lon === 'number' && Number.isFinite(c.lon) &&
      typeof c.range === 'number' && Number.isFinite(c.range) && c.range > 0,
  );
  const unusableCells = cells.length - usable.length;

  // Refusing to write is the point here, not a nicety. A fixture with no usable cells makes
  // `loadFixture` throw and the endpoint answer 502, which is the loud failure this module wants —
  // but the fixture on disk would already have replaced a good one. Fail before the write, so the
  // bad survey never lands.
  if (usable.length === 0) {
    throw new Error(
      `none of the ${cells.length} cells returned by ${tiles.length} tiles has a usable position ` +
        `and radius; refusing to overwrite ${OUT_PATH} with a survey that would read as "no coverage"`,
    );
  }

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
    // Cells the module will refuse to turn into a footprint. Counted because a survey can complete
    // every tile and still be useless: the entries may carry no position or no radius, which a
    // `cells.length` test cannot see.
    unusableCells,
  };

  mkdirSync(dirname(OUT_PATH), { recursive: true });
  writeFileSync(OUT_PATH, `${JSON.stringify(payload, null, 1)}\n`);
  console.log(
    `[reach] wrote ${cells.length} cells to ${OUT_PATH} (${measured} with a non-fallback range, ` +
      `${unusableCells} unusable, ${failed.length} tiles failed)`,
  );
  if (unusableCells > 0) {
    console.warn(
      `[reach] ${unusableCells} cells have no usable position or radius — the module will refuse ` +
        'them, so they are recorded but do not become footprints',
    );
  }
  if (failed.length > 0) {
    console.warn(`[reach] ${failed.length} tiles could not be fetched — coverage in those boxes is UNKNOWN, not empty`);
    for (const f of failed) console.warn(`[reach]   ${f.bbox}: ${f.reason}`);
    // The fixture records the failures, but a caller reads the exit code, not the JSON. Exiting 0
    // made a partial re-run indistinguishable from a complete one, and it silently replaced a
    // full survey with a partial one.
    process.exitCode = 1;
    console.warn('[reach] exiting non-zero: the fixture is PARTIAL');
  }
}

main().catch((err) => {
  console.error(`[reach] ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
