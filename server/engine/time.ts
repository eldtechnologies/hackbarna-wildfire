// Time handling for the egress engine.
//
// Two things here are load-bearing and easy to get wrong.
//
// 1. The CAP 1.2 schema restricts <sent>, <onset>, <expires> and <effective> to the
//    pattern \d\d\d\d-\d\d-\d\dT\d\d:\d\d:\d\d[-,+]\d\d:\d\d. Verified with xmllint
//    against the official XSD: a trailing 'Z' is rejected, and so are fractional
//    seconds. `new Date().toISOString()` produces both, so it can never be used for
//    a CAP timestamp. The offset is also not constant — Spain is +02:00 in July and
//    +01:00 in January — so it is computed per instant rather than hardcoded.
//
// 2. Every instant in this engine is an integer number of seconds since the scenario
//    origin, matching the `?at=<seconds>` cursor convention locked in docs/work-plan.md.
//    Floats are avoided deliberately: `min` and subtraction on integers make ties
//    exact, which removes a whole class of nondeterminism from the route tie-break.

/** Sensor delivery latency, seconds from observation to availability. */
export const LATENCY_SECONDS: Record<string, number> = {
  // The spike measured MTG-I1 delivery from the archive's own file-creation
  // timestamps: median ~17 min, p95 20 min (docs/last-safe-departure.md A6).
  MTG_I1: 17 * 60,
  // Polar overpasses are not real-time; the data arrives with the downlink. Not
  // measured in the spike, so this is a stated assumption rather than a reading.
  VIIRS_SNPP_NRT: 3 * 60 * 60,
  VIIRS_NOAA20_NRT: 3 * 60 * 60,
  VIIRS_NOAA21_NRT: 3 * 60 * 60,
  MODIS_NRT: 3 * 60 * 60,
  SENTINEL_3A: 6 * 60 * 60,
  SENTINEL_3B: 6 * 60 * 60,
};

export const DEFAULT_LATENCY_SECONDS = 3 * 60 * 60;

/**
 * Parse an ISO 8601 timestamp to epoch milliseconds.
 *
 * Returns null for anything without an explicit UTC offset or 'Z'. A zone-less
 * string does not mean UTC — JavaScript treats it as local time, so the same
 * fixture would produce different instants on different laptops and shift the
 * headline cut time by exactly the amount the confidence band is about.
 */
export function toEpochMs(iso: string | null | undefined): number | null {
  if (typeof iso !== 'string' || iso.length === 0) return null;
  // Offset required: either a trailing Z, or ±HH:MM / ±HHMM after the time.
  if (!/(Z|[+-]\d{2}:?\d{2})$/.test(iso)) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

export function fromEpochMs(ms: number): string {
  return new Date(ms).toISOString();
}

/** Minutes east of UTC for `timeZone` at instant `ms`. Handles DST per instant. */
function offsetMinutesAt(ms: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(ms));
  const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? '0');
  const asUtc = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour') % 24, // some ICU versions report midnight as hour 24
    get('minute'),
    get('second'),
  );
  return Math.round((asUtc - ms) / 60_000);
}

/**
 * Format an instant as a CAP 1.2 timestamp: `2026-07-09T19:38:21+02:00`.
 *
 * Satisfies the XSD pattern by construction — no 'Z', no fractional seconds,
 * explicit numeric offset. The offset is derived for this instant, so a January
 * date correctly yields +01:00 rather than reusing the summer offset.
 */
export function formatCapTimestamp(ms: number, timeZone = 'Europe/Madrid'): string {
  const offset = offsetMinutesAt(ms, timeZone);
  const shifted = new Date(ms + offset * 60_000);
  const pad = (n: number, width = 2): string => String(n).padStart(width, '0');
  const sign = offset < 0 ? '-' : '+';
  const abs = Math.abs(offset);
  return (
    `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}` +
    `T${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}:${pad(shifted.getUTCSeconds())}` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  );
}

/**
 * Seconds since `origin`, rounded down, for a cursor request.
 * Returns null when the instant precedes the origin, which is different from zero.
 */
export function secondsSince(originMs: number, ms: number): number {
  return Math.floor((ms - originMs) / 1000);
}

/**
 * The scenario origin a `?at=<seconds>` cursor counts from.
 *
 * PR #11 defines `at` as seconds from the first frame of a recording. The July
 * capture is a flat file with no frames, so there is no timeline to read and the
 * origin has to be derived: the earliest detection in the window. Whatever is
 * chosen must be published in the response, or the globe and the mask disagree
 * on screen about what time it is.
 */
export function resolveTimelineOrigin(detectedAtIso: Array<string | null>, windowFrom?: string): number | null {
  const fromWindow = toEpochMs(windowFrom ?? null);
  if (fromWindow !== null) return fromWindow;
  let earliest: number | null = null;
  for (const iso of detectedAtIso) {
    const ms = toEpochMs(iso);
    if (ms === null) continue;
    if (earliest === null || ms < earliest) earliest = ms;
  }
  return earliest;
}
