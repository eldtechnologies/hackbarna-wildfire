// Hotspot metadata panel: slide-in card shown when a hotspot is selected.
// Displays detection time, confidence, and source satellite for the selected
// hotspot, plus fire radiative power, position, and cluster context.

import { clusterDisplayName } from '../fires/display';
import type { FireCluster, Hotspot } from '../../shared/fires';

export interface HotspotPanel {
  show(hotspot: Hotspot, cluster: FireCluster | null): void;
  hide(): void;
}

function confidenceLabel(confidence: number): string {
  if (confidence >= 0.8) return 'HIGH';
  if (confidence >= 0.5) return 'NOMINAL';
  return 'LOW';
}

function formatUtc(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const p = (n: number) => String(n).padStart(2, '0');
  return (
    `${date.getUTCFullYear()}-${p(date.getUTCMonth() + 1)}-${p(date.getUTCDate())}` +
    ` ${p(date.getUTCHours())}:${p(date.getUTCMinutes())} UTC`
  );
}

export function createHotspotPanel(
  root: HTMLElement,
  onClose: () => void,
): HotspotPanel {
  const panel = document.createElement('div');
  panel.className = 'hotspot-panel';

  const titleBar = document.createElement('div');
  titleBar.className = 'hotspot-panel-title';
  const title = document.createElement('span');
  title.textContent = 'HOTSPOT';
  const close = document.createElement('button');
  close.className = 'hotspot-panel-close';
  close.textContent = 'x';
  close.setAttribute('aria-label', 'Close hotspot panel');
  close.addEventListener('click', onClose);
  titleBar.appendChild(title);
  titleBar.appendChild(close);

  const body = document.createElement('div');
  body.className = 'hotspot-panel-body';

  panel.appendChild(titleBar);
  panel.appendChild(body);
  root.appendChild(panel);

  function row(label: string, value: string): HTMLElement {
    const r = document.createElement('div');
    r.className = 'hotspot-panel-row';
    const l = document.createElement('span');
    l.className = 'hotspot-panel-label';
    l.textContent = label;
    const v = document.createElement('span');
    v.className = 'hotspot-panel-value';
    v.textContent = value;
    r.appendChild(l);
    r.appendChild(v);
    return r;
  }

  function show(hotspot: Hotspot, cluster: FireCluster | null): void {
    title.textContent = `HOTSPOT ${hotspot.id}`;
    const lat = `${Math.abs(hotspot.position.lat).toFixed(4)} ${hotspot.position.lat >= 0 ? 'N' : 'S'}`;
    const lon = `${Math.abs(hotspot.position.lon).toFixed(4)} ${hotspot.position.lon >= 0 ? 'E' : 'W'}`;
    body.replaceChildren(
      row('DETECTED', hotspot.detectedAt ? formatUtc(hotspot.detectedAt) : 'UNKNOWN'),
      row(
        'CONFIDENCE',
        hotspot.confidence != null
          ? `${Math.round(hotspot.confidence * 100)}% ${confidenceLabel(hotspot.confidence)}`
          : 'UNKNOWN',
      ),
      row('SATELLITE', hotspot.satellite ?? 'UNKNOWN'),
      row('FRP', hotspot.frpMw != null ? `${hotspot.frpMw.toFixed(1)} MW` : 'UNMEASURED'),
      row('POSITION', `${lat} / ${lon}`),
      row('CLUSTER', cluster ? (clusterDisplayName(cluster)) : 'UNCLUSTERED'),
    );
    panel.classList.add('open');
  }

  function hide(): void {
    panel.classList.remove('open');
  }

  return { show, hide };
}
