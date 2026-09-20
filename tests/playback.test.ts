import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { FiresResponse } from '../shared/fires';
import { FirePlayback, replayPosition, replayTimeline } from '../src/data/playback';
import { fetchFires, fetchThreats } from '../src/data/api';

const start = Date.parse('2026-07-09T00:00:00Z');
export function frame(at = 7200): FiresResponse {
  return { provenance: 'replay', scenario: 'test', fetchedAt: new Date().toISOString(),
    asOf: new Date(start + at * 1000).toISOString(),
    timeline: { scenario: 'test', start: new Date(start).toISOString(), end: new Date(start + 7200000).toISOString(), durationSeconds: 7200, frames: [] },
    hotspots: [], clusters: [], perimeters: [], spread: [] };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
const flush = async () => { await Promise.resolve(); await Promise.resolve(); };

test('client sends zero cursor, passes cancellation, and retains evidence metadata', async t => {
  const response = { ...frame(0), availability: { policy: 'measured', deliveryTimes: 'assumed_unless_recorded', clusterAssociation: 'retrospective', perimeterAvailability: 'computed_at_lower_bound' } };
  const calls: [unknown, unknown][] = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    calls.push([url, init]);
    return new Response(JSON.stringify(response));
  });
  const abort = new AbortController();
  const result = await fetchFires(0, abort.signal);
  assert.equal(calls[0][0], '/api/fires?at=0');
  assert.equal((calls[0][1] as RequestInit).signal, abort.signal);
  assert.equal(result.asOf, response.asOf);
  assert.deepEqual(result.availability, response.availability);
  await fetchThreats('fire/a', 0, abort.signal);
  assert.equal(calls[1][0], '/api/threats?fireId=fire%2Fa&at=0');
});

test('play rewinds from the end, advances recorded time, and stops exactly at the end', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const requested: (number | undefined)[] = [];
  const playback = new FirePlayback(async at => { requested.push(at); return frame(at); });
  t.after(() => playback.dispose());
  await playback.start();
  await playback.play();
  assert.equal(replayPosition(playback.getState().data), 0);
  for (let i = 1; i <= 4; i++) {
    t.mock.timers.tick(500); await flush();
    assert.equal(replayPosition(playback.getState().data), i * 1800);
  }
  assert.equal(playback.getState().playing, false);
  t.mock.timers.tick(60000); await flush();
  assert.deepEqual(requested, [undefined, 0, 1800, 3600, 5400, 7200]);
});

test('pause aborts an in-flight playback step and does not let it advance the map', async t => {
  const pending = deferred<FiresResponse>();
  let signal: AbortSignal | undefined;
  const playback = new FirePlayback(async (at, s) => {
    if (at === undefined) return frame();
    signal = s; return pending.promise;
  });
  t.after(() => playback.dispose());
  await playback.start();
  const playing = playback.play();
  playback.pause();
  assert.equal(signal?.aborted, true);
  pending.resolve(frame(0)); await playing;
  assert.equal(replayPosition(playback.getState().data), 7200);
  assert.equal(playback.getState().playing, false);
});

test('a newer seek wins even if the older server response ignores abort', async t => {
  const old = deferred<FiresResponse>(), fresh = deferred<FiresResponse>();
  const playback = new FirePlayback(async at => at === undefined ? frame() : at === 100 ? old.promise : fresh.promise);
  t.after(() => playback.dispose());
  await playback.start();
  const one = playback.seek(100), two = playback.seek(200);
  fresh.resolve(frame(200)); await two;
  old.resolve(frame(100)); await one;
  assert.equal(replayPosition(playback.getState().data), 200);
  assert.equal(playback.getState().loading, false);
});

test('failed seeks keep the committed time, expose an error, and allow retry', async t => {
  let fail = false;
  const requested: (number | undefined)[] = [];
  const playback = new FirePlayback(async at => {
    requested.push(at);
    if (fail) throw new Error('offline');
    return frame(at);
  });
  t.after(() => playback.dispose());
  await playback.start();
  fail = true; await playback.seek(1800);
  assert.equal(replayPosition(playback.getState().data), 7200);
  assert.equal(playback.getState().error, 'offline');
  assert.equal(playback.getState().playing, false);
  fail = false; await playback.retry();
  assert.equal(playback.getState().error, null);
  assert.equal(replayPosition(playback.getState().data),1800);
  assert.deepEqual(requested,[undefined,1800,1800]);
});

test('seeks clamp and round to legal seconds and never leave a replay refresh timer', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const requested: (number | undefined)[] = [];
  const playback = new FirePlayback(async at => { requested.push(at); return frame(at); });
  t.after(() => playback.dispose());
  await playback.start();
  await playback.seek(-2); await playback.seek(1.8); await playback.seek(9000); await playback.seek(NaN);
  t.mock.timers.tick(600000); await flush();
  assert.deepEqual(requested, [undefined, 0, 2, 7200]);
});

test('live and missing/zero-duration timelines cannot start replay', async t => {
  for (const data of [ { ...frame(), provenance: 'live' as const }, { ...frame(), timeline: undefined },
    { ...frame(), asOf: undefined }, { ...frame(), timeline: { ...frame().timeline!, durationSeconds: 0 } } ]) {
    let calls = 0;
    const playback = new FirePlayback(async () => { ++calls; return data; });
    await playback.start(); await playback.play(); await playback.seek(0);
    assert.equal(replayTimeline(data), null);
    assert.equal(playback.getState().playing, false);
    assert.equal(calls, 1);
    playback.dispose();
  }
});

