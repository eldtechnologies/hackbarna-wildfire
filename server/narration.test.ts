import test from 'node:test';
import assert from 'node:assert/strict';
import {FactNarrator} from './narration';
import {BoundedCache} from './bounded-cache';

const facts=[{id:'area',text:'The perimeter covers 11 km2.'},{id:'threats',text:'34 towns in the screening area.'}];
const options={apiKey:'test-only',baseUrl:'https://provider.invalid/v1',model:'test-model',waitMs:25,timeoutMs:1_000};
const response=(value:unknown)=>Response.json({choices:[{message:{content:JSON.stringify(value)}}]});

test('model output can only order exact server facts; arbitrary claims and omissions fail closed',async(t)=>{
  for(const output of [{summary:'176 towns are at risk.'},{summary:'No infrastructure is at risk.'},
    {order:['area']},{order:['threats','threats']},{order:['area','invented']},
    {order:['threats','area'],summary:'Conditions are calm.'},null]) {
    t.mock.method(globalThis,'fetch',async()=>response(output));
    assert.equal(await new FactNarrator(options).order(facts),null);
    t.mock.restoreAll();
  }
  t.mock.method(globalThis,'fetch',async()=>response({order:['threats','area']}));
  assert.deepEqual(await new FactNarrator(options).order(facts),['threats','area']);
});

test('all callers get a wait budget while the single job survives waiter timeouts',async(t)=>{
  let calls=0;let finish!:(r:Response)=>void;
  t.mock.method(globalThis,'fetch',()=>{calls++;return new Promise<Response>(resolve=>{finish=resolve;});});
  const narrator=new FactNarrator(options);
  const first=narrator.order(facts),second=narrator.order(facts);
  assert.deepEqual(await Promise.all([first,second]),[null,null]);
  assert.equal(await narrator.order(facts),null);
  assert.equal(calls,1,'timed-out waiter must not release the running job');
  finish(response({order:['area','threats']}));
  await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(await narrator.order(facts),['area','threats']);
  assert.equal(calls,1);
});

test('the provider work and prompt are bounded and keyless works without fetch',async(t)=>{
  let calls=0; const finishes:((r:Response)=>void)[]=[];
  t.mock.method(globalThis,'fetch',(_url:unknown,request:RequestInit)=>{
    calls++;
    const body=JSON.parse(request.body as string);
    assert.equal(body.max_completion_tokens,128);
    assert.ok(Buffer.byteLength(body.messages[1].content)<=8_000);
    return new Promise<Response>(resolve=>{finishes.push(resolve);});
  });
  const narrator=new FactNarrator(options);
  assert.equal(await new FactNarrator({...options,apiKey:''}).order(facts),null);
  assert.equal(await narrator.order([{id:'huge',text:'x'.repeat(8_001)}]),null);
  const jobs=[narrator.order(facts),narrator.order([{id:'another',text:'different evidence'}])];
  assert.equal(await narrator.order([{id:'third',text:'third evidence'}]),null);
  assert.equal(calls,2);
  finishes[0](response({order:['area','threats']}));finishes[1](response({order:['another']}));
  await Promise.all(jobs);
});

test('provider errors are cached briefly and aborts keep the template path available',async(t)=>{
  let calls=0;
  t.mock.method(globalThis,'fetch',async()=>{calls++;return new Response('',{status:429});});
  const narrator=new FactNarrator(options);
  assert.equal(await narrator.order(facts),null);assert.equal(await narrator.order(facts),null);assert.equal(calls,1);
  t.mock.restoreAll();
  t.mock.method(globalThis,'fetch',(_url:unknown,request:RequestInit)=>new Promise((_resolve,reject)=>{
    request.signal!.addEventListener('abort',()=>reject(new Error('abort')),{once:true});
  }));
  assert.equal(await new FactNarrator({...options,waitMs:500,timeoutMs:10}).order(facts),null);
});

test('cache evicts oldest and expired entries',()=>{
  const cache=new BoundedCache<number>(2,1000);
  cache.set('a',1);cache.set('b',2);cache.set('c',3);
  assert.equal(cache.get('a'),undefined);assert.equal(cache.get('c'),3);
  const expired=new BoundedCache<number>(2,0);expired.set('a',1);assert.equal(expired.get('a'),undefined);
});
