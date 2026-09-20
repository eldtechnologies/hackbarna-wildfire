// Provider selection. DATA_MODE=replay serves snapshots directly (default for
// development and demo fallback). DATA_MODE=live tries Deepfire first and
// falls back to the replay snapshot on any failure, so a dead API or venue
// wifi never blanks the globe. The response provenance field says which
// source actually served the data.

import { LiveProvider } from './live';
import { ReplayProvider } from './replay';
import type { FireDataProvider, FiresResponse } from '../../shared/fires';

const DATA_MODE = process.env.DATA_MODE ?? 'replay';

const live = new LiveProvider();
const replay = new ReplayProvider();

export function getProvider(): FireDataProvider {
  return DATA_MODE === 'live' ? live : replay;
}

// Reuse a recent response for the same cursor. Computed analyses use their
// actual input evidence as identity, never this response's fetch timestamp.
const FIRES_MEMO_TTL_MS = 5000;
let firesMemo: { value: FiresResponse; expiresAt: number; at: number | undefined } | null = null;

const pendingReads = new Map<number | undefined, Promise<FiresResponse>>();

async function getFiresUncached(atSeconds?: number): Promise<FiresResponse> {
  if (DATA_MODE !== 'live') {
    return replay.getFires(atSeconds);
  }
  try {
    return await live.getFires(atSeconds);
  } catch (err) {
    console.warn('[providers] live fetch failed, falling back to replay:', err);
    return replay.getFires(atSeconds);
  }
}

export async function getFires(atSeconds?: number): Promise<FiresResponse> {
  if (firesMemo && firesMemo.expiresAt > Date.now() && firesMemo.at === atSeconds) {
    return firesMemo.value;
  }
  const pending = pendingReads.get(atSeconds);
  if (pending) return pending;
  const job = getFiresUncached(atSeconds).then(value => {
    firesMemo = { value, expiresAt: Date.now() + FIRES_MEMO_TTL_MS, at: atSeconds };
    return value;
  }).finally(() => pendingReads.delete(atSeconds));
  pendingReads.set(atSeconds,job);
  return job;
}
