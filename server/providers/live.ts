// Live provider: fetches hotspots, clusters and observed perimeters from the
// Deepfire OGC API Features collections, through this server, so the API key
// never reaches the browser.
//
// Two measured API facts shape this client (19 Sep 2026):
//
//   1. There is no `numberMatched`. The client pages until it gets a short page.
//   2. `startIndex` is unreliable on a wide bbox. The same query returns 200 at
//      offset 0 and 500 at offset 1000, and a wide unfiltered bbox returns 500
//      outright. A one-day Iberia window returns 200.
//
// So the client chunks the time range into days and retries 5xx with backoff.
// It never issues one whole-range query.

import {
  normalize,
  type RawCluster,
  type RawFiresPayload,
  type RawHotspot,
  type RawPerimeter,
} from './normalize';
import type { FireDataProvider, FiresResponse } from '../../shared/fires';

const BASE_URL = process.env.DEEPFIRE_BASE_URL ?? 'https://api.deepfire.co';
const API_KEY = process.env.DEEPFIRE_API_KEY ?? '';
const COLLECTIONS = `${BASE_URL}/ogc/features/v1/collections`;

// Iberia bounds, as west,south,east,north.
const BBOX = process.env.DEEPFIRE_BBOX ?? '-10,35,4,44';
const WINDOW_HOURS = Number(process.env.DEEPFIRE_WINDOW_HOURS ?? 24);
// Off by default is wrong here: without it the globe draws every detection since
// January 2025 instead of the live fire.
const ACTIVE_ONLY = (process.env.DEEPFIRE_ACTIVE_ONLY ?? 'true') !== 'false';

const PAGE_LIMIT = 1000;
const FETCH_TIMEOUT_MS = 20_000;
const MAX_ATTEMPTS = 3;
const DAY_MS = 24 * 60 * 60 * 1000;

interface OgcFeaturePage<T> {
  features?: T[];
}

function isRetryable(err: unknown): boolean {
  return err instanceof Error && /returned 5\d\d/.test(err.message);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fetchPage<T>(path: string): Promise<T[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(`${COLLECTIONS}${path}`, {
      headers: { Authorization: `Bearer ${API_KEY}`, Accept: 'application/geo+json' },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`Deepfire ${path} returned ${res.status}`);
    const body = (await res.json()) as OgcFeaturePage<T>;
    return body.features ?? [];
  } finally {
    clearTimeout(timer);
  }
}

async function fetchPaged<T>(basePath: string): Promise<T[]> {
  const out: T[] = [];
  for (let start = 0; ; start += PAGE_LIMIT) {
    let page: T[] | null = null;
    let lastErr: unknown = null;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      try {
        page = await fetchPage<T>(`${basePath}&limit=${PAGE_LIMIT}&startIndex=${start}`);
        break;
      } catch (err) {
        lastErr = err;
        // Retry only 5xx. A 4xx is a bad request and will not get better.
        if (!isRetryable(err)) throw err;
        await sleep(500 * 2 ** attempt);
      }
    }
    if (page === null) throw lastErr ?? new Error('Deepfire page failed');
    out.push(...page);
    if (page.length < PAGE_LIMIT) break;
  }
  return out;
}

function itemPath(collection: string, from: Date, to: Date): string {
  const params = new URLSearchParams({
    bbox: BBOX,
    'filter-lang': 'cql2-text',
    filter: `observed_at >= '${from.toISOString()}' AND observed_at <= '${to.toISOString()}'`
      + (ACTIVE_ONLY ? ' AND active = true' : ''),
    f: 'application/geo+json',
  });
  return `/${collection}/items?${params.toString()}`;
}

// The clusters and perimeters collections carry no time field we filter on here;
// bbox plus the active flag is enough for the live view.
function plainPath(collection: string): string {
  const params = new URLSearchParams({
    bbox: BBOX,
    f: 'application/geo+json',
    ...(ACTIVE_ONLY ? { 'filter-lang': 'cql2-text', filter: 'active = true' } : {}),
  });
  return `/${collection}/items?${params.toString()}`;
}

async function fetchHotspots(): Promise<RawHotspot[]> {
  const now = new Date();
  const first = new Date(now.getTime() - WINDOW_HOURS * 60 * 60 * 1000);
  const all: RawHotspot[] = [];
  // One day per request. A wide range returns 500 on the second page.
  for (let start = first.getTime(); start < now.getTime(); start += DAY_MS) {
    const from = new Date(start);
    const to = new Date(Math.min(start + DAY_MS, now.getTime()));
    all.push(...(await fetchPaged<RawHotspot>(itemPath('deepfire:hotspots', from, to))));
  }
  return all;
}

export class LiveProvider implements FireDataProvider {
  readonly mode = 'live' as const;

  async getFires(): Promise<FiresResponse> {
    if (!API_KEY) {
      throw new Error('DEEPFIRE_API_KEY is not set');
    }
    const [hotspots, clusters, perimeters] = await Promise.all([
      fetchHotspots(),
      fetchPaged<RawCluster>(plainPath('deepfire:clusters')),
      fetchPaged<RawPerimeter>(plainPath('deepfire:satellite-perimeters')),
    ]);
    const payload: RawFiresPayload = { hotspots, clusters, perimeters };
    return normalize(payload, 'live', null);
  }
}