// Typed client for the ojo-de-fuego API. The response schemas are shared with
// the server, see shared/fires.ts and shared/threats.ts.

import type { FireSource, FiresResponse } from '../../shared/fires';
import type { InfrastructureResponse, ThreatsResponse } from '../../shared/threats';
import type { SituationResponse } from '../../shared/situation';

async function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(url,{signal});
  if (!res.ok) {
    throw new Error(`${url} returned ${res.status}`);
  }
  return (await res.json()) as T;
}

export async function fetchFires(atSeconds?: number, signal?: AbortSignal, source?: FireSource): Promise<FiresResponse> {
  const data = await getJson<Partial<FiresResponse>>(`/api/fires${query({at:atSeconds, source})}`, signal);
  // Missing collections are unavailable evidence, not an empty observation window.
  if (!data || (data.provenance !== 'live' && data.provenance !== 'replay') ||
      typeof data.fetchedAt !== 'string' || !Number.isFinite(Date.parse(data.fetchedAt)) ||
      ![data.hotspots, data.clusters, data.perimeters, data.spread].every(Array.isArray)) {
    throw new Error('Fire observations are unavailable: invalid response');
  }
  return data as FiresResponse;
}

export function fetchInfrastructure(): Promise<InfrastructureResponse> {
  return getJson<InfrastructureResponse>('/api/infrastructure');
}

export async function fetchThreats(fireId: string, atSeconds?: number, signal?: AbortSignal, source?: FireSource): Promise<ThreatsResponse> {
  const data = await getJson<Partial<ThreatsResponse>>(
    `/api/threats${query({fireId, at:atSeconds, source})}`, signal,
  );
  // Same boundary guard as fetchFires: partial payloads default to empty
  // lists instead of throwing inside the panel render.
  return {
    fireId: typeof data.fireId === 'string' ? data.fireId : fireId,
    hasPerimeter: data.hasPerimeter === true,
    infrastructureStatus:data.infrastructureStatus??{state:'unavailable',loadedFiles:[],failedFiles:[],rejectedFeatures:0},
    infrastructureCoverage:data.infrastructureCoverage??null,
    rings: Array.isArray(data.rings) ? data.rings : [],
    threatened: Array.isArray(data.threatened) ? data.threatened : [],
    corridorCount: typeof data.corridorCount === 'number' ? data.corridorCount : 0,
    computedAt: typeof data.computedAt === 'string' ? data.computedAt : new Date().toISOString(),
  };
}

export function fetchSituation(fireId: string, atSeconds?: number, signal?: AbortSignal, source?: FireSource): Promise<SituationResponse> {
  return getJson<SituationResponse>(`/api/situation${query({fireId, at:atSeconds, source})}`,signal);
}

function query(values: Record<string, string | number | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) params.set(key, String(value));
  }
  return params.size ? `?${params}` : '';
}
