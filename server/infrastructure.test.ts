import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
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
  const counts=(assets:typeof data.assets)=>Object.fromEntries(
    ['hospital','school','town','power-line'].map(kind=>[kind,assets.filter(a=>a.category===kind).length]));
  assert.deepEqual(counts(local),{hospital:10,school:153,town:601,'power-line':315});
  assert.deepEqual(counts(data.assets.filter(a=>!a.id.startsWith('osm-eastern-almeria-'))),
    {hospital:70,school:4742,town:947,'power-line':1241});
  const metadata=JSON.parse(await readFile('data/infrastructure/almeria-source.json','utf8'));
  assert.deepEqual(coverageAt({lat:37.17,lon:-1.95})!.bbox,metadata.bbox);
  for(const file of ['hospitals','schools','towns','power-lines']) {
    const collection=JSON.parse(await readFile(`data/infrastructure/${file}.geojson`,'utf8'));
    assert.deepEqual(collection.properties.almeria_source,metadata);
  }
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
