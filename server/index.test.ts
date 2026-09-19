// HTTP-level tests for the server's routes. Run with:
//   node --test --import tsx server/index.test.ts
//
// The growth route had no automated coverage at all, which is how a one-request
// crash shipped: coercing `req.query.clusterId` outside the try exited the process
// on `?clusterId[toString]=x`. Everything below goes over real HTTP against the app,
// so the status codes and the failure path are pinned rather than read.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { createApp } from './index';
import type { Metrics } from './model/metrics';

let server: Server;
let base: string;

before(async () => {
  server = createServer(createApp());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port bound');
  base = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const get = async (path: string): Promise<{ status: number; body: string }> => {
  const res = await fetch(base + path);
  return { status: res.status, body: await res.text() };
};

const firstClusterId = async (): Promise<string> => {
  const fires = await get('/api/fires');
  assert.equal(fires.status, 200, 'a neighbour route must answer');
  const id = (JSON.parse(fires.body) as { clusters: { id: string }[] }).clusters[0]?.id;
  assert.ok(id, 'the replay data must carry at least one cluster');
  return id;
};

test('the growth route answers 200 for a known cluster, 400 without an id, 404 for an unknown one', async () => {
  const clusterId = await firstClusterId();

  const ok = await get(`/api/growth?clusterId=${clusterId}`);
  assert.equal(ok.status, 200);
  const body = JSON.parse(ok.body) as { model: unknown; shipped: string; scores: unknown[] };
  assert.equal(body.model, null);
  assert.equal(body.shipped, 'persistence');
  assert.ok(body.scores.length > 0, 'the held-out scores must travel with the claim');

  assert.equal((await get('/api/growth')).status, 400);
  assert.equal((await get('/api/growth?clusterId=does-not-exist')).status, 404);
  assert.equal((await get('/api/health')).status, 200, 'the process must stay up');
});

test('a forged object-valued clusterId is a 400, not a crash', async () => {
  // Express's extended query parser turns `?clusterId[toString]=x` into an object
  // whose toString is not callable. Coercing it threw outside the try, the async
  // handler rejected, and Express 4 does not catch that rejection, so the process
  // exited and took every route with it. The route guards the type like /api/threats.
  const res = await get('/api/growth?clusterId[toString]=x');
  assert.equal(res.status, 400);
  assert.equal((await get('/api/health')).status, 200, 'the process must survive the request');
});

test('a corrupt harness artifact is a 502, not an empty score list', async () => {
  const clusterId = await firstClusterId();
  const boom = (): Metrics => {
    throw new Error('metrics.json is corrupt');
  };
  const s = createServer(createApp(boom));
  await new Promise<void>((resolve) => s.listen(0, '127.0.0.1', resolve));
  const address = s.address();
  if (address === null || typeof address === 'string') throw new Error('no port bound');
  try {
    const res = await fetch(`http://127.0.0.1:${address.port}/api/growth?clusterId=${clusterId}`);
    assert.equal(res.status, 502, 'a broken artifact is a server error, not "no scores"');
  } finally {
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }
});
