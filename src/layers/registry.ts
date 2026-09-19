// Placeholder layer registry. The visibility flags below are display only,
// not simulated: no globe layer consumes them yet, so toggling a checkbox
// changes nothing on the globe until the layers card wires real data sources.

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

export function isLayerVisible(id: LayerId): boolean {
  return visibility.get(id) ?? true;
}

export function setLayerVisible(id: LayerId, visible: boolean): void {
  visibility.set(id, visible);
}
