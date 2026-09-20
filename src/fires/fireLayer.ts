// Fire layer: renders perimeters as animated heat-gradient polygons and, when
// a fire is selected, a time-stepped ghost projection of its spread with a
// scrubber-controlled offset. Two rendering paths are used deliberately:
// primitives with a custom material fabric for the many perimeters (cheap,
// one draw call each), and data-source entities for the selected fire's
// ghost/outline/arrow (easy to retarget every scrub change without
// re-uploading geometry).

import {
  BoundingSphere,
  CallbackProperty,
  Cartesian3,
  Color,
  ColorMaterialProperty,
  CustomDataSource,
  EasingFunction,
  GeometryInstance,
  GroundPrimitive,
  HeadingPitchRange,
  Material,
  MaterialAppearance,
  Math as CesiumMath,
  PolygonGeometry,
  PolygonHierarchy,
  PolylineArrowMaterialProperty,
  PolylineDashMaterialProperty,
  ScreenSpaceEventHandler,
  ScreenSpaceEventType,
  VertexFormat,
  Viewer,
} from 'cesium';
import type { FiresResponse, LatLon } from '../../shared/fires';
import { compassLabel } from './geometry';
import { buildFireCases, projectAt, type FireCase, type Projection } from './spreadModel';
import { isLayerVisible, onVisibilityChanged } from '../layers/registry';

export interface FireLayerState {
  cases: FireCase[];
  selectedCase: FireCase | null;
  selectedId: string | null;
  scrubHours: number;
  playing: boolean;
  projection: Projection | null;
}

type StateListener = (state: FireLayerState) => void;

const PLAYBACK_HOURS_PER_SECOND = 0.5;
export const SCRUB_SNAP = 0.25;
/** Brightness multiplier applied to the selected fire's perimeter. */
const SELECTION_GAIN = 1.45;
/** Seconds the projection lingers at the far horizon before looping. */
const LOOP_HOLD_SECONDS = 2;

interface PerimeterEntry {
  caseData: FireCase;
  primitive: GroundPrimitive;
}

function toCartesians(ring: LatLon[]): Cartesian3[] {
  return ring.map((p) => Cartesian3.fromDegrees(p.lon, p.lat));
}

// Heat-gradient fabric: radial falloff around the polygon center from a
// white-hot core through amber to a red rim, with a time-driven flicker so the
// fire visibly burns. materialInput.st is the polygon's UV bounding box
// remap, so st=(0.5, 0.5) is the ring's center.
const HEAT_FABRIC_SOURCE = `
uniform vec4 uCoreColor;   // white-hot core
uniform vec4 uRimColor;     // red rim
uniform float uTime;        // seconds, driven per frame
uniform float uGain;        // brightness boost when selected

float flicker(vec2 dir, float t) {
  return 0.5 + 0.5 * sin(t * 6.0 + dir.x * 5.0 + dir.y * 3.0) * sin(t * 4.3 - dir.x * 7.0);
}

vec4 heatColor(float d) {
  float g = 1.0 - clamp(d, 0.0, 1.0);
  vec4 amber = vec4(1.0, 0.706, 0.329, 1.0); // #ffb454, the HUD amber
  vec4 c = mix(uRimColor, amber, smoothstep(0.0, 0.55, g));
  c = mix(c, uCoreColor, smoothstep(0.55, 1.0, g));
  return c;
}

czm_material czm_getMaterial(czm_materialInput materialInput) {
  czm_material m = czm_getDefaultMaterial(materialInput);
  vec2 toCenter = materialInput.st - vec2(0.5);
  float d = length(toCenter) * 2.0;
  float flick = flicker(normalize(toCenter + vec2(1e-4)), uTime);
  vec4 c = heatColor(d + 0.12 * flick * d);
  m.diffuse = c.rgb * uGain;
  m.alpha = mix(0.45, 0.95, 1.0 - d) * (0.8 + 0.2 * flick);
  return m;
}
`;

export class FireLayer {
  private readonly viewer: Viewer;
  private readonly removePreRender: () => void;
  private readonly removeVisibility: () => void;
  private readonly removePick: () => void;
  private readonly dataSource = new CustomDataSource('fire-spread');
  private readonly listeners = new Set<StateListener>();

