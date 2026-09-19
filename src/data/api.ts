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
    timeline: data.timeline,
  };
}

export function fetchInfrastructure(): Promise<InfrastructureResponse> {
  return getJson<InfrastructureResponse>('/api/infrastructure');
}

export async function fetchThreats(fireId: string): Promise<ThreatsResponse> {
  const data = await getJson<Partial<ThreatsResponse>>(
    `/api/threats?fireId=${encodeURIComponent(fireId)}`,
  );
  // Same boundary guard as fetchFires: partial payloads default to empty
  // lists instead of throwing inside the panel render.
  return {
    fireId: typeof data.fireId === 'string' ? data.fireId : fireId,
    hasPerimeter: data.hasPerimeter === true,
    rings: Array.isArray(data.rings) ? data.rings : [],
    threatened: Array.isArray(data.threatened) ? data.threatened : [],
    corridorCount: typeof data.corridorCount === 'number' ? data.corridorCount : 0,
    computedAt: typeof data.computedAt === 'string' ? data.computedAt : new Date().toISOString(),
  };
}
