import type { FireSource } from '../../shared/fires';
import type { FirePlayback } from '../data/playback';

export function initSourcePanel(playback: FirePlayback, root: HTMLElement): HTMLElement {
  const panel = document.createElement('section');
  panel.className = 'hud-source';
  panel.setAttribute('aria-label', 'Data and view controls');
  panel.innerHTML = `<div class="console-controls">
    <label class="source-label">SOURCE <select aria-label="Fire data source">
      <option value="live">Live satellite observations</option>
      <option value="replay">Recorded fire · Los Gallardos</option>
    </select></label>
  </div><div class="source-status" role="status"></div>`;
  root.appendChild(panel);
  const select = panel.querySelector('select')!;
  const status = panel.querySelector<HTMLElement>('.source-status')!;
  select.onchange = () => { void playback.selectSource(select.value as FireSource); };
  playback.subscribe(({data, source, loading, error}) => {
    const selected = source ?? data?.requestedSource ?? data?.source;
    if (selected === 'configured' && !select.querySelector('[value="configured"]')) {
      const option = document.createElement('option');
      option.value = 'configured'; option.textContent = 'Configured recording'; select.appendChild(option);
    }
    if (selected) select.value = selected;
    const description = !data ? 'No observations loaded'
      : data.fallbackReason ? 'LIVE UNAVAILABLE · showing cached real observations'
      : data.provenance === 'live' ? 'LIVE · satellite observations · no spread forecast supplied'
      : 'REPLAY · recorded satellite observations';
    status.textContent = loading ? `Loading source… ${description}`
      : error ? `Source unavailable. ${description} · retry below` : description;
    panel.setAttribute('aria-busy', String(loading));
  });
  const controls = panel.querySelector<HTMLElement>('.console-controls')!;
  const panels = document.createElement('button');
  panels.className = 'hud-btn'; panels.textContent = 'PANELS: ON';
  panels.setAttribute('aria-label', 'Hide inspectors');
  panels.setAttribute('aria-pressed', 'true');
  panels.onclick = () => {
    const hidden = root.classList.toggle('inspectors-hidden');
    panels.textContent = hidden ? 'PANELS: OFF' : 'PANELS: ON';
    panels.setAttribute('aria-label', hidden ? 'Show inspectors' : 'Hide inspectors');
    panels.setAttribute('aria-pressed', String(!hidden));
  };
  controls.appendChild(panels);
  return controls;
}
