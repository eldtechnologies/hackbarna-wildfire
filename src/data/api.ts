// Typed client for the ojo-de-fuego API. The response schema is shared with
// the server, see shared/fires.ts.

import type { FiresResponse } from '../../shared/fires';

export async function fetchFires(): Promise<FiresResponse> {
  const res = await fetch('/api/fires');
  if (!res.ok) {
    throw new Error(`/api/fires returned ${res.status}`);
  }
  return (await res.json()) as FiresResponse;
}
