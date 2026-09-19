// Typed client for the ojo-de-fuego API. The response schemas are shared with
// the server, see shared/fires.ts and shared/threats.ts.

import type { FiresResponse } from '../../shared/fires';
import type { InfrastructureResponse, ThreatsResponse } from '../../shared/threats';
import type { SituationResponse } from '../../shared/situation';

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`${url} returned ${res.status}`);
  }
  return (await res.json()) as T;
}

export function fetchFires(): Promise<FiresResponse> {
  return getJson<FiresResponse>('/api/fires');
}

export function fetchInfrastructure(): Promise<InfrastructureResponse> {
  return getJson<InfrastructureResponse>('/api/infrastructure');
}

export function fetchThreats(fireId: string): Promise<ThreatsResponse> {
  return getJson<ThreatsResponse>(`/api/threats?fireId=${encodeURIComponent(fireId)}`);
}

export function fetchSituation(fireId: string): Promise<SituationResponse> {
  return getJson<SituationResponse>(`/api/situation?fireId=${encodeURIComponent(fireId)}`);
}
