// Layer registry: visibility flags for the globe layers, driven by the HUD
// checkboxes. Infrastructure is toggled per category (hospitals, schools,
// towns, power lines). One listener API: subscribers get the layer id and
// the new visibility, and get a disposer back.

import type { InfrastructureCategory } from '../../shared/threats';

export type LayerId =
  | 'hotspots'
  | 'clusters'
  | 'perimeters'
  | 'spread'
  | 'hospitals'
  | 'schools'
  | 'towns'
  | 'power-lines';

export const LAYERS: { id: LayerId; label: string }[] = [
  { id: 'hotspots', label: 'HOTSPOTS' },
  { id: 'clusters', label: 'CLUSTERS' },
  { id: 'perimeters', label: 'PERIMETERS' },
  { id: 'spread', label: 'SPREAD SIM' },
  { id: 'hospitals', label: 'HOSPITALS' },
  { id: 'schools', label: 'SCHOOLS' },
  { id: 'towns', label: 'TOWNS' },
  { id: 'power-lines', label: 'POWER LINES' },
];

export const INFRA_CATEGORY_LAYERS: Record<InfrastructureCategory, LayerId> = {
  hospital: 'hospitals',
  school: 'schools',
  town: 'towns',
  'power-line': 'power-lines',
};

const visibility = new Map<LayerId, boolean>(LAYERS.map((l) => [l.id, true]));

type VisibilityListener = (id: LayerId, visible: boolean) => void;
const listeners = new Set<VisibilityListener>();

/** Fires when a layer's visibility is toggled from the HUD. */
export function onVisibilityChanged(listener: VisibilityListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function isLayerVisible(id: LayerId): boolean {
  return visibility.get(id) ?? true;
}

export function setLayerVisible(id: LayerId, visible: boolean): void {
  if (visibility.get(id) === visible) return;
  visibility.set(id, visible);
  for (const listener of listeners) listener(id, visible);
}
