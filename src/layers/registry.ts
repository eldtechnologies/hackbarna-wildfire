// Layer registry: shared visibility flags for globe layers plus change
// notification so layers can react to HUD toggles.

export type LayerId =
  | 'hotspots'
  | 'clusters'
  | 'perimeters'
  | 'spread'
  | 'infrastructure';

export const LAYERS: { id: LayerId; label: string }[] = [
  { id: 'hotspots', label: 'HOTSPOTS' },
  { id: 'clusters', label: 'CLUSTERS' },
  { id: 'perimeters', label: 'PERIMETERS' },
  { id: 'spread', label: 'SPREAD SIM' },
  { id: 'infrastructure', label: 'INFRASTRUCTURE' },
];

const visibility = new Map<LayerId, boolean>(LAYERS.map((l) => [l.id, true]));

type VisibilityListener = (id: LayerId) => void;
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
  for (const listener of listeners) listener(id);
}
