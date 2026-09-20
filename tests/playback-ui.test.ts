import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { FirePlayback, replayPosition, bindPlaybackLifecycle } from '../src/data/playback';
import { initReplayPanel } from '../src/hud/replayPanel';
import { initFirePanels } from '../src/hud/firePanels';
import { buildFireCases } from '../src/fires/spreadModel';
import type { FiresResponse } from '../shared/fires';
import type { FireLayer, FireLayerState } from '../src/fires/fireLayer';

function data(at = 7200): FiresResponse {
  return { provenance:'replay', scenario:'test', fetchedAt:'2026-07-09T02:00:00Z',
    asOf:new Date(Date.parse('2026-07-09T00:00:00Z')+at*1000).toISOString(),
    timeline:{ scenario:'test', start:'2026-07-09T00:00:00Z', end:'2026-07-09T02:00:00Z', durationSeconds:7200, frames:[] },
    hotspots:[], spread:[],
    clusters:[{id:'fire',name:'Test fire',centroid:{lat:37,lon:-2},hotspotIds:[],bbox:[-2,37,-1,38],totalFrpMw:null,firstDetectedAt:null,lastDetectedAt:null}],
    perimeters:[{clusterId:'fire',observedAt:'2026-07-09T00:00:00Z',areaKm2:1,partIndex:0,partCount:1,polygon:[{lat:37,lon:-2},{lat:38,lon:-2},{lat:38,lon:-1},{lat:37,lon:-2}]}] };
}

test('real DOM controls seek, play, pause, show the committed date and handle boundaries', async t => {
  t.mock.timers.enable({ apis:['setTimeout'] });
  const dom = new JSDOM('<main></main>');
  Object.defineProperty(globalThis, 'document', {value:dom.window.document, configurable:true});
  t.after(() => { delete (globalThis as {document?: Document}).document; });
  const root = dom.window.document.querySelector('main')!;
  const playback = new FirePlayback(async at => data(at));
  t.after(() => { playback.dispose(); dom.window.close(); });
  initReplayPanel(playback, root);
  await playback.start();
  const button = (action: string) => root.querySelector<HTMLButtonElement>(`[data-action="${action}"]`)!;
  const settle = async () => { await Promise.resolve(); await Promise.resolve(); };
  assert.equal(button('forward').disabled, true);
  button('back').click(); await settle();
  assert.equal(replayPosition(playback.getState().data), 3600);
  assert.match(root.querySelector('.replay-time')!.textContent!, /2026-07-09 01:00:00 UTC/);
  button('start').click(); await settle();
  assert.equal(button('back').disabled, true);
  button('play').click(); await settle();
  assert.equal(button('play').textContent, 'PAUSE');
  button('play').click(); await settle();
  const paused = replayPosition(playback.getState().data);
  t.mock.timers.tick(5000); await settle();
  assert.equal(replayPosition(playback.getState().data), paused);
  const slider = root.querySelector<HTMLInputElement>('input')!;
  slider.value = '5100'; slider.dispatchEvent(new dom.window.Event('input')); await settle();
  assert.equal(replayPosition(playback.getState().data), 5100);
  button('back').click(); await settle();
  assert.equal(replayPosition(playback.getState().data), 1500);
  button('forward').click(); await settle();
  assert.equal(replayPosition(playback.getState().data), 5100);
  button('forward').click(); await settle();
  assert.equal(replayPosition(playback.getState().data), 7200);
  button('end').click(); await settle();
  assert.equal(button('play').textContent, 'REPLAY');
  assert.equal(button('end').disabled, true);
});

