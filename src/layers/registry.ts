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
const listeners = new Set<(id: LayerId, visible: boolean) => void>();

export function isLayerVisible(id: LayerId): boolean {
  return visibility.get(id) ?? true;
}

export function setLayerVisible(id: LayerId, visible: boolean): void {
  visibility.set(id, visible);
  for (const fn of listeners) fn(id, visible);
}

export function onLayerChange(
  fn: (id: LayerId, visible: boolean) => void,
): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
