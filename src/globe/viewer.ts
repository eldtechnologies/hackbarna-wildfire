import {
  Cartesian3,
  Color,
  ImageryLayer,
  UrlTemplateImageryProvider,
  Viewer,
} from 'cesium';

// Esri World Imagery, keyless. Same default as gods-eye-view.
const ESRI_WORLD_IMAGERY =
  'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';

// Default camera: whole Iberian Peninsula in frame.
const IBERIA_CENTER = { lon: -3.7, lat: 40.2, heightMeters: 1_600_000 };

export function createGlobeViewer(container: HTMLElement): Viewer {
  // Attribution stays visible (Esri tile terms), styled dim in style.css.
  const imagery = new UrlTemplateImageryProvider({
    url: ESRI_WORLD_IMAGERY,
    credit: 'Esri, Maxar, Earthstar Geographics',
  });

  const viewer = new Viewer(container, {
    baseLayer: new ImageryLayer(imagery),
    animation: false,
    timeline: false,
    geocoder: false,
    homeButton: false,
    sceneModePicker: false,
    baseLayerPicker: false,
    navigationHelpButton: false,
    fullscreenButton: false,
    infoBox: false,
    selectionIndicator: false,
  });

  viewer.scene.globe.enableLighting = false;
  viewer.scene.backgroundColor = Color.fromCssColorString('#0a0e12');

  viewer.camera.setView({
    destination: Cartesian3.fromDegrees(
      IBERIA_CENTER.lon,
      IBERIA_CENTER.lat,
      IBERIA_CENTER.heightMeters,
    ),
  });

  return viewer;
}
