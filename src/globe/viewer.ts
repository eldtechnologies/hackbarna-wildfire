import {
  Cartesian3,
  Color,
  GridImageryProvider,
  ImageryLayer,
  UrlTemplateImageryProvider,
  Viewer,
} from 'cesium';

const ESRI_WORLD_IMAGERY =
  'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
const IBERIA_CENTER = { lon: -3.7, lat: 40.2, heightMeters: 1_600_000 };

export function createGlobeViewer(container: HTMLElement): Viewer {
  // The local grid is always underneath imagery, including while tiles load.
  const viewer = new Viewer(container, {
    baseLayer: new ImageryLayer(new GridImageryProvider({
      color: Color.fromCssColorString('#254454'),
      backgroundColor: Color.fromCssColorString('#12212c'),
      glowColor: Color.TRANSPARENT, cells: 8,
    })),
    animation: false, timeline: false, geocoder: false, homeButton: false,
    sceneModePicker: false, baseLayerPicker: false, navigationHelpButton: false,
    fullscreenButton: false, infoBox: false, selectionIndicator: false,
  });
  viewer.scene.backgroundColor = Color.fromCssColorString('#0a0e12');
  viewer.camera.setView({destination: iberiaDestination()});
  return viewer;
}

function iberiaDestination(): Cartesian3 {
  return Cartesian3.fromDegrees(IBERIA_CENTER.lon, IBERIA_CENTER.lat, IBERIA_CENTER.heightMeters);
}

export function initMapControls(viewer: Viewer, controls: HTMLElement): void {
  const provider = new UrlTemplateImageryProvider({
    url: ESRI_WORLD_IMAGERY, credit: 'Esri, Maxar, Earthstar Geographics',
  });
  const imagery = viewer.imageryLayers.addImageryProvider(provider);
  const map = document.createElement('button');
  map.className = 'hud-btn';
  const mapStatus = document.createElement('span');
  mapStatus.className = 'map-status';
  mapStatus.setAttribute('role', 'status');
  function offline(value: boolean, failed = false) {
    imagery.show = !value;
    map.textContent = value ? 'MAP: OFFLINE GRID' : 'MAP: SATELLITE';
    map.setAttribute('aria-label', value ? 'Use satellite basemap' : 'Use offline basemap');
    mapStatus.textContent = failed ? 'Imagery unavailable · local grid active'
      : value ? 'Local grid · replay works without internet' : '';
  }
  offline(false);
  map.onclick = () => offline(imagery.show);
  provider.errorEvent.addEventListener(() => offline(true, true));

  const sensor = document.createElement('button');
  sensor.className = 'hud-btn'; sensor.textContent = 'SENSOR: OFF';
  sensor.setAttribute('aria-pressed', 'false');
  sensor.title = 'High-contrast visual filter; not thermal imagery or temperature measurements';
  const sensorNote = document.createElement('span');
  sensorNote.className = 'sensor-note'; sensorNote.hidden = true;
  sensorNote.textContent = 'SENSOR VIEW · visual filter, not thermal imagery';
  sensor.onclick = () => {
    const enabled = viewer.scene.canvas.classList.toggle('sensor-view');
    sensor.setAttribute('aria-pressed', String(enabled));
    sensor.textContent = enabled ? 'SENSOR: ON' : 'SENSOR: OFF';
    sensorNote.hidden = !enabled;
  };
  const home = document.createElement('button');
  home.className = 'hud-btn'; home.textContent = 'IBERIA';
  home.setAttribute('aria-label', 'Return to Iberia');
  home.onclick = () => viewer.camera.flyTo({destination: iberiaDestination(), duration: 1.2});
  controls.append(home, map, sensor);
  controls.parentElement!.append(mapStatus, sensorNote);
}
