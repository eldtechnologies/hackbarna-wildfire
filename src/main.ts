import 'cesium/Build/Cesium/Widgets/widgets.css';
import './style.css';
import { createGlobeViewer } from './globe/viewer';
import { initHud } from './hud/hud';
import { initFirePanels } from './hud/firePanels';
import { FireLayer } from './fires/fireLayer';
import { fetchFires } from './data/api';

const globeEl = document.getElementById('globe');
const hudEl = document.getElementById('hud');
if (!globeEl || !hudEl) {
  throw new Error('Missing #globe or #hud root element');
}
const container = globeEl;
const hudRoot = hudEl;

const viewer = createGlobeViewer(container);
const hud = initHud(viewer, hudRoot);
const fireLayer = new FireLayer(viewer);
initFirePanels(fireLayer, hudRoot);

async function loadFires(): Promise<void> {
  try {
    const response = await fetchFires();
    hud.setMode(response.provenance);
    fireLayer.setData(response);
  } catch (err) {
    const banner = document.createElement('div');
    banner.className = 'hud-error';
    banner.textContent = 'FIRE DATA UNAVAILABLE';
    hudRoot.appendChild(banner);
    throw err;
  }
}

void loadFires();
