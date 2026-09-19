// Live provider: fetches hotspots, clusters and fire spread from the Deepfire
// API through this server (the API key never reaches the browser). Endpoint
// paths and payload shapes follow the mocked spec in normalize.ts.

import { normalize, type RawCluster, type RawHotspot, type RawSpreadPolygon } from './normalize';
import type { FireDataProvider, FiresResponse } from '../../shared/fires';

const BASE_URL = process.env.DEEPFIRE_BASE_URL ?? 'https://api.deepfire.example.com';
const API_KEY = process.env.DEEPFIRE_API_KEY ?? '';
const FETCH_TIMEOUT_MS = 8000;

async function fetchJson<T>(path: string): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(`${BASE_URL}${path}`, {
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        Accept: 'application/json',
      },
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`Deepfire ${path} returned ${res.status}`);
    }
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

// Live fetches have no event timeline, so atSeconds is ignored.
export class LiveProvider implements FireDataProvider {
  readonly mode = 'live' as const;

  async getFires(_atSeconds?: number): Promise<FiresResponse> {
    if (!API_KEY) {
      throw new Error('DEEPFIRE_API_KEY is not set');
    }
    const [hotspots, clusters, spread] = await Promise.all([
      fetchJson<RawHotspot[]>('/hotspots'),
      fetchJson<RawCluster[]>('/clusters'),
      fetchJson<RawSpreadPolygon[]>('/spread'),
    ]);
    return normalize({ hotspots, clusters, spread }, 'live', null);
  }
}
