import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { EntityCollection, type Viewer } from 'cesium';
import { FireLayer } from '../src/fires/fireLayer';
import { createFireLayer } from '../src/layers/fireLayer';
import { FireSelectionLayer } from '../src/layers/fireSelection';
import { FirePlayback } from '../src/data/playback';
import { connectFireViews } from '../src/data/fireSession';
import { AgentPanel } from '../src/hud/agentPanel';
import type { FiresResponse } from '../shared/fires';

function frame(at = 0): FiresResponse {
  return {provenance:'replay',scenario:'test',fetchedAt:'2026-07-09T02:00:00Z',
    asOf:new Date(Date.parse('2026-07-09T00:00:00Z')+at*1000).toISOString(),
    timeline:{scenario:'test',start:'2026-07-09T00:00:00Z',end:'2026-07-09T02:00:00Z',durationSeconds:7200,frames:[]},
    hotspots:[{id:'h1',position:{lat:37,lon:-2},frpMw:5,confidence:null,detectedAt:'2026-07-09T00:00:00Z',satellite:null,clusterId:'c1'}],
    clusters:[{id:'c1',name:'Fire',centroid:{lat:37,lon:-2},hotspotIds:['h1'],bbox:[-2,37,-1.9,37.1],totalFrpMw:5,firstDetectedAt:null,lastDetectedAt:null}],
    perimeters:[],spread:[]};
}

test('replay reuses unchanged hotspot entities and removes observations when seeking back', t => {
  const dom=new JSDOM('<canvas></canvas><main></main>');
  Object.defineProperty(globalThis,'document',{value:dom.window.document,configurable:true});
  t.after(() => { delete (globalThis as {document?:Document}).document; dom.window.close(); });
  const entities=new EntityCollection();
  const viewer={entities,scene:{canvas:dom.window.document.querySelector('canvas'),pick:()=>undefined}} as unknown as Viewer;
  const renderer=createFireLayer(viewer,dom.window.document.querySelector('main')!);
  renderer.setData(frame());
  const original=entities.getById('hotspot-h1');
  assert.ok(original);
  renderer.setData(frame(1800));
  assert.equal(entities.getById('hotspot-h1'),original);
  const changed=frame(3600); changed.hotspots[0].frpMw=50;
  renderer.setData(changed);
  assert.notEqual(entities.getById('hotspot-h1'),original);
  renderer.setData({...frame(),hotspots:[],clusters:[]});
  assert.equal(entities.values.length,0);
});

test('threat refresh shares the committed cursor without reselecting or moving the camera', async t => {
  const dom=new JSDOM('<canvas></canvas><main></main>');
  Object.defineProperty(globalThis,'document',{value:dom.window.document,configurable:true});
  t.after(() => { delete (globalThis as {document?:Document}).document; dom.window.close(); });
  const calls:string[]=[];
  t.mock.method(globalThis,'fetch',async url => {
    calls.push(String(url));
    return new Response(JSON.stringify({fireId:'c1',hasPerimeter:false,rings:[],threatened:[],corridorCount:0,computedAt:'now'}));
  });
  const viewer={entities:new EntityCollection(),scene:{canvas:dom.window.document.querySelector('canvas'),pick:()=>undefined}} as unknown as Viewer;
  const selections:(string|null)[]=[];
  const selection=new FireSelectionLayer(viewer,dom.window.document.querySelector('main')!,id=>selections.push(id));
  t.after(()=>selection.destroy());
  selection.setData(frame()); selection.track('c1',0,'first');
  await new Promise(resolve=>setImmediate(resolve));
  selection.track('c1',0,'first');
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(calls.length,1,'the same selection and evidence must not fetch again');
  selection.setData(frame(3600)); selection.track('c1',3600,'next');
  await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(calls,['/api/threats?fireId=c1&at=0','/api/threats?fireId=c1&at=3600']);
  assert.deepEqual(selections,[]);
  selection.setData({...frame(),hotspots:[],clusters:[]});
  selection.track(null);
  assert.deepEqual(selections,[]);
  assert.equal(dom.window.document.querySelector('main')!.textContent,'');
});


test('selected cluster survives new observations without a perimeter or camera movement', t => {
  const dom=new JSDOM('<canvas></canvas>');
  Object.defineProperty(globalThis,'document',{value:dom.window.document,configurable:true});
  t.after(()=>{delete (globalThis as {document?:Document}).document;dom.window.close();});
  let flights=0;
  const viewer={dataSources:{add:()=>{},remove:()=>{}},camera:{flyTo:()=>{flights++;}},
    scene:{canvas:dom.window.document.querySelector('canvas'),pick:()=>undefined,
      preRender:{addEventListener:()=>()=>{}}}} as unknown as Viewer;
  const layer=new FireLayer(viewer);t.after(()=>layer.dispose());
  layer.setData(frame());layer.select('c1',{flyTo:true});
  assert.equal(flights,1);
  assert.equal(layer.getState().playing,false);
  layer.setData(frame(3600));
  assert.equal(layer.getState().selectedId,'c1');
  assert.equal(layer.getState().selectedCase,null);
  assert.equal(flights,1);
  layer.setPlaying(true);assert.equal(layer.getState().playing,false);
  layer.setData({...frame(),clusters:[],hotspots:[]});
  assert.equal(layer.getState().selectedId,null);
});


