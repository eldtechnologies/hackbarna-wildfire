import 'cesium/Build/Cesium/Widgets/widgets.css';
import './style.css';
import { createGlobeViewer } from './globe/viewer';
import { initHud } from './hud/hud';

const container = document.getElementById('globe');
const hudRoot = document.getElementById('hud');
if (!container || !hudRoot) {
  throw new Error('Missing #globe or #hud root element');
}

const viewer = createGlobeViewer(container);
initHud(viewer, hudRoot);
