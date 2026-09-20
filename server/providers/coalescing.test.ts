import test from 'node:test';
import assert from 'node:assert/strict';
import {getFires,getProvider} from './index';
import {ReplayProvider} from './replay';

test('same-cursor provider reads share in-flight work and failed work can retry', async t => {
  const frame=await new ReplayProvider().getFires();
  let calls=0;
  let finish!:(value:typeof frame)=>void;
  t.mock.method(getProvider(),'getFires',()=>{calls++;return new Promise(resolve=>{finish=resolve;});});
  const first=getFires(987654321),second=getFires(987654321);
  assert.equal(calls,1);
  finish(frame);
  const results=await Promise.all([first,second]);
  assert.equal(results[0],results[1]);
  assert.equal(await getFires(987654321),results[0]);
  assert.equal(calls,1);
  t.mock.method(getProvider(),'getFires',async()=>{calls++;throw new Error('temporary fixture failure');});
  await assert.rejects(getFires(987654322),/temporary fixture failure/);
  t.mock.method(getProvider(),'getFires',async()=>{calls++;return frame;});
  assert.equal((await getFires(987654322)).scenario,frame.scenario);
  assert.equal(calls,3);
});
