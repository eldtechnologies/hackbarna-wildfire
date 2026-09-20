import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {loadInfrastructure} from './infrastructure';

test('infrastructure rejects missing, empty and unusable files and reports partial bundles',async(t)=>{
  const directory=await mkdtemp(join(tmpdir(),'infra-status-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const files=['hospitals.geojson','schools.geojson','towns.geojson','power-lines.geojson'];
  const missing=await loadInfrastructure(directory);
  assert.equal(missing.status.state,'unavailable');assert.equal(missing.status.failedFiles.length,4);
  for(const file of files) await writeFile(join(directory,file),JSON.stringify({features:[]}));
  const empty=await loadInfrastructure(directory);
  assert.equal(empty.status.state,'unavailable');assert.equal(empty.assets.length,0);
  assert.deepEqual(empty.status.failedFiles,files);
  assert.deepEqual(empty.status.loadedFiles,[]);
  const point={properties:{id:'hospital',name:'Hospital',category:'hospital'},geometry:{type:'Point',coordinates:[2,41]}};
  await writeFile(join(directory,files[0]),JSON.stringify({features:[point]}));
  const partial=await loadInfrastructure(directory);
  assert.equal(partial.status.state,'partial');assert.equal(partial.status.loadedFiles.length,1);
  for(const [i,category] of ['school','town'].entries())
    await writeFile(join(directory,files[i+1]),JSON.stringify({features:[{...point,properties:{id:category,name:category,category}}]}));
  await writeFile(join(directory,files[3]),JSON.stringify({features:[{properties:{id:'line'},geometry:{type:'LineString',coordinates:[[2,41],[3,42]]}}]}));
  assert.equal((await loadInfrastructure(directory)).status.state,'available');
  await writeFile(join(directory,files[2]),JSON.stringify({features:[null]}));
  const rejected=await loadInfrastructure(directory);
  assert.equal(rejected.status.state,'partial');
  assert.deepEqual(rejected.status.failedFiles,['towns.geojson']);
  assert.equal(rejected.status.rejectedFeatures,1);
});
