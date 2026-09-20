import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {loadInfrastructure} from './infrastructure';

test('infrastructure distinguishes missing, partial and successfully empty datasets',async(t)=>{
  const directory=await mkdtemp(join(tmpdir(),'infra-status-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const missing=await loadInfrastructure(directory);
  assert.equal(missing.status.state,'unavailable');assert.equal(missing.status.failedFiles.length,4);
  await writeFile(join(directory,'hospitals.geojson'),JSON.stringify({features:[]}));
  const partial=await loadInfrastructure(directory);
  assert.equal(partial.status.state,'partial');assert.equal(partial.status.loadedFiles.length,1);
  for(const file of ['schools.geojson','towns.geojson','power-lines.geojson'])
    await writeFile(join(directory,file),JSON.stringify({features:[]}));
  const complete=await loadInfrastructure(directory);
  assert.equal(complete.status.state,'available');assert.equal(complete.assets.length,0);
  await writeFile(join(directory,'towns.geojson'),JSON.stringify({wrong:[]}));
  assert.equal((await loadInfrastructure(directory)).status.state,'partial');
});
