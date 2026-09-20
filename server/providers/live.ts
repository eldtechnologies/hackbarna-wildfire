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
// So the client chunks the time range into half-open day windows and retries 5xx
// with backoff. It never issues one whole-range query.
//
// All three collections are bounded to the SAME window, so a live response is one
// coherent slice of time rather than hotspots from 24 h beside clusters and
// perimeter outlines from any date.

import {
  normalize,
  type RawCluster,
  type RawFiresPayload,
  type RawHotspot,
  type RawPerimeter,
} from './normalize';
import type { FireDataProvider, FiresResponse } from '../../shared/fires';

const DEFAULT_BASE_URL = 'https://api.deepfire.co';
const DEFAULT_ALLOWED_HOSTS = ['api.deepfire.co'];

// Iberia bounds, as west,south,east,north.
const BBOX = process.env.DEEPFIRE_BBOX ?? '-10,35,4,44';
const API_KEY = process.env.DEEPFIRE_API_KEY ?? '';

// Off by default is wrong here: without it the globe draws every detection since
// January 2025 instead of the live fire. Exclusion is the SERVER's contract; the
// client never re-filters, because the replay snapshot is all-active.
const ACTIVE_ONLY = (process.env.DEEPFIRE_ACTIVE_ONLY ?? 'true') !== 'false';

const PAGE_LIMIT = 1000;
const FETCH_TIMEOUT_MS = 20_000;
const MAX_ATTEMPTS = 3;
const MAX_PAGES_PER_COLLECTION = 200;
const DAY_MS = 24 * 60 * 60 * 1000;

// A positive, finite hour count. A typo in a documented variable must not silently
// empty a layer, and it must not throw at import time either: providers/index.ts
// builds the provider on load, so an import-time throw kills the server instead
// of reaching the replay fallback.
export function readWindowHours(raw: string | undefined): number {
  const n = Number(raw ?? 24);
  if (Number.isFinite(n) && n > 0) return n;
  console.warn(`[live] DEEPFIRE_WINDOW_HOURS="${raw}" is not a positive number; using 24`);
  return 24;
}

const WINDOW_HOURS = readWindowHours(process.env.DEEPFIRE_WINDOW_HOURS);

// A malformed base URL must fail loudly at construction rather than producing a
// nonsense endpoint. Plaintext is refused, and the host must be allowlisted so a
// redirect or a typo cannot point the collection queries at another origin.
export function parseBaseUrl(raw: string | undefined): string {
  const url = new URL(raw ?? DEFAULT_BASE_URL);
  if (url.protocol !== 'https:') {
    throw new Error(`DEEPFIRE_BASE_URL must use https, got "${url.protocol}"`);
  }
  const allowed = (process.env.DEEPFIRE_ALLOWED_HOSTS ?? '')
    .split(',')
    .map((h) => h.trim())
    .filter(Boolean);
  const hosts = allowed.length > 0 ? allowed : DEFAULT_ALLOWED_HOSTS;
  if (!hosts.includes(url.host)) {
    throw new Error(
      `DEEPFIRE_BASE_URL host "${url.host}" is not allowlisted. ` +
        `Add it to DEEPFIRE_ALLOWED_HOSTS to use a mirror.`,
    );
  }
  return `${url.origin}${url.pathname.replace(/\/$/, '')}`;
}

// Resolved per call, never at module load: providers/index.ts builds the provider
// on import, so a throw here would kill the server in every mode — including
// replay — instead of reaching the replay fallback.
function collectionsBase(): string {
  return `${parseBaseUrl(process.env.DEEPFIRE_BASE_URL)}/ogc/features/v1/collections`;
}

interface OgcFeaturePage<T> {
  features?: T[];
}

// The HTTP status travels on the error, so retry decisions never depend on the
// wording of a message.
export class UpstreamError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'UpstreamError';
  }
}

export function isRetryable(err: unknown): boolean {
  // A dropped connection, a timeout or an explicit abort is worth another try.
  if (err instanceof UpstreamError) return err.status >= 500 || err.status === 429;
  return err instanceof Error && err.name === 'AbortError'
    ? true
    : err instanceof TypeError; // fetch failed (DNS, connection reset, TLS)
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// `features` is required on an OGC FeatureCollection. Anything else — an error
// envelope, a truncated proxy response, a bare array — is a broken upstream, not
// an empty page. Reading it as empty would resolve with zero of everything and
// still report `provenance: 'live'`, so it throws and the caller falls back.
export function requireFeatures<T>(body: unknown, path: string): T[] {
  const features = (body as OgcFeaturePage<T> | null)?.features;
  if (!Array.isArray(features)) {
    throw new Error(`Deepfire ${path} returned a body that is not a FeatureCollection`);
  }
  return features;
}

// Redirects are refused: a 3xx would let the upstream move the collection query
// to another origin. The key travels in the Authorization header, so this is a
// trust control, not a convenience.
export function requestInit(signal: AbortSignal): RequestInit {
  return {
    headers: { Authorization: `Bearer ${API_KEY}`, Accept: 'application/geo+json' },
    signal,
    redirect: 'error',
  };
}

async function fetchPage<T>(base: string, path: string, signal: AbortSignal): Promise<T[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(`${base}${path}`, requestInit(AbortSignal.any([controller.signal, signal])));
    if (!res.ok) throw new UpstreamError(res.status, `Deepfire ${path} returned ${res.status}`);
    return requireFeatures<T>(await res.json(), path);
  } finally {
    clearTimeout(timer);
  }
}

