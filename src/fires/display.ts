import type { FireCluster } from '../../shared/fires';

export function clusterDisplayName(cluster: Pick<FireCluster, 'name' | 'id'>): string {
  return cluster.name ?? cluster.id.slice(0, 8);
}