  private cases: FireCase[] = [];
  private clusters: FiresResponse["clusters"] = [];
  private perimeterEntries: PerimeterEntry[] = [];
  private selectedId: string | null = null;
  private scrubHours = 0;
  private playing = true;
  private lastFrameTime = 0;
  /** Seconds already lingered at the far horizon, drives the loop hold. */
  private holdSeconds = 0;
  private disposed = false;

  constructor(viewer: Viewer) {
    this.viewer = viewer;
    viewer.dataSources.add(this.dataSource);

    this.removePreRender = viewer.scene.preRender.addEventListener(() => {
      this.onFrame(performance.now() / 1000);
    });

    const handler = new ScreenSpaceEventHandler(viewer.scene.canvas);
    handler.setInputAction((movement: ScreenSpaceEventHandler.PositionedEvent) => {
      const picked = viewer.scene.pick(movement.position);
      const id = picked?.id;
      if (id instanceof PerimeterPickId) {
        this.select(id.clusterId, { flyTo: true });
      }
    }, ScreenSpaceEventType.LEFT_CLICK);
    this.removePick = () => handler.destroy();

    this.removeVisibility = onVisibilityChanged((layer) => {
      if (layer === 'perimeters' || layer === 'spread') this.applyVisibility();
    });
  }

  setData(response: FiresResponse): void {
    if (this.disposed) return;
    this.clearSelection();
    for (const entry of this.perimeterEntries) {
      this.viewer.scene.primitives.remove(entry.primitive);
    }
    this.perimeterEntries = [];
    this.cases = buildFireCases(response);
    this.clusters = response.clusters;

    for (const caseData of this.cases) {
      const primitive = new GroundPrimitive({
        geometryInstances: [
          new GeometryInstance({
            geometry: new PolygonGeometry({
              polygonHierarchy: new PolygonHierarchy(
                toCartesians(caseData.basePerimeter.polygon),
              ),
              // Must match MaterialAppearance's TEXTURED vertex shader,
              // which declares the normal attribute.
              vertexFormat: VertexFormat.POSITION_NORMAL_AND_ST,
            }),
            id: new PerimeterPickId(caseData.cluster.id),
          }),
        ],
        appearance: new MaterialAppearance({
          material: new Material({
            fabric: {
              type: 'FireHeat',
              uniforms: {
                uCoreColor: Color.fromCssColorString('#fff3e0'),
                uRimColor: Color.fromCssColorString('#c62828'),
                uTime: 0,
                uGain: 1.0,
              },
              source: HEAT_FABRIC_SOURCE,
            },
            translucent: true,
          }),
          flat: false,
        }),
        asynchronous: false,
      });
      this.viewer.scene.primitives.add(primitive);
      this.perimeterEntries.push({ caseData, primitive });
    }

    this.applyVisibility();
    this.notify();
  }

  select(clusterId: string, options: { flyTo?: boolean } = {}): void {
    const target = this.cases.find((c) => c.cluster.id === clusterId);
    const cluster=this.clusters.find(c=>c.id===clusterId);
    if (!cluster) return;
    this.clearSelection();
    this.selectedId = clusterId;
    this.scrubHours = 0;
    this.playing = true;
    this.lastFrameTime = 0;
    this.holdSeconds = 0;
    for (const entry of this.perimeterEntries) {
      setGain(
        entry.primitive,
        entry.caseData.cluster.id === clusterId ? SELECTION_GAIN : 1.0,
      );
    }

    if (target && target.steps.length > 0) this.buildGhost(target);

    if (options.flyTo) {
      if (target) this.flyToCase(target);
      else this.viewer.camera.flyTo({destination:Cartesian3.fromDegrees(cluster.centroid.lon,cluster.centroid.lat,40_000),duration:1.2});
    }
    this.notify();
  }

  deselect(): void {
    if (!this.selectedId) return;
    this.clearSelection();
    for (const entry of this.perimeterEntries) {
      setGain(entry.primitive, 1.0);
    }
    this.notify();
  }

  getSelectedCase(): FireCase | null {
    return this.cases.find((c) => c.cluster.id === this.selectedId) ?? null;
  }

