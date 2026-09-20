import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { FirePlayback, replayPosition } from '../src/data/playback';
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
  render({cases,selectedCase:cases[0],scrubHours:0,playing:false,projection:null});
  for (const control of root.querySelectorAll<HTMLButtonElement|HTMLInputElement>('.hud-scrubber-controls button, input')) {
    assert.equal(control.disabled,true);
  }
  const play = root.querySelector<HTMLButtonElement>('[aria-label="Play spread forecast"]')!;
  play.click(); assert.equal(plays,0);
  assert.match(root.textContent!, /No spread forecast available/);
  const response=data();
  response.spread=[{clusterId:'fire',at:'2026-07-09T02:00:00Z',horizonHours:2,polygon:response.perimeters[0].polygon}];
  const next=buildFireCases(response);
  render({cases:next,selectedCase:next[0],scrubHours:0,playing:false,projection:null});
  assert.equal(root.querySelector<HTMLInputElement>('input')!.max,'2');
  assert.equal(play.disabled,false);
  play.click(); assert.equal(plays,1);
});
