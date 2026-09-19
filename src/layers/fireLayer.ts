// Fire layer controller: polls /api/fires and renders hotspots as pulsing
// markers (sized/colored by fire radiative power) plus clusters as bounding
// regions. Clicking a hotspot selects it and opens the metadata panel.

import {
  CallbackProperty,
  Cartesian3,
  Color,
  ConstantProperty,
  Entity,
  Rectangle,
  ScreenSpaceEventHandler,
  ScreenSpaceEventType,
  Viewer,
} from 'cesium';
import type { FireCluster, FiresResponse, Hotspot } from '../../shared/fires';
import { fetchFires } from '../data/api';
import { createHotspotPanel } from '../hud/hotspotPanel';
import { isLayerVisible, onVisibilityChanged } from './registry';

// Poll cadence. MTG hotspot cadence is ~10 min live; replay snapshots are
// static per request so we refresh faster to keep the demo responsive.
const LIVE_POLL_MS = 10 * 60 * 1000;
const REPLAY_POLL_MS = 60 * 1000;
const RETRY_POLL_MS = 15 * 1000;

// FRP ceiling that clamps marker size and color scaling (display heuristic,
// not a modeled threshold).
const FRP_MAX_MW = 150;

const COLOR_LOW_FRP = Color.fromCssColorString('#ffb454'); // amber
const COLOR_HIGH_FRP = Color.fromCssColorString('#ff3b1f'); // hot red
const COLOR_MARKER_OUTLINE = Color.fromCssColorString('#0a0e12');
const COLOR_SELECTED = Color.fromCssColorString('#ffffff');
const COLOR_CLUSTER_FILL = Color.fromCssColorString('#ffb454').withAlpha(0.06);
const COLOR_CLUSTER_LINE = Color.fromCssColorString('#ffb454').withAlpha(0.55);

function frpScale(frpMw: number): number {
  return Math.min(1, Math.max(0, frpMw / FRP_MAX_MW));
}

function frpBaseSize(frpMw: number): number {
  return 9 + frpScale(frpMw) * 17;
}

function frpColor(frpMw: number): Color {
  return Color.lerp(
    COLOR_LOW_FRP,
    COLOR_HIGH_FRP,
    frpScale(frpMw),
    new Color(),
  );
}

// Radar-contact pulse: size breathes between base and base * 1.25.
function pulsingSize(base: number, phase: number): CallbackProperty {
  return new CallbackProperty(() => {
    const t = performance.now() / 1000;
    return base * (1 + 0.25 * (0.5 - 0.5 * Math.cos(t * 2.4 + phase)));
  }, false);
}

