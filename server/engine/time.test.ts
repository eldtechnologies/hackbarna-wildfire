import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatCapTimestamp, toEpochMs, resolveTimelineOrigin, secondsSince } from './time';

// The CAP 1.2 XSD restricts these elements to this exact pattern. A trailing 'Z' and
// fractional seconds are both rejected by xmllint against the official schema.
const CAP_XSD_PATTERN = /^\d\d\d\d-\d\d-\d\dT\d\d:\d\d:\d\d[-,+]\d\d:\d\d$/;

test('a CAP timestamp satisfies the XSD pattern, with no Z and no fractional seconds', () => {
  const ms = Date.UTC(2026, 6, 9, 17, 38, 21);
  const out = formatCapTimestamp(ms);
  assert.equal(out, '2026-07-09T19:38:21+02:00');
  assert.match(out, CAP_XSD_PATTERN);
  assert.ok(!out.includes('Z'), 'a Z suffix fails the CAP schema');
  assert.ok(!out.includes('.'), 'fractional seconds fail the CAP schema');
});

test('the UTC offset follows the date, so DST is not hardcoded', () => {
  // Same function, two instants either side of the Spanish DST boundary.
  assert.equal(formatCapTimestamp(Date.UTC(2026, 6, 9, 12, 0, 0)), '2026-07-09T14:00:00+02:00');
  assert.equal(formatCapTimestamp(Date.UTC(2026, 0, 15, 12, 0, 0)), '2026-01-15T13:00:00+01:00');
});

test('formatCapTimestamp is not toISOString — it never emits Z', () => {
  const ms = Date.UTC(2026, 6, 9, 17, 38, 21);
  assert.ok(new Date(ms).toISOString().endsWith('Z'));
  assert.match(new Date(ms).toISOString(), /\.\d{3}Z$/);
  assert.match(formatCapTimestamp(ms), CAP_XSD_PATTERN);
});

test('a timestamp with no UTC offset is rejected rather than assumed', () => {
  // Parsed as local time by Date.parse, so the instant would move with the laptop.
  assert.equal(toEpochMs('2026-07-09T19:38:21'), null);
  assert.equal(toEpochMs('2026-07-09'), null);
  assert.equal(toEpochMs(''), null);
  assert.equal(toEpochMs(null), null);
  assert.equal(toEpochMs(undefined), null);
  assert.equal(toEpochMs('not a date at all'), null);
});

test('offset-bearing timestamps parse, in both notations', () => {
  const expected = Date.UTC(2026, 6, 9, 17, 38, 21);
  assert.equal(toEpochMs('2026-07-09T17:38:21Z'), expected);
  assert.equal(toEpochMs('2026-07-09T19:38:21+02:00'), expected);
  assert.equal(toEpochMs('2026-07-09T19:38:21+0200'), expected);
});

test('a missing origin is null, which is different from zero', () => {
  assert.equal(resolveTimelineOrigin([null, null]), null);
  assert.equal(secondsSince(1000, 1000), 0);
  assert.equal(secondsSince(1000, 4000), 3);
});

test('the scenario origin prefers the declared window over the first detection', () => {
  const detected = ['2026-07-09T01:15:00Z', '2026-07-09T11:48:00Z'];
  assert.equal(
    resolveTimelineOrigin(detected, '2026-07-09T00:00:00+00:00'),
    Date.UTC(2026, 6, 9, 0, 0, 0),
  );
  // No window declared: fall back to the earliest usable detection.
  assert.equal(resolveTimelineOrigin(detected), Date.UTC(2026, 6, 9, 1, 15, 0));
  // Unusable timestamps are skipped rather than poisoning the result into NaN.
  assert.equal(resolveTimelineOrigin([null, '2026-07-09T11:48:00Z']), Date.UTC(2026, 6, 9, 11, 48, 0));
});
