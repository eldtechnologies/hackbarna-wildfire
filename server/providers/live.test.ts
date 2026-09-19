// Tests for the Deepfire client's request contract, run with:
//   node --test --import tsx server/providers/live.test.ts
//
// Nothing here touches the network. The builders are pure, so the wire contract
// they emit can be asserted directly.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  UpstreamError,
  dayWindows,
  isRetryable,
  pageAll,
  parseBaseUrl,
  readWindowHours,
  requestInit,
  requireFeatures,
  windowPath,
} from './live';

const NOW = new Date('2026-07-09T12:00:00Z');
const DAY = 24 * 60 * 60 * 1000;

const filterOf = (path: string): string =>
  new URLSearchParams(path.split('?')[1]).get('filter') ?? '';

test('day windows tile the range without gaps or overlap', () => {
  const from = new Date(NOW.getTime() - 3 * DAY);
  const w = dayWindows(from, NOW);
  assert.equal(w.length, 3);
  assert.equal(w[0].from.getTime(), from.getTime());
  assert.equal(w[w.length - 1].to.getTime(), NOW.getTime());
  for (let i = 0; i < w.length - 1; i += 1) {
    assert.equal(w[i].to.getTime(), w[i + 1].from.getTime(), 'windows must be contiguous');
    assert.ok(w[i].from.getTime() < w[i].to.getTime(), 'a window must not be empty');
  }
});

test('the emitted upper bound is exclusive', () => {
  // This is the CQL2 text sent to the API, so pinning the operator IS the test:
  // an inclusive bound makes adjacent day chunks both return a detection sitting
  // exactly on midnight, and it arrives twice.
  const filter = filterOf(windowPath('deepfire:hotspots', new Date(NOW.getTime() - DAY), NOW));
  assert.ok(filter.includes("observed_at < '"), `upper bound must be exclusive: ${filter}`);
  assert.ok(!filter.includes('observed_at <= '), `upper bound is inclusive: ${filter}`);
});

test('a timestamp on a shared boundary falls in exactly one window', () => {
  const from = new Date(NOW.getTime() - 2 * DAY);
  const windows = dayWindows(from, NOW);
  const boundary = windows[0].to; // shared with windows[1].from
  const matches = windows.filter(
    (w) => boundary.getTime() >= w.from.getTime() && boundary.getTime() < w.to.getTime(),
  );
  assert.equal(matches.length, 1, 'a boundary timestamp must match one window, not two');
});

test('each collection filters on its own time field', () => {
  const f = (c: string) => filterOf(windowPath(c, new Date(NOW.getTime() - DAY), NOW));
  assert.ok(f('deepfire:hotspots').includes('observed_at'));
  assert.ok(f('deepfire:clusters').includes('last_observed'));
  assert.ok(f('deepfire:satellite-perimeters').includes('computed_at'));
});

test('the active predicate is on by default', () => {
  // Without it the globe draws every detection since January 2025. Exclusion is
  // the server's contract; the client never re-filters, because the replay
  // snapshot is all-active.
  const filter = filterOf(windowPath('deepfire:hotspots', new Date(NOW.getTime() - DAY), NOW));
  assert.ok(filter.includes('active = true'), `active predicate missing: ${filter}`);
});

test('a plaintext base URL is refused', () => {
  assert.throws(() => parseBaseUrl('http://api.deepfire.co'), /must use https/);
});

test('a non-allowlisted host is refused', () => {
  assert.throws(() => parseBaseUrl('https://evil.example.com'), /not allowlisted/);
});

test('the default base URL resolves to the documented origin', () => {
  assert.equal(parseBaseUrl(undefined), 'https://api.deepfire.co');
});

