import test from 'node:test';
import assert from 'node:assert/strict';
import {toAsset, lineToAsset, coverageAt, getInfrastructure} from './infrastructure';

test('coverage identifies the demo region without claiming the gap to Catalonia',()=>{
  assert.match(coverageAt({lat:37.17,lon:-1.95})!.label,/Almería/);
  assert.match(coverageAt({lat:37.17,lon:-1.95})!.note!,/2026-09-18/);
  assert.match(coverageAt({lat:41.4,lon:2.1})!.label,/Catalonia/);
  assert.equal(coverageAt({lat:39.5,lon:-.5}),null);
});

test('bundled demo infrastructure includes every category and retains Catalonia',async()=>{
  const data=await getInfrastructure();
  assert.equal(data.status.state,'available');
  const local=data.assets.filter(a=>a.id.startsWith('osm-eastern-almeria-'));
  assert.deepEqual([...new Set(local.map(a=>a.category))].sort(),['hospital','power-line','school','town']);
  assert.ok(local.some(a=>a.name==='Los Gallardos'));
  assert.ok(local.some(a=>a.name==='Bédar'));
  assert.ok(data.assets.some(a=>a.position.lat>40.5 && a.position.lon>0));
  assert.equal(new Set(data.assets.map(a=>a.id)).size,data.assets.length);
  for(const a of local){
    assert.match(coverageAt(a.position)!.label,/Almería/);
    if(a.category==='power-line') assert.ok(data.powerLinePaths[a.id].length>=2);
  }
});

test('infrastructure ingest rejects unknown point categories without dropping valid neighbors',()=>{
  const feature={properties:{id:'h',name:'Hospital',category:'hospital'},geometry:{type:'Point' as const,coordinates:[2,41] as [number,number]}};
  const raw=[null,{...feature,properties:{...feature.properties,category:'unknown'}},feature,
    {...feature,properties:{...feature.properties,category:'power-line'}}, {...feature,geometry:{type:'Point',coordinates:[2]}}];
  const assets=raw.map(f=>toAsset(f as Parameters<typeof toAsset>[0])).filter(Boolean);
  assert.deepEqual(assets.map(a=>a?.category),['hospital']);
  for(const category of ['school','town'])assert.equal(toAsset({...feature,properties:{...feature.properties,category}})?.category,category);
});

test('infrastructure ingest only accepts usable line paths',()=>{
  const feature={properties:{id:'line'},geometry:{type:'LineString' as const,coordinates:[[2,41],[3,42]] as [number,number][]}};
  assert.equal(lineToAsset(feature)?.path.length,2);
  for(const bad of [null,{...feature,geometry:{type:'LineString',coordinates:[[2],[3,42]]}}, {...feature,geometry:{type:'LineString',coordinates:[[2,NaN],[3,42]]}}])
    assert.equal(lineToAsset(bad as Parameters<typeof lineToAsset>[0]),null);
});
