// Infrastructure layer: cyan point assets (hospitals, schools, towns) plus
// power line paths, fetched once from /api/infrastructure. Visibility per
// category follows the layer registry toggles.

import {
  Cartesian3,
  Color,
  Material,
  PointPrimitiveCollection,
  PolylineCollection,
  Scene,
  ScreenSpaceEventHandler,
  ScreenSpaceEventType,
} from 'cesium';
import { fetchInfrastructure } from '../data/api';
import type { InfrastructureAsset, InfrastructureResponse } from '../../shared/threats';
import {
  INFRA_CATEGORY_LAYERS,
  isLayerVisible,
  onVisibilityChanged,
} from './registry';

const CYAN = Color.fromCssColorString('#4fd8e8');

// Per-category marker scale, so hospitals read larger than schools/towns at
// the same zoom. Display only, not simulated.
const CATEGORY_SCALE: Record<InfrastructureAsset['category'], number> = {
  hospital: 7,
  school: 4,
  town: 4,
  'power-line': 5,
};

export interface InfraClickHandler {
  (asset: InfrastructureAsset): void;
}

export class InfrastructureLayer {
  private points: PointPrimitiveCollection;
  private lines: PolylineCollection;
  private assets: InfrastructureAsset[] = [];
  private pointCategories: { category: InfrastructureAsset['category']; point: { show: boolean } & object }[] = [];
  private lineEntries: { line: { show: boolean } & object }[] = [];
  private disposers: (() => void)[] = [];

  constructor(private scene: Scene, private onAssetClick: InfraClickHandler) {
    this.points = new PointPrimitiveCollection();
    this.lines = new PolylineCollection();
    scene.primitives.add(this.points);
    scene.primitives.add(this.lines);

    this.disposers.push(
      onVisibilityChanged(() => this.refreshVisibility()),
    );

    this.wirePicking();

    void this.load();
  }

  private async load(): Promise<void> {
    let data: InfrastructureResponse;
    try {
      data = await fetchInfrastructure();
    } catch (err) {
      console.error('[infrastructure] fetch failed:', err);
      return;
    }
    this.assets = data.assets;

    for (const asset of data.assets) {
      if (asset.category === 'power-line') continue;
      const p = this.points.add({
        position: Cartesian3.fromDegrees(asset.position.lon, asset.position.lat),
        pixelSize: CATEGORY_SCALE[asset.category],
        color: CYAN.withAlpha(asset.category === 'hospital' ? 0.95 : 0.7),
        outlineColor: Color.BLACK.withAlpha(0.6),
        outlineWidth: 1,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
        id: asset.id,
      });
      this.pointCategories.push({ category: asset.category, point: p });
    }

    for (const path of Object.values(data.powerLinePaths)) {
      this.lineEntries.push({
        line: this.lines.add({
          positions: path.map((p) => Cartesian3.fromDegrees(p.lon, p.lat)),
          width: 1.5,
          // PolylineCollection takes Material instances, not bare Colors.
          material: Material.fromType('Color', { color: CYAN.withAlpha(0.5) }),
          clampToGround: true,
        }),
      });
    }

    this.refreshVisibility();
  }

  private refreshVisibility(): void {
    for (const { category, point } of this.pointCategories) {
      point.show = isLayerVisible(INFRA_CATEGORY_LAYERS[category]);
    }
    const showLines = isLayerVisible(INFRA_CATEGORY_LAYERS['power-line']);
    for (const { line } of this.lineEntries) {
      line.show = showLines;
    }
  }

  // Picking goes through the scene's picked objects; infra points carry their
  // asset id, so a click on one resolves to the asset.
  private wirePicking(): void {
    const handler = new ScreenSpaceEventHandler(this.scene.canvas);
    handler.setInputAction((click: ScreenSpaceEventHandler.PositionedEvent) => {
      const picked = this.scene.pick(click.position);
      const id = picked?.id;
      if (typeof id === 'string') {
        const asset = this.assets.find((a) => a.id === id);
        if (asset) this.onAssetClick(asset);
      }
    }, ScreenSpaceEventType.LEFT_CLICK);
    this.disposers.push(() => handler.destroy());
  }

  destroy(): void {
    for (const dispose of this.disposers) dispose();
    this.scene.primitives.remove(this.points);
    this.scene.primitives.remove(this.lines);
  }
}
