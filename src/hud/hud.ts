import {
  Cartographic,
  Math as CesiumMath,
  PerspectiveFrustum,
  ScreenSpaceEventHandler,
  ScreenSpaceEventType,
  Viewer,
} from 'cesium';
import { LAYERS, LAYER_COLORS, isLayerVisible, setLayerVisible } from '../layers/registry';
import { setSensorLook } from '../globe/sensorLook';

// HUD shell: corner brackets, title, UTC clock, telemetry, layer toggles,
// sensor-look toggle. Pure DOM overlay on top of the Cesium canvas.

export interface HudHandle {
  /** Update the LIVE/REPLAY badge from the API response provenance. */
  setMode: (mode: 'live' | 'replay') => void;
  /** Update the DATA line from the API response (timestamp, scenario). */
  setData: (data: { fetchedAt: string; scenario: string | null }) => void;
}

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

export function initHud(viewer: Viewer, root: HTMLElement): HudHandle {
  for (const corner of ['tl', 'tr', 'bl', 'br']) {
    root.appendChild(el('div', `bracket bracket-${corner}`));
  }

  const header = el('header', 'hud-header');
  const title = el('div', 'hud-title');
  title.appendChild(el('span', 'hud-title-main', 'OJO DE FUEGO'));
  title.appendChild(el('span', 'hud-title-sub', 'WILDFIRE INTELLIGENCE / IBERIA'));
  const status = el('div', 'hud-status');
  const modeBadge = el('span', 'hud-badge', '---');
  const clock = el('span', 'hud-clock');
  const sensorBtn = el('button', 'hud-sensor-btn', 'SENSOR') as HTMLButtonElement;
  sensorBtn.type = 'button';
  sensorBtn.setAttribute('aria-pressed', 'false');
  sensorBtn.addEventListener('click', () => {
    const next = !sensorBtn.classList.contains('on');
    setSensorLook(viewer, next);
    sensorBtn.classList.toggle('on', next);
    sensorBtn.setAttribute('aria-pressed', String(next));
    // Dims the HUD chrome and hands scanlines to the post-process pass.
    root.classList.toggle('sensor-active', next);
  });
  status.appendChild(modeBadge);
  status.appendChild(clock);
  status.appendChild(sensorBtn);
  header.appendChild(title);
  header.appendChild(status);
  root.appendChild(header);

  const telemetry = el('div', 'hud-telemetry');
  const cursorLine = el('div', '', 'CUR -------- / --------');
  const heightLine = el('div', '', 'ALT ---- KM');
  const resLine = el('div', '', 'RES ---- M/PX');
  const dataLine = el('div', '', 'DATA ---');
  telemetry.appendChild(cursorLine);
  telemetry.appendChild(heightLine);
  telemetry.appendChild(resLine);
  telemetry.appendChild(dataLine);
  root.appendChild(telemetry);

  const layersPanel = el('div', 'hud-panel hud-layers');
  layersPanel.appendChild(el('div', 'hud-panel-title', 'LAYERS'));
  for (const layer of LAYERS) {
    const row = el('label', 'hud-layer-row');
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = isLayerVisible(layer.id);
    box.addEventListener('change', () =>
      setLayerVisible(layer.id, box.checked),
    );
    row.appendChild(box);
    const color = LAYER_COLORS[layer.id];
    if (color) {
      const swatch = el('span', 'hud-swatch');
      swatch.style.backgroundColor = color;
      row.appendChild(swatch);
    } else {
      // Placeholder keeps labels aligned in one column for layers without a
      // color (hotspots, clusters, perimeters, spread sim).
      row.appendChild(el('span', 'hud-swatch hud-swatch-empty'));
    }
    row.appendChild(el('span', '', layer.label));
    layersPanel.appendChild(row);
  }
  root.appendChild(layersPanel);

  const tick = () => {
    clock.textContent = `${new Date().toISOString().slice(11, 19)} UTC`;
    const heightKm = viewer.camera.positionCartographic.height / 1000;
    heightLine.textContent = `ALT ${heightKm.toFixed(0).padStart(4, '0')} KM`;

    // Ground resolution at nadir: full vertical FOV spans the canvas height.
    // Perspective only; the orthographic frustum has no meaningful M/PX here.
    const frustum = viewer.camera.frustum;
    const canvas = viewer.scene.canvas;
    if (
      frustum instanceof PerspectiveFrustum &&
      canvas.clientHeight > 0 &&
      frustum.fovy != null &&
      Number.isFinite(frustum.fovy)
    ) {
      const metersPerPx =
        (2 * Math.tan(frustum.fovy / 2) * viewer.camera.positionCartographic.height) /
        canvas.clientHeight;
      resLine.textContent =
        metersPerPx >= 1
          ? `RES ${metersPerPx.toFixed(0).padStart(4, '0')} M/PX`
          : `RES ${metersPerPx.toFixed(1)} M/PX`;
    } else {
      resLine.textContent = 'RES ---- M/PX';
    }
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

  // Formatted DATA timestamp: YYYY-MM-DD HH:MM Z, or dashes before the first
  // fetch lands.
  const formatDataStamp = (iso: string): string => {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    const p = (n: number) => String(n).padStart(2, '0');
    return (
      `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}` +
      ` ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}Z`
    );
  };

  return {
    setMode(mode) {
      modeBadge.textContent = mode.toUpperCase();
      // Live gets the cyan accent; replay keeps the default amber.
      modeBadge.classList.toggle('hud-badge-live', mode === 'live');
    },
    setData({ fetchedAt, scenario }) {
      const stamp = formatDataStamp(fetchedAt);
      dataLine.textContent = scenario
        ? `DATA ${stamp} / REPLAY ${scenario.toUpperCase()}`
        : `DATA ${stamp}`;
    },
  };
}
