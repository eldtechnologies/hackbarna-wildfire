import 'cesium/Build/Cesium/Widgets/widgets.css';
import './style.css';
import { Cartesian3 } from 'cesium';
import { createGlobeViewer } from './globe/viewer';
import { initHud } from './hud/hud';
import { initFirePanels } from './hud/firePanels';
import { FireLayer } from './fires/fireLayer';
import { createFireLayer } from './layers/fireLayer';
import { InfrastructureLayer } from './layers/infrastructure';
import { FireSelectionLayer } from './layers/fireSelection';
import { fetchFires } from './data/api';
import { FirePlayback } from './data/playback';
import { initReplayPanel } from './hud/replayPanel';
import type { FiresResponse } from '../shared/fires';

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
const hotspotLayer = createFireLayer(viewer, hudRoot);
const playback = new FirePlayback(fetchFires);
initReplayPanel(playback, hudRoot);

const threatPanel = document.createElement('div');
threatPanel.className = 'threat-panel';
hudRoot.appendChild(threatPanel);

new InfrastructureLayer(viewer.scene, (asset) => {
  viewer.camera.flyTo({
    destination: Cartesian3.fromDegrees(
      asset.position.lon,
      asset.position.lat,
      15_000,
    ),
    duration: 1.2,
  });
});

// Selecting a fire's pick marker also selects it in the perimeter layer, so
// the spread ghost and scrubber follow the threat analysis.
const fireSelection = new FireSelectionLayer(viewer, threatPanel, (fireId) => {
  if (fireId) {
    fireLayer.select(fireId, { flyTo: true });
  } else {
    fireLayer.deselect();
  }
});

let rendered: FiresResponse | null = null;
playback.subscribe(({ data }) => {
  if (!data || data === rendered) return;
  rendered = data;
  hud.setMode(data.provenance);
  viewer.entities.suspendEvents();
  try {
    hotspotLayer.setData(data);
    fireLayer.setData(data);
    fireSelection.setData(data);
  } finally {
    viewer.entities.resumeEvents();
  }
});
void playback.start();
window.addEventListener('pagehide', () => playback.dispose(), { once: true });
