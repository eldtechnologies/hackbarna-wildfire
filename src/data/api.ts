// Typed client for the ojo-de-fuego API. The response schema is shared with
// the server, see shared/fires.ts.

import type { FiresResponse } from '../../shared/fires';

export async function fetchFires(): Promise<FiresResponse> {
  const res = await fetch('/api/fires');
  if (!res.ok) {
    throw new Error(`/api/fires returned ${res.status}`);
  }
  const data = (await res.json()) as Partial<FiresResponse>;
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