test('no forecasts disables all forecast controls and shows the reason; new forecasts for the same id update the horizon', t => {
  const dom = new JSDOM('<main></main>');
  Object.defineProperty(globalThis, 'document', {value:dom.window.document, configurable:true});
  t.after(() => { delete (globalThis as {document?: Document}).document; });
  t.after(() => dom.window.close());
  const root = dom.window.document.querySelector('main')!;
  let render!: (state: FireLayerState) => void;
  let plays = 0;
  const layer = { onStateChange: (listener: typeof render) => { render=listener; },
    setPlaying: () => ++plays, setScrub: () => {}, select: () => {}, deselect: () => {} } as unknown as FireLayer;
  initFirePanels(layer, root);
  const cases = buildFireCases(data());
  render({cases,selectedId:'fire',selectedCase:cases[0],scrubHours:0,playing:false,projection:null});
  for (const control of root.querySelectorAll<HTMLButtonElement|HTMLInputElement>('.hud-scrubber-controls button, input')) {
    assert.equal(control.disabled,true);
  }
  const play = root.querySelector<HTMLButtonElement>('[aria-label="Play spread forecast"]')!;
  play.click(); assert.equal(plays,0);
  assert.match(root.textContent!, /No spread forecast available/);
  const response=data();
  response.spread=[{clusterId:'fire',at:'2026-07-09T02:00:00Z',horizonHours:2,polygon:response.perimeters[0].polygon}];
  const next=buildFireCases(response);
  render({cases:next,selectedId:'fire',selectedCase:next[0],scrubHours:0,playing:false,projection:null});
  assert.equal(root.querySelector<HTMLInputElement>('input')!.max,'2');
  assert.equal(play.disabled,false);
  play.click(); assert.equal(plays,1);
});


test('cached-page suspension preserves controls and subscriptions after browser return', async t => {
  const dom=new JSDOM('<main></main>');
  Object.defineProperty(globalThis,'document',{value:dom.window.document,configurable:true});
  const playback=new FirePlayback(async at=>data(at));
  const unbind=bindPlaybackLifecycle(playback,dom.window as unknown as Window);
  t.after(()=>{unbind();playback.dispose();delete (globalThis as {document?:Document}).document;dom.window.close();});
  const root=dom.window.document.querySelector('main')!;
  initReplayPanel(playback,root);await playback.start();await playback.play();
  dom.window.dispatchEvent(new dom.window.PageTransitionEvent('pagehide',{persisted:true}));
  assert.equal(playback.getState().playing,false);
  dom.window.dispatchEvent(new dom.window.PageTransitionEvent('pageshow',{persisted:true}));
  await playback.seek(3600);
  assert.equal(replayPosition(playback.getState().data),3600);
  assert.match(root.querySelector('.replay-time')!.textContent!,/01:00:00 UTC/);
  await playback.play();assert.equal(playback.getState().playing,true);
  dom.window.dispatchEvent(new dom.window.PageTransitionEvent('pagehide',{persisted:true}));
  assert.equal(playback.getState().playing,false,'suspension must work on subsequent visits too');
  dom.window.dispatchEvent(new dom.window.PageTransitionEvent('pagehide',{persisted:false}));
  const last=playback.getState().data;
  await playback.seek(0);assert.equal(playback.getState().data,last,'terminal departure still disposes');
});


test('cached-page return restarts initial loading and live refresh without resetting replay time', async t => {
  t.mock.timers.enable({apis:['setTimeout']});
  const dom=new JSDOM();
  let calls=0;let finish!:(value:FiresResponse)=>void;
  const live={...data(),provenance:'live' as const};
  const playback=new FirePlayback(async()=>{calls++;return calls===1?new Promise(resolve=>{finish=resolve;}):live;});
  const unbind=bindPlaybackLifecycle(playback,dom.window as unknown as Window);
  t.after(()=>{unbind();playback.dispose();dom.window.close();});
  const pending=playback.start();
  dom.window.dispatchEvent(new dom.window.PageTransitionEvent('pagehide',{persisted:true}));
  dom.window.dispatchEvent(new dom.window.PageTransitionEvent('pageshow',{persisted:true}));
  await Promise.resolve();await Promise.resolve();
  assert.equal(calls,2);assert.equal(playback.getState().data?.provenance,'live');
  finish(data());await pending;assert.equal(playback.getState().data?.provenance,'live');
  dom.window.dispatchEvent(new dom.window.PageTransitionEvent('pagehide',{persisted:true}));
  dom.window.dispatchEvent(new dom.window.PageTransitionEvent('pageshow',{persisted:true}));
  await Promise.resolve();await Promise.resolve();assert.equal(calls,3);
  t.mock.timers.tick(600000);await Promise.resolve();await Promise.resolve();assert.equal(calls,4);
});

