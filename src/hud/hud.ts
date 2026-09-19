import {
  Cartographic,
  Math as CesiumMath,
  ScreenSpaceEventHandler,
  ScreenSpaceEventType,
  Viewer,
} from 'cesium';
import { LAYERS, isLayerVisible, setLayerVisible } from '../layers/registry';

// HUD shell: corner brackets, title, UTC clock, telemetry, layer toggles.
// Pure DOM overlay on top of the Cesium canvas.

function el(tag: string, className = '', text = ''): HTMLElement {
  const node = document.createElement(tag);
  node.className = className;
  if (text) node.textContent = text;
  return node;
}

function formatCoordinate(deg: number, pos: string, neg: string): string {
  const hemi = deg >= 0 ? pos : neg;
  return `${Math.abs(deg).toFixed(4).padStart(7, '0')} ${hemi}`;
}

export function initHud(viewer: Viewer, root: HTMLElement): { setModeBadge: (provenance: 'live' | 'replay') => void } {
  for (const corner of ['tl', 'tr', 'bl', 'br']) {
    root.appendChild(el('div', `bracket bracket-${corner}`));
  }

  const header = el('header', 'hud-header');
  const title = el('div', 'hud-title');
  title.appendChild(el('span', 'hud-title-main', 'OJO DE FUEGO'));
  title.appendChild(el('span', 'hud-title-sub', 'WILDFIRE INTELLIGENCE / IBERIA'));
  const status = el('div', 'hud-status');
  const modeBadge = el('span', 'hud-badge hud-badge-replay', 'REPLAY');
  const clock = el('span', 'hud-clock');
  status.appendChild(modeBadge);
  status.appendChild(clock);
  header.appendChild(title);
  header.appendChild(status);
  root.appendChild(header);

  // Provenance comes from the fire layer controller once the first fetch
  // resolves. Until then the badge stays in its neutral "connecting" look.
  const setModeBadge = (provenance: 'live' | 'replay') => {
    modeBadge.textContent = provenance.toUpperCase();
    modeBadge.classList.toggle('hud-badge-live', provenance === 'live');
    modeBadge.classList.toggle('hud-badge-replay', provenance === 'replay');
  };

  const telemetry = el('div', 'hud-telemetry');
  const cursorLine = el('div', '', 'CUR -------- / --------');
  const heightLine = el('div', '', 'ALT ---- KM');
  telemetry.appendChild(cursorLine);
  telemetry.appendChild(heightLine);
  root.appendChild(telemetry);

  const layersPanel = el('div', 'hud-layers');
  layersPanel.appendChild(el('div', 'hud-layers-title', 'LAYERS'));
  for (const layer of LAYERS) {
    const row = el('label', 'hud-layer-row');
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = isLayerVisible(layer.id);
    box.addEventListener('change', () =>
      setLayerVisible(layer.id, box.checked),
    );
    row.appendChild(box);
    row.appendChild(el('span', '', layer.label));
    layersPanel.appendChild(row);
  }
  root.appendChild(layersPanel);

  const tick = () => {
    clock.textContent = `${new Date().toISOString().slice(11, 19)} UTC`;
    const heightKm = viewer.camera.positionCartographic.height / 1000;
    heightLine.textContent = `ALT ${heightKm.toFixed(0).padStart(4, '0')} KM`;
  };
  tick();
  setInterval(tick, 1000);

  const handler = new ScreenSpaceEventHandler(viewer.scene.canvas);
  handler.setInputAction((event: ScreenSpaceEventHandler.MotionEvent) => {
    const cartesian = viewer.camera.pickEllipsoid(
      event.endPosition,
      viewer.scene.globe.ellipsoid,
    );
    if (!cartesian) {
      cursorLine.textContent = 'CUR -------- / --------';
      return;
    }
    const carto = Cartographic.fromCartesian(cartesian);
    const lat = formatCoordinate(CesiumMath.toDegrees(carto.latitude), 'N', 'S');
    const lon = formatCoordinate(CesiumMath.toDegrees(carto.longitude), 'E', 'W');
    cursorLine.textContent = `CUR ${lat} / ${lon}`;
  }, ScreenSpaceEventType.MOUSE_MOVE);

  return { setModeBadge };
}
