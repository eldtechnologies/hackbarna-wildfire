import 'cesium/Build/Cesium/Widgets/widgets.css';
import './style.css';
import { createGlobeViewer } from './globe/viewer';
import { initHud } from './hud/hud';
import { InfrastructureLayer } from './layers/infrastructure';
import { FireSelectionLayer } from './layers/fireSelection';

const container = document.getElementById('globe');
const hudRoot = document.getElementById('hud');
if (!container || !hudRoot) {
  throw new Error('Missing #globe or #hud root element');
}

const viewer = createGlobeViewer(container);
initHud(viewer, hudRoot);

const threatPanel = document.createElement('div');
threatPanel.className = 'threat-panel';
hudRoot.appendChild(threatPanel);

const infra = new InfrastructureLayer(viewer.scene, (asset) => {
  // Asset click feedback UI belongs to the fire/agent panels card.
  console.log('[infrastructure] asset clicked:', asset.id, asset.name);
});
void infra;

new FireSelectionLayer(viewer, threatPanel, (fireId) => {
  // Reserved for camera tracking, owned by the fire-layer cards.
  if (fireId) console.log('[fire-selection] selected fire:', fireId);
});
