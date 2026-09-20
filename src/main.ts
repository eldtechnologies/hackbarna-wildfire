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
import { AgentPanel } from './hud/agentPanel';
import { fetchFires } from './data/api';
import { FirePlayback, replayPosition, replayTimeline, bindPlaybackLifecycle } from './data/playback';
import { initReplayPanel } from './hud/replayPanel';
import type {FiresResponse} from '../shared/fires';

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
const firePanels = initFirePanels(fireLayer, hudRoot);
const hotspotLayer = createFireLayer(viewer, firePanels);
const playback = new FirePlayback(fetchFires);
initReplayPanel(playback, hudRoot);

const threatPanel = document.createElement('div');
threatPanel.className = 'threat-panel';
firePanels.appendChild(threatPanel);

const agentRoot = document.createElement('div');
agentRoot.className = 'agent-panel';
hud.sidePanels.appendChild(agentRoot);
const agentPanel = new AgentPanel(agentRoot);

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
const fireSelection=new FireSelectionLayer(viewer, threatPanel, (fireId) => {
  if (fireId) {
    fireLayer.select(fireId, { flyTo: true });
  } else {
    fireLayer.deselect();
  }
});

let evidence: FiresResponse | null = null;
fireLayer.onStateChange(({selectedId}) => {
  const at = replayTimeline(evidence) ? replayPosition(evidence) : undefined;
  const key = evidence?.asOf ?? evidence?.fetchedAt ?? 'latest';
  fireSelection.track(selectedId, at, key);
  agentPanel.track(selectedId, at, key);
});

playback.subscribe(({data}) => {
  if (!data || data === evidence) return;
  evidence = data;
  hud.setMode(data.provenance);
  viewer.entities.suspendEvents();
  try {
    hotspotLayer.setData(data);
    fireSelection.setData(data);
    fireLayer.setData(data);
  } finally {
    viewer.entities.resumeEvents();
  }
});
void playback.start();
bindPlaybackLifecycle(playback, window);