// Termination rests on a short page, so an upstream that always returns full
// pages would hang /api/fires forever and the replay fallback would never fire,
// because the promise would never settle. The cap turns that into a throw.
export async function pageAll<T>(
  fetchOne: (start: number) => Promise<T[]>,
  maxPages = MAX_PAGES_PER_COLLECTION,
): Promise<T[]> {
  const out: T[] = [];
  for (let start = 0, pages = 0; ; start += PAGE_LIMIT, pages += 1) {
    if (pages >= maxPages) {
      throw new Error(`Deepfire paging exceeded ${maxPages} pages`);
    }
    const page = await fetchOne(start);
    out.push(...page);
    if (page.length < PAGE_LIMIT) return out;
  }
}

async function fetchPaged<T>(base: string, basePath: string, signal: AbortSignal): Promise<T[]> {
  // Every path in the loop either returns or throws, so there is no trailing
  // fallback to reach.
  return pageAll<T>(async (start) => {
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      signal.throwIfAborted();
      try {
        return await fetchPage<T>(base, `${basePath}&limit=${PAGE_LIMIT}&startIndex=${start}`, signal);
      } catch (err) {
        // Retry only what can improve. A 4xx is a bad request and will not.
        if (signal.aborted || !isRetryable(err) || attempt === MAX_ATTEMPTS - 1) throw err;
        await sleep(500 * 2 ** attempt);
      }
    }
    throw new Error('unreachable');
  });
}

// Half-open day windows covering [from, to). An inclusive upper bound makes
// adjacent chunks both match a detection sitting exactly on the boundary, so it
// would arrive twice.
export function dayWindows(from: Date, to: Date): Array<{ from: Date; to: Date }> {
  const windows: Array<{ from: Date; to: Date }> = [];
  for (let start = from.getTime(); start < to.getTime(); start += DAY_MS) {
    windows.push({ from: new Date(start), to: new Date(Math.min(start + DAY_MS, to.getTime())) });
  }
  return windows;
}

// The time field each collection filters on. Exported with the builders below so
// the wire contract can be pinned by a test without hitting the network.
const TIME_FIELD: Record<string, string> = {
  'deepfire:hotspots': 'observed_at',
  'deepfire:clusters': 'last_observed',
  'deepfire:satellite-perimeters': 'computed_at',
};

export function windowPath(collection: string, from: Date, to: Date): string {
  const field = TIME_FIELD[collection] ?? 'observed_at';
  const params = new URLSearchParams({
    bbox: BBOX,
    'filter-lang': 'cql2-text',
    // Exclusive upper bound: see dayWindows.
    filter:
      `${field} >= '${from.toISOString()}' AND ${field} < '${to.toISOString()}'` +
      (ACTIVE_ONLY ? ' AND active = true' : ''),
    f: 'application/geo+json',
  });
  return `/${collection}/items?${params.toString()}`;
}

async function fetchWindowed<T>(base: string, collection: string, signal: AbortSignal, now: Date): Promise<T[]> {
  const from = new Date(now.getTime() - WINDOW_HOURS * 60 * 60 * 1000);
  const all: T[] = [];
  // One day per request. A wide range returns 500 on the second page.
  for (const w of dayWindows(from, now)) {
    all.push(...(await fetchPaged<T>(base, windowPath(collection, w.from, w.to), signal)));
  }
  return all;
}

// Live fetches have no event timeline, so atSeconds is ignored.
export class LiveProvider implements FireDataProvider {
  readonly mode = 'live' as const;

  async getFires(_atSeconds?: number): Promise<FiresResponse> {
    if (!API_KEY) {
      throw new Error('DEEPFIRE_API_KEY is not set');
    }
    const base = collectionsBase();
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), 8000);
    const now = new Date();
    try {
      const [hotspots, clusters, perimeters] = await Promise.all([
        fetchWindowed<RawHotspot>(base, 'deepfire:hotspots', controller.signal, now),
        fetchWindowed<RawCluster>(base, 'deepfire:clusters', controller.signal, now),
        fetchWindowed<RawPerimeter>(base, 'deepfire:satellite-perimeters', controller.signal, now),
      ]);
      const payload: RawFiresPayload = { hotspots, clusters, perimeters };
      return {...normalize(payload, 'live', null), dataKind: 'observations'};
    } finally {
      clearTimeout(deadline);
      controller.abort();
    }
  }
}
