import {fileURLToPath} from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { ForecastStore, validateForecast } from './forecast';
import { createApp } from '../index';

const example = new URL('../../data/forecasts/example/',import.meta.url);
const index = JSON.parse(await readFile(new URL('index.json',example),'utf8'));
const entry = index.entries[0];
const original = await readFile(new URL(entry.file,example));
const forecast = JSON.parse(original.toString());

test('Python-produced native-grid artifact survives the actual HTTP handoff unchanged',async()=>{
  const store=new ForecastStore(fileURLToPath(example));
  const server=createServer(createApp(undefined,store));
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
  const address=server.address();assert.ok(address && typeof address!=='string');
  const base=`http://127.0.0.1:${address.port}`;
  try {
    const list=await (await fetch(base+'/api/forecasts')).json() as any;
    assert.deepEqual(list.forecasts,[{eventId:entry.eventId,issuedAt:entry.issuedAt}]);
    const query=new URLSearchParams({eventId:entry.eventId,issue:entry.issuedAt});
    const response=await fetch(base+'/api/forecasts?'+query);
    assert.equal(response.status,200);assert.deepEqual(await response.json(),forecast);
    assert.equal((await fetch(base+'/api/forecasts?eventId=x&issue=2026-07-01T11:00:00')).status,400);
    assert.equal((await fetch(base+'/api/forecasts?eventId=x&issue=2026-07-01T11:00:00Z')).status,404);
    assert.equal((await fetch(base+'/api/forecasts?eventId[x]=a')).status,400);
    // Both routes must use exactly the same event issue time, including observation age.
    const fires=await (await fetch(base+'/api/fires?at=64800')).json() as any;
    assert.ok(fires.clusters.length>0);
    const growth=await (await fetch(base+`/api/growth?at=64800&clusterId=${fires.clusters[0].id}`)).json() as any;
    assert.equal(growth.at,fires.asOf);assert.equal(growth.at,'2026-07-09T18:00:00.000Z');
    assert.equal(growth.roadUse,'unsupported');assert.equal(growth.validation,'diagnostic_only');
    for(const route of ['/api/fires?at=-1',`/api/growth?clusterId=${fires.clusters[0].id}&at=NaN`])
      assert.equal((await fetch(base+route)).status,400);
  } finally {await new Promise<void>(r=>server.close(()=>r()));}
});

test('a corrupted artifact cannot be served; index filenames cannot escape the store',async()=>{
  const root=await mkdtemp(join(tmpdir(),'forecast-store-'));
  try {
    await writeFile(join(root,'index.json'),JSON.stringify(index));
    await writeFile(join(root,entry.file),Buffer.concat([original,Buffer.from(' ')]));
    const store=new ForecastStore(root);
    await assert.rejects(store.get(entry.eventId,entry.issuedAt),/checksum/);
    const bad=structuredClone(index);bad.entries[0].file='../outside.json';
    await writeFile(join(root,'index.json'),JSON.stringify(bad));
    await assert.rejects(store.list(),/index/);
    assert.equal(createHash('sha256').update(original).digest('hex'),entry.sha256);
  } finally {await rm(root,{recursive:true,force:true});}
});

test('unsafe semantics, future coverage, invalid grids and unaccepted models fail validation',()=>{
  for(const mutate of [
    (v:any)=>{v.roadUse='supported';},
    (v:any)=>{v.predictor='model';},
    (v:any)=>{v.horizons[1].probability[0]=-1;},
    (v:any)=>{v.horizons[0].probability[0]=1;v.horizons[1].probability[0]=0;},
    (v:any)=>{v.grid.centreTransform[0]+=500;},
    (v:any)=>{v.grid.proj4='+proj=longlat +datum=WGS84';},
    (v:any)=>{v.coverage.latestObservableBin.end='2099-01-01T00:00:00Z';},
    (v:any)=>{v.coverage.stale=true;},
    (v:any)=>{v.identity.inputSha256=null;},
  ]) {const value=structuredClone(forecast);mutate(value);assert.throws(()=>validateForecast(value));}
  const stale=structuredClone(forecast);
  stale.status='insufficient_observations';stale.coverage.stale=true;
  stale.coverage.observedFraction.fill(0);stale.coverage.latestObservableBin=null;
  for(const h of stale.horizons)h.probability=null;
  assert.equal(validateForecast(stale).status,'insufficient_observations');
});
