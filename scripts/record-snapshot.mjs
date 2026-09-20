// Records a compatible observation endpoint's flat /hotspots, /clusters and
// /spread arrays. This is not an OGC API client. Capture times and source
// timestamps are preserved without adding simulated delivery or issue times.
// DEEPFIRE_BASE_URL=<compatible-endpoint> npm run record:snapshot -- --scenario capture
// Add --frames <n> --interval <seconds> to record multiple frames.

import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

const BASE_URL = process.env.DEEPFIRE_BASE_URL ?? '';
const API_KEY = process.env.DEEPFIRE_API_KEY ?? '';
const FETCH_TIMEOUT_MS = 8000;

function parseArgs() {
  const args = {
    scenario: 'capture',
    frames: 1,
    intervalSec: 30,
  };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--scenario') args.scenario = argv[++i];
    else if (argv[i] === '--frames') args.frames = Number(argv[++i]);
    else if (argv[i] === '--interval') args.intervalSec = Number(argv[++i]);
    else {
      console.error(`unknown argument: ${argv[i]}`);
      process.exit(1);
    }
  }
  if (!args.scenario || !Number.isFinite(args.frames) || args.frames < 1) {
    console.error('--scenario must be non-empty and --frames must be >= 1');
    process.exit(1);
  }
  if (!Number.isFinite(args.intervalSec) || args.intervalSec < 1) {
    console.error('--interval must be >= 1 second');
    process.exit(1);
  }
  return args;
}

async function fetchJson(endpoint) {
  if (!BASE_URL) {
    console.error('DEEPFIRE_BASE_URL is not set');
    process.exit(1);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(`${BASE_URL}${endpoint}`, {
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        Accept: 'application/json',
      },
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`${endpoint} returned ${res.status}`);
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

// Same payload shape the live provider requests. Arrays are validated so a
// half-baked API response never lands in the snapshot cache.
async function captureFrame() {
  const [hotspots, clusters, spread] = await Promise.all([
    fetchJson('/hotspots'),
    fetchJson('/clusters'),
    fetchJson('/spread'),
  ]);
  if (
    !Array.isArray(hotspots) ||
    !Array.isArray(clusters) ||
    !Array.isArray(spread)
  ) {
    throw new Error('API returned non-array payloads, refusing to record');
  }
  return { hotspots, clusters, spread };
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

const args = parseArgs();
const outDir = path.resolve(process.cwd(), 'data/snapshots');

try {
  await mkdir(outDir, { recursive: true });

  if (args.frames === 1) {
    // Flat snapshot: same shape as the other files in data/snapshots/.
    const frame = await captureFrame();
    const file = path.join(outDir, `${args.scenario}-${timestamp()}.json`);
    await writeFile(file, JSON.stringify({ scenario: args.scenario, dataKind: 'observations', ...frame }, null, 2));
    console.log(`[record] wrote ${file}`);
    process.exit(0);
  }

  // Multiple frames retain the actual capture clock.
  const frames = [];
  for (let i = 0; i < args.frames; i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, args.intervalSec * 1000));
    const payload = await captureFrame();
    frames.push({t: new Date().toISOString(), ...payload});
    console.log(`[record] frame ${i + 1}/${args.frames} captured`);
  }
  const file = path.join(outDir, `${args.scenario}-${timestamp()}.json`);
  const recording = {
    scenario: args.scenario,
    dataKind: 'observations',
    timeBasis: 'capture',
    recordedAt: new Date().toISOString(),
    intervalSeconds: args.intervalSec,
    frames,
  };
  await writeFile(file, JSON.stringify(recording, null, 2));
  console.log(`[record] wrote ${file} (${frames.length} frames)`);
} catch (err) {
  console.error('[record] failed:', err);
  process.exit(1);
}
