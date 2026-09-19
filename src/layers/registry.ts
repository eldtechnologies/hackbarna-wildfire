// Layer registry: visibility flags for the globe layers, driven by the HUD
// checkboxes. Infrastructure is toggled per category (hospitals, schools,
// towns, power lines). Layers without a consuming module yet are display
// flags only: the fire layers (hotspots, clusters, perimeters, spread) are
// wired by their own cards.

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

export function isLayerVisible(id: LayerId): boolean {
  return visibility.get(id) ?? true;
}

export function setLayerVisible(id: LayerId, visible: boolean): void {
  visibility.set(id, visible);
  for (const fn of listeners) fn(id, visible);
}

export function onLayerVisibilityChanged(fn: VisibilityListener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
