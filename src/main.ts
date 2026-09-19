import 'cesium/Build/Cesium/Widgets/widgets.css';
import './style.css';
import { createGlobeViewer } from './globe/viewer';
import { initHud } from './hud/hud';
import { createFireLayer } from './layers/fireLayer';

const container = document.getElementById('globe');
const hudRoot = document.getElementById('hud');
if (!container || !hudRoot) {
  throw new Error('Missing #globe or #hud root element');
}

const viewer = createGlobeViewer(container);
const hud = initHud(viewer, hudRoot);
createFireLayer(viewer, hudRoot, hud.setModeBadge);