test('retryable classification uses the status, not the message', () => {
  assert.equal(isRetryable(new UpstreamError(500, 'boom')), true);
  assert.equal(isRetryable(new UpstreamError(503, 'boom')), true);
  assert.equal(isRetryable(new UpstreamError(429, 'slow down')), true);
  assert.equal(isRetryable(new UpstreamError(400, 'bad request')), false);
  assert.equal(isRetryable(new UpstreamError(404, 'missing')), false);
  // A dropped connection is worth another try even though it carries no status.
  assert.equal(isRetryable(new TypeError('fetch failed')), true);
  const abort = new Error('aborted');
  abort.name = 'AbortError';
  assert.equal(isRetryable(abort), true);
  assert.equal(isRetryable(new Error('something else')), false);
});

test('a non-FeatureCollection body throws instead of reading as an empty page', () => {
  // Regression: `features ?? []` turned an OGC error envelope into a short page,
  // so getFires() resolved with zero of everything while still reporting
  // provenance: 'live', and the replay fallback never fired.
  for (const body of [
    { code: 'InvalidParameterValue' },
    { type: 'ExceptionReport' },
    [],
    null,
    {},
    { features: 'nope' },
  ]) {
    assert.throws(() => requireFeatures(body, '/x'), /not a FeatureCollection/);
  }
});

test('a legitimately empty FeatureCollection is accepted', () => {
  assert.deepEqual(requireFeatures({ features: [] }, '/x'), []);
  assert.deepEqual(requireFeatures({ features: [{ id: 'a' }] }, '/x'), [{ id: 'a' }]);
});

test('a bad window-hours value falls back to 24 rather than emptying a layer', () => {
  // Regression: an unvalidated Number() made the day loop never run, so the
  // hotspot collection was never queried while provenance still said 'live'.
  for (const bad of ['abc', '', '0', '-5', 'NaN', undefined]) {
    assert.equal(readWindowHours(bad), 24, `${JSON.stringify(bad)} must fall back to 24`);
  }
  assert.equal(readWindowHours('72'), 72);
  assert.equal(readWindowHours('0.5'), 0.5);
});

test('paging stops on a short page and concatenates in order', async () => {
  const full = Array.from({ length: 1000 }, (_, i) => i);
  const pages = [full, full, [1, 2, 3]];
  let calls = 0;
  const out = await pageAll(async () => pages[calls++]);
  assert.equal(calls, 3);
  assert.equal(out.length, 2003);
  assert.equal(out[0], 0);
  assert.equal(out[out.length - 1], 3);
});

test('paging stops at the cap when every page is full', async () => {
  // Regression: termination rested only on a short page, so an upstream that
  // always returns full pages would hang /api/fires forever and the replay
  // fallback would never fire, because the promise never settles.
  const full = Array.from({ length: 1000 }, (_, i) => i);
  let calls = 0;
  await assert.rejects(
    () => pageAll(async () => { calls += 1; return full; }, 5),
    /exceeded 5 pages/,
  );
  assert.equal(calls, 5);
});

test('paging accepts a legitimately empty first page', async () => {
  assert.deepEqual(await pageAll(async () => []), []);
});

test('the request refuses redirects and carries the key in a header', () => {
  // A 3xx would let the upstream move the collection query to another origin.
  const init = requestInit(new AbortController().signal);
  assert.equal(init.redirect, 'error');
  assert.match(String((init.headers as Record<string, string>).Authorization), /^Bearer /);
  assert.equal((init.headers as Record<string, string>).Accept, 'application/geo+json');
});

const REPO = join(dirname(fileURLToPath(import.meta.url)), '../..');

test('a bad base URL does not stop the server, in any mode', () => {
  // Regression: parseBaseUrl ran at module load, so a bad DEEPFIRE_BASE_URL threw
  // on import and killed the process before app.listen — including in replay
  // mode, defeating the fallback the provider documents.
  for (const bad of ['http://evil.example.com', 'https://mirror.example.com']) {
    const out = execFileSync(
      process.execPath,
      ['--import', 'tsx', '-e', "import('./server/providers/index.ts').then(()=>console.log('OK'))"],
      { cwd: REPO, env: { ...process.env, DATA_MODE: 'replay', DEEPFIRE_BASE_URL: bad }, encoding: 'utf8' },
    );
    assert.match(out, /OK/, `${bad} must not break the import`);
  }
});
