import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {AgentPanel} from '../src/hud/agentPanel';

function report(fireId:string) {
  return {fireId,summary:`Server facts for ${fireId}`,recommendations:[],narrator:'template',packet:{
    fireId,fireName:null,dataProvenance:'replay',perimeterAreaKm2:null,spreadHorizonHours:0,spreadStatus:'unavailable',spreadValidAt:null as string|null,
    hotspotCount:2,threats:[],corridorCount:0,infrastructureCoverage:null,
    infrastructureStatus:{state:'unavailable',loadedFiles:[],failedFiles:['towns.geojson'],rejectedFeatures:0},
    evidenceAsOf:'2026-07-09T12:00:00Z',availabilityPolicy:'capture-test',computedAt:'2026-09-20T00:00:00Z',
  }};
}

test('situation panel follows fire and cursor, aborts stale requests, and clears on deselection',async(t)=>{
  const dom=new JSDOM('<main></main>');
  Object.defineProperty(globalThis,'document',{value:dom.window.document,configurable:true});
  t.after(()=>{delete (globalThis as {document?:Document}).document;dom.window.close();});
  const root=dom.window.document.querySelector('main')!;
  const pending:{url:string;signal:AbortSignal;finish:(response:Response)=>void}[]=[];
  t.mock.method(globalThis,'fetch',(url:string,init:RequestInit)=>new Promise<Response>(finish=>pending.push({url,signal:init.signal!,finish})));
  const panel=new AgentPanel(root);
  panel.track('a',0,'first');panel.track('a',0,'first');assert.equal(pending.length,1);
  panel.track('a',3600,'next');assert.ok(pending[0].signal.aborted);assert.match(pending[1].url,/&at=3600$/);
  panel.track('b',3600,'next');assert.ok(pending[1].signal.aborted);
  pending[2].finish(Response.json(report('b')));
  await new Promise(resolve=>setImmediate(resolve));
  assert.match(root.textContent!,/Server facts for b/);
  assert.match(root.textContent!,/INFRASTRUCTURE DATA UNAVAILABLE/);
  assert.match(root.textContent!,/EVIDENCE 2026-07-09T12:00:00Z/);
  pending[0].finish(Response.json(report('a')));pending[1].finish(Response.json(report('a')));
  await new Promise(resolve=>setImmediate(resolve));
  assert.doesNotMatch(root.textContent!,/Server facts for a/);
  panel.track(null);assert.equal(root.textContent,'');assert.equal(root.classList.contains('open'),false);
});

test('report retry preserves the selected evidence cursor',async(t)=>{
  const dom=new JSDOM('<main></main>');
  Object.defineProperty(globalThis,'document',{value:dom.window.document,configurable:true});
  t.after(()=>{delete (globalThis as {document?:Document}).document;dom.window.close();});
  const root=dom.window.document.querySelector('main')!;const urls:string[]=[];
  t.mock.method(globalThis,'fetch',async(url:string)=>{urls.push(url);return urls.length===1?new Response('',{status:502}):Response.json(report('b'));});
  const panel=new AgentPanel(root);panel.track('b',7200,'cursor');
  await new Promise(resolve=>setImmediate(resolve));
  panel.track('b',7200,'cursor');assert.equal(urls.length,1,'render notifications must not retry a failed request');
  root.querySelector('button')!.click();
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(urls.length,2);assert.equal(urls[0],urls[1]);assert.match(urls[1],/&at=7200$/);
  assert.match(root.textContent!,/Server facts for b/);
});


test('report marks an expired projection with its absolute valid time', async (t) => {
  const dom=new JSDOM('<main></main>');
  Object.defineProperty(globalThis,'document',{value:dom.window.document,configurable:true});
  t.after(()=>{delete (globalThis as {document?:Document}).document;dom.window.close();});
  const response=report('expired');
  response.packet.spreadStatus='expired';response.packet.spreadHorizonHours=6;
  response.packet.spreadValidAt='2026-07-09T18:00:00Z';
  t.mock.method(globalThis,'fetch',async()=>Response.json(response));
  const root=dom.window.document.querySelector('main')!;
  new AgentPanel(root).track('expired');
  await new Promise(resolve=>setImmediate(resolve));
  assert.match(root.textContent!,/SPREADEXPIRED/);
  assert.match(root.textContent!,/PROJECTION VALID2026-07-09T18:00:00Z/);
  assert.doesNotMatch(root.textContent!,/6 H/);
});

test('situation panel renders the snapshot limitation from the evidence packet',async t=>{
  const dom=new JSDOM('<main></main>');
  Object.defineProperty(globalThis,'document',{value:dom.window.document,configurable:true});
  t.after(()=>{delete (globalThis as {document?:Document}).document;dom.window.close();});
  const note='OSM snapshot 2026-09-18; not a historical inventory. Mapped assets may be incomplete.';
  const original=report('almeria');
  const response={...original,packet:{...original.packet,infrastructureCoverage:{label:'Eastern Almería',bbox:[-2.45,36.8,-1.55,37.65],note}}};
  t.mock.method(globalThis,'fetch',async()=>Response.json(response));
  const root=dom.window.document.querySelector('main')!;
  new AgentPanel(root).track('almeria');
  await new Promise(resolve=>setImmediate(resolve));
  assert.ok(root.textContent!.includes(note));
});
