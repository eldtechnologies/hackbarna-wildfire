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
initFirePanels(fireLayer, hudRoot);
// Hotspot + cluster controller. Polls /api/fires on its own cadence and
// drives the provenance badge.
createFireLayer(viewer, hudRoot, hud.setMode);

const threatPanel = document.createElement('div');
threatPanel.className = 'threat-panel';
hudRoot.appendChild(threatPanel);

const agentRoot = document.createElement('div');
agentRoot.className = 'agent-panel';
hudRoot.appendChild(agentRoot);
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

let evidence: FiresResponse | null=null;
fireLayer.onStateChange(({selectedId})=>{
  const at=evidence?.provenance==='replay' && evidence.timeline && evidence.asOf
    ? Math.ceil((Date.parse(evidence.asOf)-Date.parse(evidence.timeline.start))/1000) : undefined;
  const key=evidence?.asOf??evidence?.fetchedAt??'latest';
  fireSelection.track(selectedId,at,key);
  agentPanel.track(selectedId,at,key);
});

async function loadFires(): Promise<void> {
  try {
    const response = await fetchFires();
    hud.setMode(response.provenance);
    evidence=response;
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
