import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, writeFile, unlink, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { getFires, getProvider, parseSource } from './index';
import { ReplayProvider } from './replay';
import { getSituation } from '../situation';
import { createApp } from '../index';
import { buildFireCases } from '../../src/fires/spreadModel';
import { ringCentroid } from '../../src/fires/geometry';

const replay = new ReplayProvider('los-gallardos-2026-07-09.json');
const fireId = '4e41fc85-3084-4220-9dfb-36bab806a6f9';
const run = promisify(execFile);

test('source and cursor isolate memoized evidence; only observation sources are accepted', async t => {
  const real = await replay.getFires(0);
  t.mock.method(getProvider('configured'), 'getFires', async () => ({...real, scenario:'configured-capture'}));
  const [configured, observations] = await Promise.all([getFires(0, 'configured'), getFires(0, 'replay')]);
  assert.equal(configured.source, 'configured');
  assert.equal(observations.source, 'replay');
  assert.notEqual(configured.scenario, observations.scenario);
  assert.equal(await getFires(0, 'configured'), configured);
  assert.equal(await getFires(0, 'replay'), observations);
  for (const value of ['drill', '../../.env', 'unknown', ['live'], {}, null]) assert.throws(() => parseSource(value));
});

test('failed live feed falls back to the pinned real observations', async t => {
  t.mock.method(getProvider('live'), 'getFires', async () => { throw new Error('offline'); });
  const fires = await getFires(3344, 'live');
  assert.equal(fires.requestedSource, 'live');
  assert.equal(fires.source, 'replay');
  assert.equal(fires.scenario, 'los-gallardos-2026-07-09');
  assert.equal(fires.fallbackReason, 'live_unavailable');
});

test('real-fire geometry and report agree that the recorded perimeter is not a forecast', async () => {
  const open = [{lat:0,lon:0},{lat:2,lon:0},{lat:2,lon:2},{lat:0,lon:2}];
  assert.deepEqual(ringCentroid([...open, open[0]]), ringCentroid(open));
  const fires = await getFires(undefined, 'replay');
  const report = (await getSituation(fireId, undefined, 'replay'))!;
  assert.match(report.summary, /No spread projection is available/);
  assert.equal(report.packet.dataProvenance, 'replay');
  assert.equal(buildFireCases(fires).find(item => item.cluster.id === fireId)!.maxHorizonHours, 0);
  assert.equal(report.packet.spreadBearingDeg, null);
});

test('all dependent HTTP routes use the real replay and reject the removed source', async t => {
  const server = createServer(createApp());
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const base = `http://127.0.0.1:${(server.address() as {port:number}).port}`;
  for (const [endpoint, params] of [['fires',''], ['threats',`&fireId=${fireId}`], ['situation',`&fireId=${fireId}`], ['growth',`&clusterId=${fireId}`]]) {
    const response = await fetch(`${base}/api/${endpoint}?source=replay&at=259140${params}`);
    assert.equal(response.status, 200, endpoint);
    for (const source of ['drill', '../../.env']) {
      const bad = await fetch(`${base}/api/${endpoint}?source=${source}${params}`);
      assert.equal(bad.status, 400, endpoint);
    }
  }
});

test('configured recordings cannot relabel non-observation data as a real fire', async t => {
  const name = `unsupported-kind-${randomUUID()}.json`;
  const file = resolve('data/snapshots', name);
  t.after(() => unlink(file));
  await writeFile(file, JSON.stringify({scenario:'unsupported',dataKind:'exercise',frames:[{
    t:'2026-07-10T10:00:00Z',hotspots:[],clusters:[],spread:[],
  }]}));
  await assert.rejects(new ReplayProvider(name).getFires(), /does not contain satellite observations/);
});

test('the observation recorder preserves source timestamps and its single-frame capture remains replayable', async t => {
  const capture = JSON.parse(await readFile('data/snapshots/los-gallardos-2026-07-09.json', 'utf8'));
  const fixture = {hotspots:capture.hotspots.slice(0,1),clusters:capture.clusters,spread:[]};
  const folder = await mkdtemp(join(tmpdir(), 'wildfire-record-test-'));
  t.after(() => rm(folder, {recursive:true,force:true}));
  const server = createServer((req,res) => {
    res.setHeader('content-type','application/json');
    res.end(JSON.stringify(fixture[req.url!.slice(1) as keyof typeof fixture]));
  });
  await new Promise<void>(done => server.listen(0,'127.0.0.1',done));
  t.after(() => new Promise<void>(done => server.close(() => done())));
  await run(process.execPath, [resolve('scripts/record-snapshot.mjs'),'--scenario','single'], {
    cwd:folder,timeout:5000,env:{...process.env,DEEPFIRE_API_KEY:'',DEEPFIRE_BASE_URL:`http://127.0.0.1:${(server.address() as {port:number}).port}`},
  });
  const [file] = await readdir(join(folder,'data/snapshots'));
  const stored = JSON.parse(await readFile(join(folder,'data/snapshots',file),'utf8'));
  assert.equal(stored.dataKind, 'observations');
  assert.deepEqual(stored.hotspots, fixture.hotspots);
  assert.deepEqual(stored.spread, fixture.spread);
  const script = `import {ReplayProvider} from ${JSON.stringify(new URL('./replay.ts',import.meta.url).href)};
    const value=await new ReplayProvider(${JSON.stringify(file)}).getFires();
    console.log(JSON.stringify({hotspots:value.hotspots.length,spread:value.spread.length,provenance:value.provenance}));`;
  const result = await run(process.execPath,['--import',import.meta.resolve('tsx'),'--input-type=module','-e',script], {cwd:folder,timeout:5000});
  assert.deepEqual(JSON.parse(result.stdout), {hotspots:1,spread:0,provenance:'replay'});
});
