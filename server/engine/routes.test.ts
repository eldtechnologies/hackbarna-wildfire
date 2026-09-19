import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import express from 'express';
import { engineRouter } from './routes';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadContext } from './egress';

/** A ledger path in a temporary directory, so the suite never appends to the real one. */
const testLedgerPath = (): string =>
  join(mkdtempSync(join(tmpdir(), 'routes-ledger-')), 'recommendations.jsonl');

/**
 * The store the main router was given, held so a test can go and read that exact file.
 *
 * The endpoint reports the store's NAME and not its path — it is reachable without credentials,
 * and the configured path is the absolute one a real deployment uses. So the test cannot tell
 * the configured store from the default one by reading the response, and checks the file instead,
 * which is the stronger assertion anyway.
 */
const routerLedgerPath = testLedgerPath();

// The router had no automated coverage at all: its status codes, its cursor parsing and
// the CAP refusal path were exercised only by hand. Both of the defects found in it —
// a client error reported as a server error on two of three routes, and a malformed
// cursor silently served as the end of the window — lived somewhere the suite could not
// see. Everything below goes over real HTTP against the real router.

let server: Server;
let base: string;

before(async () => {
  // The engine's context build is a one-time cost paid on first use; paying it here
  // means the first assertion is not competing with a twelve-second parse.
  loadContext();
  const app = express();
  app.use(engineRouter({ ledgerPath: routerLedgerPath }));
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port bound');
  base = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const get = async (path: string): Promise<{ status: number; type: string; body: string }> => {
  const res = await fetch(base + path);
  return { status: res.status, type: res.headers.get('content-type') ?? '', body: await res.text() };
};

/** 19:00 CEST on 9 July — inside the window, where an evacuation is still live. */
const AT = 61200;

test('the health of the engine routes: every endpoint answers', async () => {
  const egress = await get(`/api/egress?at=${AT}`);
  assert.equal(egress.status, 200);
  assert.match(egress.type, /application\/json/);
  const body = JSON.parse(egress.body) as { at: string; segments: unknown[]; totalSegments: number };
  assert.equal(body.at, '2026-07-09T17:00:00.000Z');
  assert.ok(body.segments.length > 0, 'the field must carry the segments the fire reaches');
  assert.ok(body.totalSegments > body.segments.length, 'and report how many it left out');

  assert.equal((await get('/api/egress/field')).status, 200);
  assert.equal((await get(`/api/alerts?at=${AT}`)).status, 200);

  const cap = await get(`/api/cap/bedar?at=${AT}`);
  assert.equal(cap.status, 200);
  assert.match(cap.type, /application\/xml/, 'a CAP consumer needs XML, not Express\'s text/html default');
  assert.match(cap.body, /^<\?xml version="1\.0" encoding="UTF-8"\?>/);
});

test('an unknown pocket is a 404 that names what is available', async () => {
  const res = await get(`/api/cap/nonexistent?at=${AT}`);
  assert.equal(res.status, 404);
  const body = JSON.parse(res.body) as { available: string[] };
  assert.deepEqual(body.available, ['bedar']);
});

test('a malformed cursor is a client error on every route, not a server error', async () => {
  // It mapped to 400 on /api/egress only, because that route had its own branch; the
  // other two reported a bad request as a 502 with a stack trace.
  for (const route of ['/api/egress', '/api/alerts', '/api/cap/bedar']) {
    const negative = await get(`${route}?at=-5`);
    assert.equal(negative.status, 400, `${route} must call a negative cursor a client error`);

    const word = await get(`${route}?at=abc`);
    assert.equal(word.status, 400, `${route} must reject a non-numeric cursor`);

    const arrayed = await get(`${route}?at[]=1&at[]=2`);
    assert.equal(arrayed.status, 400, `${route} must reject a repeated cursor`);
  }
});

test('a cursor is read as a decimal integer, never as whatever Number() would accept', async () => {
  // Number() reads '0x10' as 16 and '1e5' as 100000, so a cursor would silently mean
  // something the client did not write.
  for (const raw of ['0x10', '1e5', ' 42 ', '1.5', '+7', 'Infinity', 'NaN']) {
    const res = await get(`/api/egress?at=${encodeURIComponent(raw)}`);
    assert.equal(res.status, 400, `at=${JSON.stringify(raw)} must be rejected`);
  }
});

test('a cursor beyond the CAP date range is refused rather than producing an invalid document', async () => {
  // Past year 9999 the CAP date pattern fails on the year's width. The schema catches
  // it; the semantic validator did not, so the route that exists to refuse a document
  // that failed its own checks served one — measured: <sent>11533-02-21T06:20:00+01:00
  // with seven xmllint pattern errors and validation.ok === true.
  const huge = await get('/api/cap/bedar?at=300000000000');
  assert.equal(huge.status, 400);
  assert.equal((await get('/api/egress?at=300000000000')).status, 400);
  assert.equal((await get('/api/alerts?at=300000000000')).status, 400);
});

test('an absent cursor is the documented default, and an empty one is the same thing', async () => {
  const absent = await get('/api/egress');
  const empty = await get('/api/egress?at=');
  assert.equal(absent.status, 200);
  assert.equal(empty.status, 200);
  const a = JSON.parse(absent.body) as { at: string };
  const e = JSON.parse(empty.body) as { at: string };
  assert.equal(a.at, e.at, 'omitted and empty both mean "no cursor given"');
});

test('the served CAP document is schema-valid for every cursor inside the window', async () => {
  // The route refuses to serve a document that fails its own semantic checks; this
  // asserts the checks agree with the schema on the cursors the demo actually uses.
  for (const at of [0, 3600, AT, 63417, 70560, 90000]) {
    const res = await get(`/api/cap/bedar?at=${at}`);
    assert.ok(res.status === 200 || res.status === 404, `at=${at} gave ${res.status}`);
    if (res.status !== 200) continue;
    const sent = /<sent>([^<]+)<\/sent>/.exec(res.body)?.[1] ?? '';
    assert.match(sent, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d[-,+]\d\d:\d\d$/, `at=${at} produced <sent>${sent}</sent>`);
  }
});

test('a repeated cursor is served from memory, a new one is solved', async () => {
  // Every request runs the twelve-configuration sweep on the event loop, so a scrubber
  // revisiting a cursor must not pay for it twice. Observable without timing: a memoised
  // response is the same object, so `fetchedAt` is identical, and a rebuilt one carries
  // a new wall-clock stamp.
  const first = JSON.parse((await get(`/api/egress?at=${AT}`)).body) as { fetchedAt: string };
  const second = JSON.parse((await get(`/api/egress?at=${AT}`)).body) as { fetchedAt: string };
  assert.equal(second.fetchedAt, first.fetchedAt, 'the same cursor must be memoised');

  const other = JSON.parse((await get(`/api/egress?at=${AT + 1}`)).body) as { fetchedAt: string };
  assert.notEqual(other.fetchedAt, first.fetchedAt, 'a different cursor is a different solve');
  assert.notEqual((JSON.parse((await get(`/api/egress?at=${AT + 1}`)).body) as { at: string }).at,
    (JSON.parse((await get(`/api/egress?at=${AT}`)).body) as { at: string }).at);
});

test('the cache cannot be turned into a memory amplifier by walking the cursor', async () => {
  // Bounded with oldest-first eviction, so a client walking the integer space re-solves
  // rather than growing the process. Driven through a router with a tiny limit rather
  // than 300 cursors at a full solve each.
  const app = express();
  app.use(engineRouter({ cacheLimit: 4, ledgerPath: testLedgerPath() }));
  const small = createServer(app);
  await new Promise<void>((resolve) => small.listen(0, '127.0.0.1', resolve));
  const address = small.address();
  if (address === null || typeof address === 'string') throw new Error('no port bound');
  const smallBase = `http://127.0.0.1:${address.port}`;
  const fetchAt = async (at: number): Promise<string> => {
    const res = await fetch(`${smallBase}/api/egress?at=${at}`);
    return (JSON.parse(await res.text()) as { fetchedAt: string }).fetchedAt;
  };
  try {
    const first = await fetchAt(1000);
    assert.equal(await fetchAt(1000), first, 'within the limit the response is reused');
    for (let i = 1; i <= 5; i++) await fetchAt(1000 + i * 60);
    assert.notEqual(await fetchAt(1000), first, 'past the limit the oldest entry is gone');
  } finally {
    await new Promise<void>((resolve) => small.close(() => resolve()));
  }
});

test('the engine routes are reachable without the fire routes being disturbed', async () => {
  // The router is mounted before /api/fires in server/index.ts; this asserts the
  // boundary holds, so an engine route cannot shadow or break the console's own route.
  const health = await get('/api/health');
  assert.equal(health.status, 404, 'the engine router does not own /api/health, and does not answer for it');
});

test('the ledger endpoint serves the store the router was given, in recording order', async () => {
  // The wiring this pins was found by running the server, not by reading: the router built
  // its responses with the default ledger path, so a test that exercised it appended to the
  // deployment's real ledger — and those entries then answered later requests in place of a
  // computation, the suite silently changing the behaviour of the thing it was testing.
  const first = await get('/api/alerts?at=64800');
  assert.equal(first.status, 200);

  const history = await get('/api/ledger');
  assert.equal(history.status, 200);
  const body = JSON.parse(history.body) as {
    store: string;
    count: number;
    unreadable: number;
    entries: Array<{ at: string; pocketId: string; recordedAt: string; evidence: string[] }>;
  };

  assert.equal(body.store, 'recommendations.jsonl', 'the store is named, not its directory');
  assert.ok(body.count > 0, 'a served recommendation was recorded');
  // The endpoint read the file the router was configured with: this is that file, and the
  // response is a rendering of it rather than of some other store it happened to reach.
  const lines = readFileSync(routerLedgerPath, 'utf8').split('\n').filter((line) => line.trim() !== '');
  assert.equal(lines.length, body.count, 'the response carries exactly the lines of the configured store');
  assert.equal(body.unreadable, 0);
  for (const entry of body.entries) {
    assert.ok(entry.at.length > 0, 'the cursor it applies to');
    assert.ok(entry.recordedAt.length > 0, 'the wall-clock time it was recorded');
    assert.ok(entry.pocketId.length > 0, 'the pocket it is about');
    assert.ok(Array.isArray(entry.evidence) && entry.evidence.length > 0, 'the evidence behind it');
  }
});

test('the history carries no cursor parameter, and a bad one does not matter', async () => {
  // The point of the record is reading the incident without already knowing which moments
  // to ask for, so the endpoint takes no cursor. A query string it does not read must not
  // turn a working read into a 400.
  const plain = await get('/api/ledger');
  const withJunk = await get('/api/ledger?at=-5&cursorId[]=x');
  assert.equal(plain.status, 200);
  assert.equal(withJunk.status, 200);
  assert.deepEqual(JSON.parse(withJunk.body), JSON.parse(plain.body));
});
