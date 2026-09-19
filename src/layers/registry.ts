// Layer registry. Visibility flags for the globe layers plus change listeners
// so a layer controller can show/hide its Cesium primitives when the HUD
// checkbox flips.

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

type VisibilityListener = (visible: boolean) => void;

const listeners = new Map<LayerId, Set<VisibilityListener>>();

export function isLayerVisible(id: LayerId): boolean {
  return visibility.get(id) ?? true;
}

export function setLayerVisible(id: LayerId, visible: boolean): void {
  visibility.set(id, visible);
  for (const listener of listeners.get(id) ?? []) {
    listener(visible);
  }
}

export function onLayerVisibilityChanged(
  id: LayerId,
  listener: VisibilityListener,
): void {
  let set = listeners.get(id);
  if (!set) {
    set = new Set();
    listeners.set(id, set);
  }
  set.add(listener);
}
