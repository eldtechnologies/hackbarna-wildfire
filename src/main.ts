import 'cesium/Build/Cesium/Widgets/widgets.css';
import './style.css';
import { createGlobeViewer } from './globe/viewer';
import { initHud } from './hud/hud';
import { initFirePanels } from './hud/firePanels';
import { FireLayer } from './fires/fireLayer';
import { fetchFires } from './data/api';

const container = document.getElementById('globe');
const hudRoot = document.getElementById('hud');
if (!container || !hudRoot) {
  throw new Error('Missing #globe or #hud root element');
}

const viewer = createGlobeViewer(container);
const hud = initHud(viewer, hudRoot);
const fireLayer = new FireLayer(viewer);
initFirePanels(fireLayer, hudRoot);

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
