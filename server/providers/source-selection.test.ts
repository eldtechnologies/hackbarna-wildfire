import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { getFires, getProvider, parseSource } from './index';
import { ReplayProvider } from './replay';
import { getSituation } from '../situation';
import { createApp } from '../index';
import { buildFireCases } from '../../src/fires/spreadModel';
import { ringCentroid } from '../../src/fires/geometry';

const drill = new ReplayProvider('castelltallat-drill-2026-09-19T13-55-15-930Z.json');

test('every exercise frame retains causal observations, a perimeter and +8h projections with explicit provenance', async () => {
  const latest = await drill.getFires();
  assert.equal(latest.dataKind, 'exercise');
  assert.equal(latest.timeline!.frames.length, 8);
  assert.ok(latest.timeline!.durationSeconds > 3 * 3600);
  for (const time of latest.timeline!.frames) {
    const cursor = Math.ceil((Date.parse(time) - Date.parse(latest.timeline!.start)) / 1000);
    const fires = await drill.getFires(cursor);
    assert.ok(fires.hotspots.length >= 10);
    assert.equal(fires.perimeters.length, 1);
    assert.equal(fires.spread.length, 4);
    assert.ok(fires.hotspots.every(h => Date.parse(h.detectedAt!) <= Date.parse(fires.asOf!)));
    assert.ok(fires.perimeters.every(p => Date.parse(p.observedAt!) <= Date.parse(fires.asOf!)));
    assert.equal(buildFireCases(fires)[0].maxHorizonHours, 8);
    assert.match(fires.availability!.policy, /synthetic/);
  }
});

test('source and cursor isolate memoized evidence; source cannot name arbitrary files', async () => {
  const [exercise, observations] = await Promise.all([getFires(0, 'drill'), getFires(0, 'replay')]);
  assert.equal(exercise.source, 'drill');
  assert.equal(observations.source, 'replay');
  assert.notEqual(exercise.scenario, observations.scenario);
  assert.equal(await getFires(0, 'drill'), exercise);
  assert.equal(await getFires(0, 'replay'), observations);
  for (const value of ['../../.env', 'unknown', ['live'], {}, null]) assert.throws(() => parseSource(value));
});

test('failed live feed falls back to real observations, independent of the configured exercise', async t => {
  t.mock.method(getProvider('live'), 'getFires', async () => { throw new Error('offline'); });
  const fires = await getFires(3344, 'live');
  assert.equal(fires.requestedSource, 'live');
  assert.equal(fires.source, 'replay');
  assert.equal(fires.dataKind, 'observations');
  assert.equal(fires.scenario, 'los-gallardos-2026-07-09');
  assert.equal(fires.fallbackReason, 'live_unavailable');
});

test('map drift and deterministic report agree; a closed ring does not double-weight its first vertex', async () => {
  const open = [{lat:0,lon:0},{lat:2,lon:0},{lat:2,lon:2},{lat:0,lon:2}];
  assert.deepEqual(ringCentroid([...open, open[0]]), ringCentroid(open));
  const fires = await getFires(0, 'drill');
  const packet = (await getSituation('cl-01', 0, 'drill'))!;
  assert.match(packet.summary, /SIMULATED EXERCISE/);
  assert.equal(packet.narrator, 'template');
  assert.equal(packet.packet.dataKind, 'exercise');
  assert.ok(Math.abs(buildFireCases(fires)[0].driftBearingDeg! - packet.packet.spreadBearingDeg!) < .1);
});

test('all dependent HTTP routes use the requested source and reject malformed source parameters', async t => {
  const server = createServer(createApp());
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const base = `http://127.0.0.1:${(server.address() as {port:number}).port}`;
  for (const [endpoint, params] of [['fires',''], ['threats','&fireId=cl-01'], ['situation','&fireId=cl-01'], ['growth','&clusterId=cl-01']]) {
    const response = await fetch(`${base}/api/${endpoint}?source=drill&at=0${params}`);
    assert.equal(response.status, 200, endpoint);
    const bad = await fetch(`${base}/api/${endpoint}?source=../../.env${params}`);
    assert.equal(bad.status, 400, endpoint);
  }
});

test('recording helper preserves capture time and reconstructs the committed exercise clock', async () => {
  const {spawnSync} = await import('node:child_process');
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import {readFileSync} from 'node:fs';
    import {exerciseFrame} from './scripts/lib/exercise-recording.mjs';
    const data=JSON.parse(readFileSync('data/snapshots/castelltallat-drill-2026-09-19T13-55-15-930Z.json','utf8'));
    for(const frame of data.frames) {
      const {capturedAt,t,...payload}=frame;
      assert.deepEqual(exerciseFrame(payload,capturedAt),frame);
    }
    assert.throws(()=>exerciseFrame({hotspots:[],clusters:[],spread:[]}));
  `], {encoding:'utf8', timeout:5000});
  assert.equal(result.status, 0, result.stderr);
});

test('the default one-frame exercise recorder preserves forecasts whose issue follows the last hotspot', async t => {
  const {mkdtemp,readFile,readdir,rm}=await import('node:fs/promises');
  const {tmpdir}=await import('node:os');
  const {join,resolve}=await import('node:path');
  const {promisify}=await import('node:util');
  const {execFile}=await import('node:child_process');
  const run=promisify(execFile);
  const fixture=JSON.parse(await readFile('data/snapshots/castelltallat-drill-2026-09-19T13-55-15-930Z.json','utf8')).frames[7];
  assert.ok(Date.parse(fixture.spread[0].issued_at)>Math.max(...fixture.hotspots.map((h:{properties:{observed_at:string}})=>Date.parse(h.properties.observed_at))));
  const folder=await mkdtemp(join(tmpdir(),'wildfire-record-test-'));
  t.after(()=>rm(folder,{recursive:true,force:true}));
  const server=createServer((req,res)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify(fixture[req.url!.slice(1)]));});
  await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));
  t.after(()=>new Promise<void>(done=>server.close(()=>done())));
  await run(process.execPath,[resolve('scripts/record-snapshot.mjs'),'--scenario','single'],{
    cwd:folder,timeout:5000,env:{...process.env,DEEPFIRE_API_KEY:'',DEEPFIRE_BASE_URL:`http://127.0.0.1:${(server.address() as {port:number}).port}`},
  });
  const [file]=await readdir(join(folder,'data/snapshots'));
  const stored=JSON.parse(await readFile(join(folder,'data/snapshots',file),'utf8'));
  assert.equal(stored.frames.length,1);
  assert.equal(stored.dataKind,'exercise');
  const script=`import {ReplayProvider} from ${JSON.stringify(resolve('server/providers/replay.ts'))};
    const value=await new ReplayProvider(${JSON.stringify(file)}).getFires();
    console.log(JSON.stringify({perimeters:value.perimeters.length,spread:value.spread.length,asOf:value.asOf,kind:value.dataKind}));`;
  const replay=await run(process.execPath,['--import',resolve('node_modules/tsx/dist/loader.mjs'),'--input-type=module','-e',script],{cwd:folder,timeout:5000});
  assert.deepEqual(JSON.parse(replay.stdout),{perimeters:1,spread:4,asOf:stored.frames[0].t,kind:'exercise'});
});
