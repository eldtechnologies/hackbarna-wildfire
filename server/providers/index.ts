// Source selection is per request; changing one browser never changes another.
import { LiveProvider } from './live';
import { ReplayProvider } from './replay';
import { CursorError } from './availability';
import { BoundedCache } from '../bounded-cache';
import type { FireDataProvider, FireSource, FiresResponse } from '../../shared/fires';

const DEFAULT_SOURCE: FireSource = process.env.DATA_MODE === 'live' ? 'live'
  : process.env.REPLAY_SNAPSHOT !== undefined ? 'configured' : 'replay';
const providers: Record<FireSource, FireDataProvider> = {
  live: new LiveProvider(),
  configured: new ReplayProvider(),
  replay: new ReplayProvider('los-gallardos-2026-07-09.json'),
};
// Live outages always fall back to a pinned real observation capture, even if
// REPLAY_SNAPSHOT configures a different recording for the normal replay source.
const fallback = new ReplayProvider('los-gallardos-2026-07-09.json');

export function parseSource(raw: unknown): FireSource | undefined {
  if (raw === undefined) return undefined;
  if (raw === 'live' || raw === 'replay' || raw === 'configured') return raw;
  throw new CursorError('source must be live, replay or configured');
}

export function getProvider(source: FireSource = DEFAULT_SOURCE): FireDataProvider {
  return providers[source];
}

const recent = new BoundedCache<FiresResponse>(32, 5000);
const pendingReads = new Map<string, Promise<FiresResponse>>();

async function readSource(at: number | undefined, source: FireSource): Promise<FiresResponse> {
  try {
    const data = await getProvider(source).getFires(at);
    return {...data, source, requestedSource: source};
  } catch (error) {
    if (source !== 'live') throw error;
    console.warn('[providers] live unavailable; serving recorded observations');
    return {...await fallback.getFires(at), source: 'replay', requestedSource: source,
      fallbackReason: 'live_unavailable'};
  }
}

export async function getFires(atSeconds?: number, source: FireSource = DEFAULT_SOURCE): Promise<FiresResponse> {
  const key = JSON.stringify([source, atSeconds]);
  const cached = recent.get(key);
  if (cached) return cached;
  const pending = pendingReads.get(key);
  if (pending) return pending;
  const job = readSource(atSeconds, source).then(value => {
    recent.set(key, value);
    return value;
  }).finally(() => pendingReads.delete(key));
  pendingReads.set(key, job);
  return job;
}
