import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { causalResponse, captureTimeline } from './causal';
import { detectionAvailableAt, parseCursor } from './availability';
import { ReplayProvider } from './replay';
import { growthFor } from '../model';

const source=JSON.parse(readFileSync(new URL('../../data/snapshots/los-gallardos-2026-07-09.json',import.meta.url),'utf8'));

test('the actual July capture starts without future observations and acquires evidence over time',async()=>{
  const provider=new ReplayProvider();
  const early=await provider.getFires(0),later=await provider.getFires(18*3600);
  assert.equal(early.hotspots.length,0);assert.equal(early.clusters.length,0);
  assert.equal(early.perimeters.length,0);assert.equal(early.asOf,'2026-07-09T00:00:00.000Z');
  assert.ok(later.hotspots.length>0);assert.ok(later.hotspots.length<source.hotspots.length);
  assert.ok(later.timeline);assert.equal(later.timeline.start,early.asOf);
  for(const h of later.hotspots) assert.ok(Date.parse(h.detectedAt!)<=Date.parse(later.asOf!));
});

test('future detections and final cluster metadata cannot alter an earlier response',()=>{
  const issue=Date.parse('2026-07-09T18:00:00Z');
  const changed=structuredClone(source);
  for(const h of changed.hotspots) if(detectionAvailableAt(h.properties)!>issue) {
    h.geometry.coordinates=[0,0];h.properties.fire_radiative_power=1e9;
  }
  for(const c of changed.clusters) {c.geometry.coordinates=[80,80];c.properties.first_observed='2099-01-01T00:00:00Z';}
  const before=causalResponse(source,'test',issue),after=causalResponse(changed,'test',issue);
  assert.deepEqual(after.hotspots,before.hotspots);assert.deepEqual(after.clusters,before.clusters);
  assert.deepEqual(after.perimeters,before.perimeters);
  const cluster=before.clusters.find(c=>c.hotspotIds.length>=4)!;
  const a=growthFor(cluster.id,before,new Date(before.asOf!))!;
  const b=growthFor(cluster.id,after,new Date(after.asOf!))!;
  assert.deepEqual(a,b);assert.equal(a.at,before.asOf);
  assert.ok(a.baselines[0].hoursSinceLastDetection!<6);
});

test('availability requires qualified time and respects recorded delivery',()=>{
  assert.equal(detectionAvailableAt({observed_at:'2026-07-09T12:00:00',source:'MTG_I1'}),null);
  assert.equal(detectionAvailableAt({observed_at:'2026-07-09T12:00:00Z',source:'MTG_I1',available_at:'2026-07-09T13:00:00Z'}),Date.parse('2026-07-09T13:00:00Z'));
  assert.equal(detectionAvailableAt({observed_at:'2026-07-09T12:00:00Z',source:'__proto__'}),Date.parse('2026-07-09T15:00:00Z'));
});

test('future perimeter computation and forecasts without an issue time stay hidden',()=>{
  const raw=structuredClone(source);
  const issue=Date.parse('2026-07-09T18:00:00Z');
  for(const p of raw.perimeters) p.properties.computed_at='2026-07-12T00:00:00Z';
  raw.spread=[{cluster_id:'x',valid_time:'2026-07-09T19:00:00Z',horizon_hours:1,geometry:{type:'Polygon',coordinates:[[[0,0],[1,0],[1,1],[0,0]]]}}];
  const r=causalResponse(raw,'test',issue);assert.equal(r.perimeters.length,0);assert.equal(r.spread.length,0);
});

test('a declared empty window is valid; invalid cursor spellings are not',()=>{
  const t=captureTimeline({hotspots:[],clusters:[],perimeters:[],window:{from:'2026-07-09T00:00Z',to:'2026-07-10T00:00Z'}},'empty');
  assert.equal(t.durationSeconds,86400);
  for(const value of ['-1','NaN','1e3','0x10',[],{}])assert.throws(()=>parseCursor(value));
  assert.equal(parseCursor('0'),0);
});

test('the committed legacy recording remains loadable without a perimeters collection',async()=>{
  const {spawnSync}=await import('node:child_process');
  const child=spawnSync(process.execPath,['--import','tsx','--input-type=module','-e',
    "import { ReplayProvider } from './server/providers/replay.ts'; const r=await new ReplayProvider().getFires(); if(r.provenance!=='replay' || !Array.isArray(r.perimeters)) process.exit(1);"],
    {env:{...process.env,REPLAY_SNAPSHOT:'castelltallat-drill-2026-09-19T13-55-15-930Z.json'},encoding:'utf8',timeout:10000});
  assert.equal(child.status,0,child.stderr);
});

test('a zero-horizon polygon cannot become a future observed perimeter',()=>{
  const raw=structuredClone(source);raw.perimeters=[];
  raw.spread=[{cluster_id:'x',issued_at:'2026-07-09T17:00:00Z',valid_time:'2026-07-09T22:00:00Z',horizon_hours:0,
    geometry:{type:'Polygon',coordinates:[[[0,0],[1,0],[1,1],[0,0]]]}}];
  const r=causalResponse(raw,'test',Date.parse('2026-07-09T18:00:00Z'));
  assert.equal(r.perimeters.length,0);assert.equal(r.spread.length,0);
  raw.spread[0].valid_time='2026-07-09T17:00:00Z';
  assert.equal(causalResponse(raw,'test',Date.parse('2026-07-09T18:00:00Z')).perimeters.length,1);
});
