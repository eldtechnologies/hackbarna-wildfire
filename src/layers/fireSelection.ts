// Fire selection + threat panel: renders a minimal marker per fire cluster so
// a fire can be picked, and on selection fetches /api/threats and shows the
// threatened-asset list grouped by ring. Kept deliberately thin: the full
// hotspot/perimeter/spread visuals come from their own cards and will merge
// on top of this.

import {
  Cartesian2,
  Cartesian3,
  Color,
  ConstantProperty,
  ScreenSpaceEventHandler,
  ScreenSpaceEventType,
  Viewer,
} from 'cesium';
import { fetchFires, fetchThreats } from '../data/api';
import { CATEGORY_LABEL } from '../../shared/threats';
import type { ThreatsResponse } from '../../shared/threats';

const FIRE_PICK_COLOR = Color.fromCssColorString('#ffb454').withAlpha(0.9);

const RING_LABEL: Record<ThreatsResponse['rings'][number]['ring'], string> = {
  inside: 'INSIDE PERIMETER',
  'ring-5km': 'WITHIN 5 KM',
  'ring-10km': 'WITHIN 10 KM',
  'ring-20km': 'WITHIN 20 KM',
};

export interface FireSelectionChange {
  (fireId: string | null, fireName: string | null): void;
}

export class FireSelectionLayer {
  private handler: ScreenSpaceEventHandler;
  private selectedId: string | null = null;

  constructor(
    private viewer: Viewer,
    private panel: HTMLElement,
    private onSelectionChange: FireSelectionChange,
  ) {
    this.handler = new ScreenSpaceEventHandler(viewer.scene.canvas);
    this.handler.setInputAction(
      (click: ScreenSpaceEventHandler.PositionedEvent) => {
        const picked = viewer.scene.pick(click.position);
        const id = picked?.id;
        // Entities created here carry fire:<clusterId>; infra points carry
        // plain asset ids and are handled by their own layer.
        if (typeof id === 'string' && id.startsWith('fire:')) {
          this.select(id.slice('fire:'.length));
        } else {
          this.clear();
        }
      },
      ScreenSpaceEventType.LEFT_CLICK,
    );

    void this.load();
  }

  private async load(): Promise<void> {
    let fires;
    try {
      fires = await fetchFires();
    } catch (err) {
      console.error('[fire-selection] fetch failed:', err);
      return;
    }
    for (const cluster of fires.clusters) {
      this.viewer.entities.add({
        id: `fire:${cluster.id}`,
        position: Cartesian3.fromDegrees(cluster.centroid.lon, cluster.centroid.lat),
        point: {
          pixelSize: 9,
          color: FIRE_PICK_COLOR,
          outlineColor: Color.BLACK.withAlpha(0.6),
          outlineWidth: 1,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
        label: {
          text: new ConstantProperty(cluster.name ?? cluster.id),
          font: '11px JetBrains Mono, monospace',
          fillColor: Color.fromCssColorString('#ffb454'),
          showBackground: true,
          backgroundColor: Color.fromCssColorString('#0a0e12').withAlpha(0.7),
          pixelOffset: new ConstantProperty(new Cartesian2(12, -8)),
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
      });
    }
  }

  select(fireId: string): void {
    this.selectedId = fireId;
    this.renderLoading(fireId);
    fetchThreats(fireId)
      .then((threats) => {
        if (this.selectedId === fireId) this.render(threats);
      })
      .catch((err) => {
        console.error('[fire-selection] threats fetch failed:', err);
        if (this.selectedId === fireId) this.renderError(fireId);
      });
  }

  private clear(): void {
    if (!this.selectedId) return;
    this.selectedId = null;
    this.panel.classList.remove('open');
    this.panel.replaceChildren();
    this.onSelectionChange(null, null);
  }

  private renderLoading(fireId: string): void {
    this.panel.classList.add('open');
    this.panel.replaceChildren();
    const title = document.createElement('div');
    title.className = 'threat-title';
    title.textContent = `THREAT ANALYSIS / ${fireId}`;
    const body = document.createElement('div');
    body.className = 'threat-body';
    body.textContent = 'ANALYZING...';
    this.panel.append(title, body);
    this.onSelectionChange(fireId, null);
  }

  private renderError(_fireId: string): void {
    const body = this.panel.querySelector('.threat-body');
    if (body) body.textContent = 'ANALYSIS UNAVAILABLE';
  }

  private render(threats: ThreatsResponse): void {
    this.panel.classList.add('open');
    this.panel.replaceChildren();

    const title = document.createElement('div');
    title.className = 'threat-title';
    title.textContent = `THREAT ANALYSIS / ${threats.fireId}`;

    const meta = document.createElement('div');
    meta.className = 'threat-meta';
    const corridorNote =
      threats.corridorCount > 0 ? `${threats.corridorCount} IN SPREAD CORRIDOR` : '';
    meta.textContent = `${threats.threatened.length} ASSETS ${corridorNote}`.trim();

    const body = document.createElement('div');
    body.className = 'threat-body';

    if (threats.threatened.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'threat-empty';
      empty.textContent = 'NO ASSETS WITHIN 20 KM';
      body.appendChild(empty);
    } else {
      for (const ring of threats.rings) {
        const group = threats.threatened.filter((t) => t.ring === ring.ring);
        if (group.length === 0) continue;
        const heading = document.createElement('div');
        heading.className = 'threat-ring-heading';
        heading.textContent = `${RING_LABEL[ring.ring]} (${group.length})`;
        body.appendChild(heading);
        for (const t of group) {
          const row = document.createElement('div');
          row.className = 'threat-asset' + (t.inSpreadCorridor ? ' corridor' : '');
          const left = document.createElement('span');
          left.className = 'threat-asset-name';
          left.textContent = t.name;
          const right = document.createElement('span');
          right.className = 'threat-asset-info';
          const dist = t.ring === 'inside' ? '0 KM' : `${t.distanceKm.toFixed(1)} KM`;
          right.textContent = `${CATEGORY_LABEL[t.category].toUpperCase()} / ${dist}${t.inSpreadCorridor ? ' / CORRIDOR' : ''}`;
          row.append(left, right);
          body.appendChild(row);
        }
      }
    }

    this.panel.append(title, meta, body);
    this.onSelectionChange(threats.fireId, null);
  }

  destroy(): void {
    this.handler.destroy();
    this.viewer.entities.removeAll();
  }
}
