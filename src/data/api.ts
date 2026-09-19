// Typed client for the ojo-de-fuego API. The response schemas are shared with
// the server, see shared/fires.ts and shared/threats.ts.

import type { FiresResponse } from '../../shared/fires';
import type { InfrastructureResponse, ThreatsResponse } from '../../shared/threats';

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`${url} returned ${res.status}`);
  }
  return (await res.json()) as T;
}

export async function fetchFires(): Promise<FiresResponse> {
  const data = await getJson<Partial<FiresResponse>>('/api/fires');
  // Boundary guard: a partial payload defaults to empty lists instead of
  // throwing inside the layer.
  return {
    provenance: data.provenance === 'live' ? 'live' : 'replay',
    fetchedAt: typeof data.fetchedAt === 'string' ? data.fetchedAt : new Date().toISOString(),
    scenario: typeof data.scenario === 'string' ? data.scenario : null,
    hotspots: Array.isArray(data.hotspots) ? data.hotspots : [],
    clusters: Array.isArray(data.clusters) ? data.clusters : [],
    perimeters: Array.isArray(data.perimeters) ? data.perimeters : [],
    spread: Array.isArray(data.spread) ? data.spread : [],
  };
}

export function fetchInfrastructure(): Promise<InfrastructureResponse> {
  return getJson<InfrastructureResponse>('/api/infrastructure');
}

export function fetchThreats(fireId: string): Promise<ThreatsResponse> {
  return getJson<ThreatsResponse>(`/api/threats?fireId=${encodeURIComponent(fireId)}`);
}
