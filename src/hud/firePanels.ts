// Fire panels: the FIRES list (select a fire) and the spread scrubber
// (valid time, T+ offset, projection area, play/pause, step buttons).
// Pure DOM, driven by FireLayer.onStateChange. The scrubber updates its
// existing nodes in place instead of rebuilding, so dragging the slider is
// never interrupted by a state notification.

import { clusterDisplayName } from '../fires/display';
import type { FireLayer, FireLayerState } from '../fires/fireLayer';
import { driftLabel, SCRUB_SNAP } from '../fires/fireLayer';

function el(tag: string, className = '', text = ''): HTMLElement {
  const node = document.createElement(tag);
  node.className = className;
  if (text) node.textContent = text;
  return node;
}

function formatClock(iso: string): string {
  return iso.slice(11, 16) + 'Z';
}

export function initFirePanels(layer: FireLayer, hudRoot: HTMLElement): HTMLElement {
  const panels = el('div', 'hud-fire-panels');
  hudRoot.appendChild(panels);
  const listPanel = el('div', 'hud-panel hud-fires');
  panels.appendChild(listPanel);

  const scrubPanel = el('div', 'hud-panel hud-scrubber');
  scrubPanel.hidden = true;

  const titleRow = el('div', 'hud-scrubber-head');
  const scrubName = el('span', 'hud-scrubber-name');
  const close = el('button', 'hud-scrubber-close', 'CLOSE');
  close.addEventListener('click', () => layer.deselect());
  titleRow.appendChild(scrubName);
  titleRow.appendChild(close);

  const timeRow = el('div', 'hud-scrubber-time');
  const tPlus = el('span', 'hud-scrubber-tplus');
  const valid = el('span', 'hud-scrubber-valid');
  timeRow.appendChild(tPlus);
  timeRow.appendChild(valid);

  const controlsRow = el('div', 'hud-scrubber-controls');
  const stepBack = el('button', 'hud-btn', '-1H');
  const play = el('button', 'hud-btn', 'PLAY');
  const stepFwd = el('button', 'hud-btn', '+1H');
  stepBack.addEventListener('click', () => layer.setScrub(stateRef.scrubHours - 1));
  stepFwd.addEventListener('click', () => layer.setScrub(stateRef.scrubHours + 1));
  play.addEventListener('click', () => layer.setPlaying(!stateRef.playing));
  controlsRow.appendChild(stepBack);
  controlsRow.appendChild(play);
  controlsRow.appendChild(stepFwd);

  const sliderRow = el('div', 'hud-scrubber-slider');
  const slider = document.createElement('input');
  slider.type = 'range';
  slider.min = '0';
  slider.step = String(SCRUB_SNAP);
  slider.addEventListener('input', () => layer.setScrub(Number(slider.value)));
  sliderRow.appendChild(slider);

  const tickRow = el('div', 'hud-scrubber-ticks');
  const statsRow = el('div', 'hud-scrubber-stats');
  const areaStat = el('span');
  const driftStat = el('span');
  statsRow.appendChild(areaStat);
  statsRow.appendChild(driftStat);

  scrubPanel.append(titleRow, timeRow, controlsRow, sliderRow, tickRow, statsRow);
  panels.appendChild(scrubPanel);

  // Latest state, read by the step buttons. Kept current by render().
  const stateRef: FireLayerState = {
    cases: [],
    selectedCase: null,
    selectedId: null,
    scrubHours: 0,
    playing: false,
    projection: null,
  };

  // Rebuilding the list every notification would churn DOM ~60x/s during
  // playback, so it only re-renders when the cases or the selection change.
  let lastCases: FireLayerState['cases'] | null = null;
  let lastSelectedId: string | null = null;

  const renderList = (state: FireLayerState) => {
    const selectedId = state.selectedCase?.cluster.id ?? null;
    if (state.cases === lastCases && selectedId === lastSelectedId) return;
    lastCases = state.cases;
    lastSelectedId = selectedId;
    listPanel.replaceChildren(el('div', 'hud-panel-title', 'FIRES'));
    if (state.cases.length === 0) {
      listPanel.appendChild(el('div', 'hud-fires-empty', 'NO ACTIVE PERIMETERS'));
      return;
    }
    for (const caseData of state.cases) {
      const row = el('div', 'hud-fire-row');
      row.classList.toggle(
        'hud-fire-row-selected',
        caseData.cluster.id === state.selectedCase?.cluster.id,
      );
      const name = el('span', 'hud-fire-name', clusterDisplayName(caseData.cluster));
      const meta = el('span', 'hud-fire-meta', `${caseData.areaKm2.toFixed(1)} KM2`);
      row.appendChild(name);
      row.appendChild(meta);
      row.addEventListener('click', () => layer.select(caseData.cluster.id, { flyTo: true }));
      listPanel.appendChild(row);
    }
  };

  const renderScrubber = (state: FireLayerState) => {
    const selected = state.selectedCase;
    if (!selected) {
      scrubPanel.hidden = true;
      return;
    }
    scrubPanel.hidden = false;

    scrubName.textContent = clusterDisplayName(selected.cluster);
    tPlus.textContent = `T${state.scrubHours > 0 ? `+${state.scrubHours.toFixed(1)}H` : 'NOW'}`;
    valid.textContent = state.projection
      ? `VALID ${formatClock(state.projection.validAt)}`
      : '';
    play.textContent = state.playing ? 'PAUSE' : 'PLAY';

    const max = selected.maxHorizonHours;
    if (ticksForId !== selected.cluster.id) {
      // Rebuild the horizon ticks only when the selected fire changes.
      ticksForId = selected.cluster.id;
      slider.max = String(max);
      slider.disabled = max === 0;
      tickRow.replaceChildren();
      for (const step of selected.steps) {
        const pct = max > 0 ? (step.horizonHours / max) * 100 : 0;
        const tick = el('span', 'hud-scrubber-tick', `+${step.horizonHours}H`);
        tick.style.left = `${pct}%`;
        tickRow.appendChild(tick);
      }
    }
    if (!dragging) slider.value = String(state.scrubHours);

    areaStat.textContent = `AREA ${(state.projection?.areaKm2 ?? 0).toFixed(1)} KM2`;
    const drift = driftLabel(selected);
    driftStat.textContent = drift ? `DRIFT ${drift}` : '';
  };

  // Which cluster the horizon ticks were built for.
  let ticksForId: string | null = null;

  // While the user drags the slider, its own position wins over state pushes.
  let dragging = false;
  slider.addEventListener('pointerdown', () => {
    dragging = true;
  });
  const stopDrag = () => {
    dragging = false;
  };
  slider.addEventListener('pointerup', stopDrag);
  slider.addEventListener('pointercancel', stopDrag);

  layer.onStateChange((state) => {
    Object.assign(stateRef, state);
    renderList(state);
    renderScrubber(state);
  });
  return panels;
}