test('playback applies backpressure and disposal prevents pending data from rendering', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pending = deferred<FiresResponse>();
  let calls = 0;
  const playback = new FirePlayback(async at => { ++calls; return at === undefined ? frame() : pending.promise; });
  await playback.start();
  const playing = playback.play();
  t.mock.timers.tick(5000); await flush();
  assert.equal(calls, 2);
  playback.dispose(); pending.resolve(frame(0)); await playing;
  assert.equal(replayPosition(playback.getState().data), 7200);
  assert.equal(playback.getState().playing, false);
});

test('a server that ignores the seek cannot relabel the latest frame as history', async t => {
  const playback = new FirePlayback(async () => frame());
  t.after(() => playback.dispose());
  await playback.start(); await playback.seek(0);
  assert.equal(replayPosition(playback.getState().data),7200);
  assert.match(playback.getState().error!,/different observation time/);
});

test('client rejects success-shaped failures but accepts genuinely empty observations', async t => {
  let payload: unknown;
  t.mock.method(globalThis,'fetch',async()=>Response.json(payload));
  for(payload of [null,{}, {error:'upstream timed out'}, {provenance:'replay'},
    {...frame(),hotspots:undefined}, {...frame(),provenance:'unknown'}, {...frame(),fetchedAt:'bad'}]) {
    await assert.rejects(fetchFires(),/invalid response/);
  }
  payload=frame();
  assert.deepEqual((await fetchFires()).hotspots,[]);
});

test('live responses cannot fulfill a replay seek, and retry preserves its cursor', async t => {
  let live=false;
  const requests:(number|undefined)[]=[];
  const playback=new FirePlayback(async at=>{requests.push(at);return {...frame(at),provenance:live?'live':'replay'};});
  t.after(()=>playback.dispose());
  await playback.start();
  const committed=playback.getState().data;
  live=true;await playback.seek(1800);
  assert.equal(playback.getState().data,committed);
  assert.match(playback.getState().error!,/different observation time/);
  live=false;await playback.retry();
  assert.equal(playback.getState().error,null);
  assert.equal(replayPosition(playback.getState().data),1800);
  assert.deepEqual(requests,[undefined,1800,1800]);
});

test('fractional recording bounds round up and inconsistent timeline duration disables replay', () => {
  const data=frame();
  data.timeline={...data.timeline!,start:'2026-07-09T00:00:00.893Z',end:'2026-07-09T02:00:00.100Z'};
  data.asOf=data.timeline.end;
  assert.ok(replayTimeline(data));
  assert.equal(replayPosition(data),7200);
  data.asOf='2026-07-09T00:00:01.100Z';
  assert.equal(replayPosition(data),1);
  data.timeline.durationSeconds=7199;
  assert.equal(replayTimeline(data),null);
});


test('latest requests keep polling through live-to-replay fallback and recover live data', async t => {
  t.mock.timers.enable({apis:['setTimeout']});
  let calls=0;
  const playback=new FirePlayback(async()=>({...frame(),provenance:++calls===2?'replay':'live'}));
  t.after(()=>playback.dispose());
  await playback.start();
  t.mock.timers.tick(600000);await flush();
  assert.equal(calls,2);assert.equal(playback.getState().data?.provenance,'replay');
  t.mock.timers.tick(600000);await flush();
  assert.equal(calls,3);assert.equal(playback.getState().data?.provenance,'live');
  playback.pause();t.mock.timers.tick(600000);await flush();assert.equal(calls,3);
});


test('latest polling retries initial and later transport failures, while pause cancels recovery', async t => {
  t.mock.timers.enable({apis:['setTimeout']});
  let calls=0;const failing=new Set([1,3,5]);
  const playback=new FirePlayback(async()=>{if(failing.has(++calls))throw new Error('offline');return {...frame(),provenance:'live'};});
  t.after(()=>playback.dispose());
  await playback.start();assert.equal(playback.getState().data,null);assert.equal(calls,1);
  t.mock.timers.tick(14999);await flush();assert.equal(calls,1);
  t.mock.timers.tick(1);await flush();assert.equal(calls,2);assert.equal(playback.getState().error,null);
  const committed=playback.getState().data;
  t.mock.timers.tick(600000);await flush();assert.equal(calls,3);
  assert.equal(playback.getState().error,'offline');assert.equal(playback.getState().data,committed);
  t.mock.timers.tick(15000);await flush();assert.equal(calls,4);assert.equal(playback.getState().error,null);
  t.mock.timers.tick(600000);await flush();assert.equal(calls,5);
  playback.pause();t.mock.timers.tick(3600000);await flush();assert.equal(calls,5);
});

test('source switches cancel older work and replay seeks pin a live fallback recording', async t => {
  const old = deferred<FiresResponse>();
  const sources: (string | undefined)[] = [];
  const playback = new FirePlayback(async (at, _signal, source) => {
    sources.push(source);
    if (source === 'configured') return old.promise;
    return {...frame(at), source: 'replay', requestedSource: source, fallbackReason: source === 'live' ? 'live_unavailable' : undefined};
  });
  t.after(() => playback.dispose());
  const slow = playback.selectSource('configured');
  await playback.selectSource('live');
  old.resolve({...frame(), source:'configured'}); await slow;
  assert.equal(playback.getState().data?.source, 'replay');
  assert.equal(playback.getState().source, 'live');
  await playback.seek(1800);
  assert.equal(sources.at(-1), 'replay');
  assert.equal(playback.getState().source, 'replay');
  assert.equal(replayPosition(playback.getState().data), 1800);
});