export function createFireLayer(
  viewer: Viewer,
  hudRoot: HTMLElement,
  onProvenance: (provenance: 'live' | 'replay') => void,
): void {
  const hotspotEntities = new Map<string, Entity>();
  const clusterEntities = new Map<string, Entity>();
  const hotspotsById = new Map<string, Hotspot>();
  const clustersById = new Map<string, FireCluster>();
  let selectedId: string | null = null;

  const deselect = () => {
    if (selectedId) {
      const prev = hotspotEntities.get(selectedId);
      if (prev?.point) {
        prev.point.outlineColor = new ConstantProperty(COLOR_MARKER_OUTLINE);
        prev.point.outlineWidth = new ConstantProperty(1.5);
      }
    }
    selectedId = null;
    panel.hide();
  };

  const panel = createHotspotPanel(hudRoot, deselect);

  function renderFires(data: FiresResponse): void {
    for (const entity of hotspotEntities.values()) {
      viewer.entities.remove(entity);
    }
    hotspotEntities.clear();
    for (const entity of clusterEntities.values()) {
      viewer.entities.remove(entity);
    }
    clusterEntities.clear();
    hotspotsById.clear();
    clustersById.clear();

    for (const hotspot of data.hotspots) {
      hotspotsById.set(hotspot.id, hotspot);
    }
    for (const cluster of data.clusters) {
      clustersById.set(cluster.id, cluster);
    }

    const clustersVisible = isLayerVisible('clusters');
    for (const cluster of data.clusters) {
      const [west, south, east, north] = cluster.bbox;
      // Fill drapes on terrain. Outline is a separate ground-clamped polyline:
      // rectangle outlines are unsupported on some platforms (cesium#40).
      const fill = viewer.entities.add({
        id: `cluster-${cluster.id}`,
        show: clustersVisible,
        rectangle: {
          coordinates: Rectangle.fromDegrees(west, south, east, north),
          material: COLOR_CLUSTER_FILL,
        },
      });
      const corners = [
        Cartesian3.fromDegrees(west, south),
        Cartesian3.fromDegrees(east, south),
        Cartesian3.fromDegrees(east, north),
        Cartesian3.fromDegrees(west, north),
        Cartesian3.fromDegrees(west, south),
      ];
      const outlineEntity = viewer.entities.add({
        id: `cluster-outline-${cluster.id}`,
        show: clustersVisible,
        polyline: {
          positions: corners,
          width: 1.5,
          material: COLOR_CLUSTER_LINE,
          clampToGround: true,
        },
      });
      clusterEntities.set(cluster.id, fill);
      clusterEntities.set(`${cluster.id}-outline`, outlineEntity);
    }

    const hotspotsVisible = isLayerVisible('hotspots');
    for (const [index, hotspot] of data.hotspots.entries()) {
      // An unmeasured FRP (null) renders as the smallest, coolest marker.
      const frpMw = hotspot.frpMw ?? 0;
      const entity = viewer.entities.add({
        id: `hotspot-${hotspot.id}`,
        show: hotspotsVisible,
        position: Cartesian3.fromDegrees(
          hotspot.position.lon,
          hotspot.position.lat,
        ),
        point: {
          pixelSize: pulsingSize(frpBaseSize(frpMw), index * 0.6),
          color: frpColor(frpMw),
          outlineColor:
            selectedId === hotspot.id
              ? COLOR_SELECTED
              : COLOR_MARKER_OUTLINE,
          outlineWidth: selectedId === hotspot.id ? 2.5 : 1.5,
        },
      });
      hotspotEntities.set(hotspot.id, entity);
    }

    if (selectedId && !hotspotEntities.has(selectedId)) {
      deselect();
    }
  }

  function selectHotspot(id: string): void {
    if (selectedId === id) return;
    deselect();
    selectedId = id;
    const entity = hotspotEntities.get(id);
    if (entity?.point) {
      entity.point.outlineColor = new ConstantProperty(COLOR_SELECTED);
      entity.point.outlineWidth = new ConstantProperty(2.5);
    }
    const hotspot = hotspotsById.get(id);
    const cluster = hotspot?.clusterId
      ? (clustersById.get(hotspot.clusterId) ?? null)
      : null;
    if (hotspot) {
      panel.show(hotspot, cluster);
    }
  }

  onVisibilityChanged((layer) => {
    if (layer === 'hotspots') {
      const visible = isLayerVisible('hotspots');
      for (const entity of hotspotEntities.values()) {
        entity.show = visible;
      }
    }
    if (layer === 'clusters') {
      const visible = isLayerVisible('clusters');
      for (const entity of clusterEntities.values()) {
        entity.show = visible;
      }
    }
  });

  const handler = new ScreenSpaceEventHandler(viewer.scene.canvas);
  handler.setInputAction((click: ScreenSpaceEventHandler.PositionedEvent) => {
    const picked = viewer.scene.pick(click.position);
    const entity = picked?.id;
    if (
      entity instanceof Entity &&
      typeof entity.id === 'string' &&
      entity.id.startsWith('hotspot-')
    ) {
      selectHotspot(entity.id.slice('hotspot-'.length));
    } else {
      deselect();
    }
  }, ScreenSpaceEventType.LEFT_CLICK);

  let pollTimer: ReturnType<typeof setTimeout> | undefined;

  function schedule(delayMs: number): void {
    clearTimeout(pollTimer);
    pollTimer = setTimeout(() => void poll(), delayMs);
  }

  async function poll(): Promise<void> {
    try {
      const data = await fetchFires();
      onProvenance(data.provenance);
      renderFires(data);
      schedule(data.provenance === 'live' ? LIVE_POLL_MS : REPLAY_POLL_MS);
    } catch (err) {
      console.error('[fire-layer] fetch failed, will retry', err);
      schedule(RETRY_POLL_MS);
    }
  }

  void poll();
}
