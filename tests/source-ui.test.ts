import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {FirePlayback} from '../src/data/playback';
import {initSourcePanel} from '../src/hud/sourcePanel';
import {connectFireViews} from '../src/data/fireSession';
import {fetchFires, fetchThreats, fetchSituation} from '../src/data/api';
import type {FiresResponse} from '../shared/fires';
import type {FireLayerState} from '../src/fires/fireLayer';

const frame:FiresResponse={provenance:'replay',scenario:'exercise',fetchedAt:'2026-09-19T01:00:00Z',asOf:'2026-09-19T01:00:00Z',
  source:'drill',requestedSource:'drill',dataKind:'exercise',hotspots:[],clusters:[],perimeters:[],spread:[],
  timeline:{scenario:'exercise',start:'2026-09-19T00:00:00Z',end:'2026-09-19T01:00:00Z',durationSeconds:3600,frames:[]}};

test('source selector reports actual provenance and keeps failure visible without relabelling the old scene', async t=>{
  const dom=new JSDOM('<main></main>');
  Object.defineProperty(globalThis,'document',{value:dom.window.document,configurable:true});
  let fail=false;
  const playback=new FirePlayback(async()=>{if(fail)throw new Error('offline');return frame;});
  t.after(()=>{playback.dispose();delete (globalThis as {document?:Document}).document;dom.window.close();});
  const root=dom.window.document.querySelector('main')!;
  initSourcePanel(playback,root);await playback.start();
  const panels = root.querySelector<HTMLButtonElement>('[aria-label="Hide inspectors"]')!;
  panels.click();assert.equal(root.classList.contains('inspectors-hidden'),true);
  panels.click();assert.equal(root.classList.contains('inspectors-hidden'),false);
  assert.equal(root.querySelector('select')!.value,'drill');
  assert.match(root.textContent!,/SIMULATED EXERCISE/);
  fail=true;
  const selector=root.querySelector('select')!;
  selector.value='live';selector.dispatchEvent(new dom.window.Event('change'));
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(playback.getState().source,'live');
  assert.equal(playback.getState().data?.source,'drill');
  assert.match(root.querySelector('.source-status')!.textContent!,/Source unavailable.*SIMULATED EXERCISE/);
});

test('committed source is forwarded to both reports, including same fire/time after source changes', async t=>{
  let listener!:(state:FireLayerState)=>void;
  const calls:unknown[][]=[];
  const playback=new FirePlayback(async(_at,_signal,source)=>({...frame,source:source??'drill'}));
  t.after(()=>playback.dispose());
  const state:FireLayerState={cases:[],selectedCase:null,selectedId:'fire',scrubHours:0,playing:false,projection:null};
  connectFireViews(playback,{
    entities:{suspendEvents:()=>{},resumeEvents:()=>{}},hud:{setMode:()=>{}},hotspots:{setData:()=>{}},
    fires:{onStateChange:(next)=>{listener=next;return()=>{};},setData:()=>listener(state)},
    selection:{setData:()=>{},track:(...args)=>{calls.push(args);}},agent:{track:(...args)=>{calls.push(args);}},
  });
  await playback.start();await playback.selectSource('replay');
  assert.deepEqual(calls.map(args=>args[3]),['drill','drill','replay','replay']);
  assert.ok(calls.every(args=>args[1]===3600));
});

test('fire, threat and report HTTP clients propagate source alongside the zero cursor', async t=>{
  const urls:string[]=[];
  t.mock.method(globalThis,'fetch',async(url:unknown)=>{urls.push(String(url));return Response.json(frame);});
  await fetchFires(0,undefined,'drill');await fetchThreats('fire/a',0,undefined,'drill');await fetchSituation('fire/a',0,undefined,'drill');
  for(const url of urls){assert.match(url,/at=0/);assert.match(url,/source=drill/);}
});
