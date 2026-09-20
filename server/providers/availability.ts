// Retrospective delivery assumptions for the DeepFire capture. Native NetCDF
// inference has a separate creation-time + 45-minute policy recorded in its schema.
export const LATENCY_SECONDS: Record<string, number> = {
  MTG_I1: 17 * 60,
  VIIRS_SNPP_NRT: 3 * 60 * 60,
  VIIRS_NOAA20_NRT: 3 * 60 * 60,
  VIIRS_NOAA21_NRT: 3 * 60 * 60,
  MODIS_NRT: 3 * 60 * 60,
  SENTINEL_3A: 6 * 60 * 60,
  SENTINEL_3B: 6 * 60 * 60,
};
export const DEFAULT_LATENCY_SECONDS = 3 * 60 * 60;
export const CAPTURE_AVAILABILITY_POLICY = 'deepfire-capture-delivery-assumptions-v1';

export function epoch(iso: unknown): number | null {
  if (typeof iso !== 'string' || !/(Z|[+-]\d{2}:?\d{2})$/.test(iso)) return null;
  const n = Date.parse(iso);
  return Number.isFinite(n) ? n : null;
}

export function detectionAvailableAt(p: { observed_at: string; source: string; available_at?: string }): number | null {
  const observed = epoch(p.observed_at);
  if (observed === null) return null;
  if (p.available_at !== undefined) {
    const available = epoch(p.available_at);
    return available === null || available < observed ? null : available;
  }
  const latency = Object.hasOwn(LATENCY_SECONDS, p.source) ? LATENCY_SECONDS[p.source] : DEFAULT_LATENCY_SECONDS;
  return observed + latency * 1000;
}

export class CursorError extends Error {}

export function parseCursor(raw: unknown): number | undefined {
  if (raw === undefined || raw === '') return undefined;
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) throw new CursorError('at must be a non-negative integer number of seconds');
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n > 253_402_300_799) throw new CursorError('at is beyond the supported range');
  return n;
}