test('initial fire failure has an alert, and later failure accurately describes retained data', async t => {
  const dom=new JSDOM('<main></main>');
  Object.defineProperty(globalThis,'document',{value:dom.window.document,configurable:true});
  let fail=true;
  const playback=new FirePlayback(async at=>{if(fail)throw new Error('offline');return data(at);});
  t.after(()=>{playback.dispose();delete (globalThis as {document?:Document}).document;dom.window.close();});
  const root=dom.window.document.querySelector('main')!;
  initReplayPanel(playback,root);await playback.start();
  const alert=root.querySelector<HTMLElement>('[role="alert"]')!;
  const status=root.querySelector('.replay-status')!;
  const retry=root.querySelector<HTMLButtonElement>('.replay-retry')!;
  assert.equal(alert.hidden,false);assert.match(alert.textContent!,/FIRE DATA UNAVAILABLE/);
  assert.match(status.textContent!,/No fire data has been loaded/);
  assert.doesNotMatch(status.textContent!,/last loaded time/);
  assert.equal(retry.hidden,false);
  fail=false;retry.click();await new Promise(resolve=>setImmediate(resolve));
  assert.equal(alert.hidden,true);assert.equal(retry.hidden,true);
  fail=true;await playback.seek(0);
  assert.equal(alert.hidden,true);assert.equal(retry.hidden,false);
  assert.match(status.textContent!,/last loaded time/);
});


test('cached-page restoration follows latest intent through a replay fallback', async t => {
  t.mock.timers.enable({apis:['setTimeout']});
  const dom=new JSDOM();let calls=0;
  const playback=new FirePlayback(async()=>({...data(),provenance:++calls===2?'replay':'live'}));
  const unbind=bindPlaybackLifecycle(playback,dom.window as unknown as Window);
  t.after(()=>{unbind();playback.dispose();dom.window.close();});
  await playback.start();t.mock.timers.tick(600000);await Promise.resolve();await Promise.resolve();
  assert.equal(playback.getState().data?.provenance,'replay');
  dom.window.dispatchEvent(new dom.window.PageTransitionEvent('pagehide',{persisted:true}));
  dom.window.dispatchEvent(new dom.window.PageTransitionEvent('pageshow',{persisted:true}));
  await Promise.resolve();await Promise.resolve();
  assert.equal(calls,3);assert.equal(playback.getState().data?.provenance,'live');
});

test('hotspot-only clusters stay selectable and forecast reset and reframe are independently usable', t => {
  const dom = new JSDOM('<main></main>');
  Object.defineProperty(globalThis,'document',{value:dom.window.document,configurable:true});
  t.after(()=>{delete (globalThis as {document?:Document}).document;dom.window.close();});
  let render!:(state:FireLayerState)=>void;
  let reframes=0; const scrubs:number[]=[];
  const layer={onStateChange:(listener:typeof render)=>{render=listener;},select:()=>{},reframe:()=>{reframes++;},
    deselect:()=>{},setScrub:(value:number)=>scrubs.push(value),setPlaying:()=>{}} as unknown as FireLayer;
  const root=dom.window.document.querySelector('main')!;
  initFirePanels(layer,root);
  const response=data(); const cases=buildFireCases(response);
  const extra={...response.clusters[0],id:'detection',name:'Hotspot cluster'};
  const state:FireLayerState={cases,clusters:[...response.clusters,extra],selectedCase:null,selectedId:'detection',scrubHours:0,playing:false,projection:null};
  render(state);
  assert.match(root.textContent!,/Hotspot clusterHOTSPOTS ONLY/);
  root.querySelector<HTMLButtonElement>('[aria-label="Reframe selected fire"]')!.click();
  assert.equal(reframes,1);
  assert.equal(root.querySelector<HTMLButtonElement>('[aria-label="Play spread forecast"]')!.disabled,true);
  const forecast={...cases[0],maxHorizonHours:8};
  render({...state,cases:[forecast],selectedCase:forecast,selectedId:'fire',scrubHours:3});
  const reset=root.querySelector<HTMLButtonElement>('[aria-label="Reset spread forecast"]')!;
  assert.equal(reset.disabled,false);reset.click();assert.deepEqual(scrubs,[0]);
  assert.match(root.textContent!,/Forecast from .*not recorded observations/);
});
