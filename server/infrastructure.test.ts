import test from 'node:test';
import assert from 'node:assert/strict';
import {toAsset, lineToAsset} from './infrastructure';

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