test('application wiring commits one cursor before selection and report requests on every frame',async t=>{
  const dom=new JSDOM('<canvas></canvas><main></main><aside></aside>');
  Object.defineProperty(globalThis,'document',{value:dom.window.document,configurable:true});
  t.after(()=>{delete (globalThis as {document?:Document}).document;dom.window.close();});
  const calls:string[]=[];
  t.mock.method(globalThis,'fetch',async url=>{calls.push(String(url));return new Response('',{status:502});});
  const viewer={entities:new EntityCollection(),dataSources:{add:()=>{},remove:()=>{}},camera:{flyTo:()=>{}},
    scene:{canvas:dom.window.document.querySelector('canvas'),pick:()=>undefined,
      preRender:{addEventListener:()=>()=>{}}}} as unknown as Viewer;
  const fires=new FireLayer(viewer);
  const selection=new FireSelectionLayer(viewer,dom.window.document.querySelector('main')!,()=>{});
  const agent=new AgentPanel(dom.window.document.querySelector('aside')!);
  const playback=new FirePlayback(async at=>frame(at));
  t.after(()=>{playback.dispose();fires.dispose();selection.destroy();});
  connectFireViews(playback,{entities:viewer.entities,hud:{setMode:()=>{}},
    hotspots:createFireLayer(viewer,dom.window.document.querySelector('main')!),fires,selection,agent});
  await playback.start();fires.select('c1');
  await new Promise(resolve=>setImmediate(resolve));
  await playback.seek(3600);
  await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(calls,['/api/threats?fireId=c1&at=0','/api/situation?fireId=c1&at=0',
    '/api/threats?fireId=c1&at=3600','/api/situation?fireId=c1&at=3600']);
  playback.pause();
  assert.equal(calls.length,4,'loading and pause notifications do not fetch again');
});

test('reframe only moves the camera and preserves forecast horizon, playback and selected geometry', t => {
  const dom=new JSDOM('<canvas></canvas>');
  Object.defineProperty(globalThis,'document',{value:dom.window.document,configurable:true});
  t.after(()=>{delete (globalThis as {document?:Document}).document;dom.window.close();});
  const canvasGlobals = {HTMLCanvasElement:dom.window.HTMLCanvasElement, HTMLImageElement:dom.window.HTMLImageElement,
    ImageBitmap:class {}, OffscreenCanvas:class {}};
  for (const [name,value] of Object.entries(canvasGlobals)) {
    const previous=Object.getOwnPropertyDescriptor(globalThis,name);
    Object.defineProperty(globalThis,name,{value,configurable:true});
    t.after(()=>{if(previous)Object.defineProperty(globalThis,name,previous);else Reflect.deleteProperty(globalThis,name);});
  }
  let flights=0;
  const viewer={dataSources:{add:()=>{},remove:()=>{}},camera:{flyTo:()=>{flights++;}},
    scene:{canvas:dom.window.document.querySelector('canvas'),pick:()=>undefined,
      primitives:{add:()=>{},remove:()=>{}},preRender:{addEventListener:()=>()=>{}}}} as unknown as Viewer;
  const layer=new FireLayer(viewer);t.after(()=>layer.dispose());
  const data=frame();
  const polygon=[{lat:37,lon:-2},{lat:37.1,lon:-2},{lat:37.1,lon:-1.9},{lat:37,lon:-2}];
  data.perimeters=[{clusterId:'c1',observedAt:data.asOf!,areaKm2:1,polygon,partIndex:0,partCount:1}];
  data.spread=[{clusterId:'c1',horizonHours:8,at:'2026-07-09T08:00:00Z',polygon:polygon.map(p=>({lat:p.lat+.01,lon:p.lon+.01}))}];
  layer.setData(data);layer.select('c1');layer.setScrub(4);layer.setPlaying(true);
  const before=layer.getState();layer.reframe();
  assert.equal(flights,1);
  const after=layer.getState();
  assert.equal(after.selectedCase,before.selectedCase);
  assert.equal(after.scrubHours,4);
  assert.equal(after.playing,true);
  assert.deepEqual(after.projection,before.projection);
  layer.deselect();layer.reframe();assert.equal(flights,1);
});