  setScrub(hours: number): void {
    const selected = this.getSelectedCase();
    if (!selected) return;
    const snapped = Math.round(hours / SCRUB_SNAP) * SCRUB_SNAP;
    this.scrubHours = Math.min(Math.max(snapped, 0), selected.maxHorizonHours);
    this.playing = false;
    this.notify();
  }

  setPlaying(playing: boolean): void {
    if (this.playing === playing) return;
    this.playing = playing;
    this.lastFrameTime = 0;
    this.notify();
  }

  onStateChange(listener: StateListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getState(): FireLayerState {
    const selectedCase = this.getSelectedCase();
    return {
      cases: this.cases,
      selectedCase,
      selectedId:this.selectedId,
      scrubHours: this.scrubHours,
      playing: this.playing,
      projection: selectedCase
        ? projectAt(selectedCase, this.scrubHours)
        : null,
    };
  }

  private onFrame(timeSeconds: number): void {
    if (this.disposed) return;

    const selected = this.getSelectedCase();
    if (this.perimeterEntries.length > 0) {
      for (const entry of this.perimeterEntries) {
        const material = entry.primitive.appearance?.material;
        if (material) material.uniforms.uTime = timeSeconds;
      }
    }

    if (selected && this.playing && selected.maxHorizonHours > 0) {
      if (this.lastFrameTime > 0) {
        const dt = Math.min(timeSeconds - this.lastFrameTime, 0.5);
        if (this.scrubHours >= selected.maxHorizonHours) {
          // Hold at the far horizon briefly, then loop back to the perimeter.
          this.holdSeconds += dt;
          if (this.holdSeconds >= LOOP_HOLD_SECONDS) {
            this.scrubHours = 0;
            this.holdSeconds = 0;
          }
        } else {
          this.scrubHours = Math.min(
            this.scrubHours + dt * PLAYBACK_HOURS_PER_SECOND,
            selected.maxHorizonHours,
          );
          this.holdSeconds = 0;
        }
        this.notify();
      }
    }
    this.lastFrameTime = timeSeconds;
  }

  private buildGhost(caseData: FireCase): void {
    // Translucent pulsing ghost fill. The polygon hierarchy is a
    // CallbackProperty over the current scrub projection, so it tracks the
    // scrubber without any per-frame bookkeeping here.
    this.dataSource.entities.add({
      polygon: {
        hierarchy: new CallbackProperty(
          () => new PolygonHierarchy(toCartesians(projectAt(caseData, this.scrubHours).polygon)),
          false,
        ),
        material: new ColorMaterialProperty(
          new CallbackProperty(
            () =>
              Color.fromCssColorString('#4fd8e8').withAlpha(
                0.16 + 0.08 * (0.5 + 0.5 * Math.sin((performance.now() / 1000) * 2.4)),
              ),
            false,
          ),
        ),
      },
    });

    // Dashed outline of the current projection ring.
    this.dataSource.entities.add({
      polyline: {
        positions: new CallbackProperty(
          () => toCartesians(projectAt(caseData, this.scrubHours).polygon),
          false,
        ),
        width: 2,
        material: new PolylineDashMaterialProperty({
          color: Color.fromCssColorString('#4fd8e8'),
          dashLength: 16,
        }),
        clampToGround: true,
      },
    });

    // Faint static outlines at every step horizon so the whole envelope is
    // readable at once.
    for (const step of caseData.steps) {
      this.dataSource.entities.add({
        polyline: {
          positions: toCartesians(step.polygon),
          width: 1,
          material: Color.fromCssColorString('#4fd8e8').withAlpha(0.18),
          clampToGround: true,
        },
      });
    }

    // Spread direction arrow, from perimeter centroid along the drift bearing.
    if (caseData.driftBearingDeg != null) {
      const from = caseData.centroid;
      const arrowLengthKm = 3.5; // display only, not simulated
      const [toLat, toLon] = destination(from, caseData.driftBearingDeg, arrowLengthKm);
      this.dataSource.entities.add({
        polyline: {
          positions: [
            Cartesian3.fromDegrees(from.lon, from.lat),
            Cartesian3.fromDegrees(toLon, toLat),
          ],
          width: 5,
          material: new PolylineArrowMaterialProperty(
            Color.fromCssColorString('#4fd8e8'),
          ),
          clampToGround: true,
        },
      });
    }
  }

  private clearSelection(): void {
    this.dataSource.entities.removeAll();
    this.selectedId = null;
    this.scrubHours = 0;
    this.playing = true;
    this.lastFrameTime = 0;
    this.holdSeconds = 0;
  }

  private applyVisibility(): void {
    const perimetersVisible = isLayerVisible('perimeters');
    for (const entry of this.perimeterEntries) {
      entry.primitive.show = perimetersVisible;
    }
    this.dataSource.show = isLayerVisible('spread');
  }

  private flyToCase(caseData: FireCase): void {
    const [west, south, east, north] = caseData.cluster.bbox;
    // Include the spread envelope so the projection is framed too.
    let minLat = south;
    let maxLat = north;
    let minLon = west;
    let maxLon = east;
    for (const step of caseData.steps) {
      for (const p of step.polygon) {
        minLat = Math.min(minLat, p.lat);
        maxLat = Math.max(maxLat, p.lat);
        minLon = Math.min(minLon, p.lon);
        maxLon = Math.max(maxLon, p.lon);
      }
    }
    const latSpan = Math.max(maxLat - minLat, 0.05);
    const lonSpan = Math.max(maxLon - minLon, 0.05);
    const heightM = Math.max(latSpan, lonSpan) * 111_000 * 2.2;
    const centerLat = (minLat + maxLat) / 2;
    const centerLon = (minLon + maxLon) / 2;

    // Cinematic tracked flight: camera comes in from the south at a 35 deg
    // tilt so the fire sits in the upper half of the frame and the HUD
    // chrome (scrubber, threat panel) keeps the lower half. Reduced motion
    // keeps the same destination with no flight theatrics.
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const center = Cartesian3.fromDegrees(centerLon, centerLat);
    const radius = Math.max(latSpan, lonSpan) * 111_000 * 0.5;
    const boundingSphere = new BoundingSphere(center, radius);
    this.viewer.camera.flyToBoundingSphere(boundingSphere, {
      duration: reduceMotion ? 0 : 1.8,
      offset: new HeadingPitchRange(0, CesiumMath.toRadians(-35), heightM * 1.1),
      easingFunction: EasingFunction.QUADRATIC_IN_OUT,
    });
  }

  private notify(): void {
    const state = this.getState();
    for (const listener of this.listeners) listener(state);
  }

  dispose(): void {
    this.disposed = true;
    for (const entry of this.perimeterEntries) {
      this.viewer.scene.primitives.remove(entry.primitive);
    }
    this.perimeterEntries = [];
    this.viewer.dataSources.remove(this.dataSource, true);
    this.removePreRender();
    this.removePick();
    this.removeVisibility();
    this.listeners.clear();
  }
}

/** Picking identity carried by scene.pick results. */
class PerimeterPickId {
  constructor(readonly clusterId: string) {}
}

function setGain(primitive: GroundPrimitive, gain: number): void {
  const material = primitive.appearance?.material;
  if (material) material.uniforms.uGain = gain;
}

// Destination given start, bearing (deg from north) and distance in km,
// spherical small-distance approximation.
function destination(from: LatLon, bearingDeg: number, distanceKm: number): [number, number] {
  const rad = Math.PI / 180;
  const d = distanceKm / 6371; // earth radius km
  const br = bearingDeg * rad;
  const lat1 = from.lat * rad;
  const lon1 = from.lon * rad;
  const lat2 = Math.asin(Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(br));
  const lon2 =
    lon1 +
    Math.atan2(
      Math.sin(br) * Math.sin(d) * Math.cos(lat1),
      Math.cos(d) - Math.sin(lat1) * Math.sin(lat2),
    );
  return [lat2 / rad, ((lon2 / rad + 540) % 360) - 180];
}

export function driftLabel(caseData: FireCase): string | null {
  if (caseData.driftBearingDeg == null) return null;
  return `${Math.round(caseData.driftBearingDeg)}deg ${compassLabel(caseData.driftBearingDeg)}`;
}
