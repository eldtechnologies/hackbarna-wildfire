// Load the committed road graph into the shape the solve walks.
//
// The file is produced by scripts/fetch-roads.mjs. Geometry rows are shared between an
// edge and its reverse, so the loader reverses a row when the edge carries `reversed`
// — otherwise a back-edge reports its distance walked forwards and its `segmentIds`
// read backwards along the road.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { LatLon } from '../../shared/fires';
import type { Edge, RoadGraph } from './solve';

export interface GraphFile {
  source: string;
  fetched: string;
  bbox: [number, number, number, number];
  speedByHighway: Record<string, number>;
  /** [lat, lon] pairs. */
  nodes: Array<[number, number]>;
  geometries: Array<Array<[number, number]>>;
  edges: Array<{
    id: string;
    from: number;
    to: number;
    highway: string;
    name: string | null;
    travelSeconds: number;
    geometryIndex: number;
    reversed: boolean;
  }>;
  outgoing: number[][];
  incoming: number[][];
}

export const DEFAULT_GRAPH_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../data/graph/los-gallardos.json',
);

export interface LoadedGraph {
  graph: RoadGraph;
  speedByHighway: Record<string, number>;
  source: string;
  fetched: string;
}

export function loadGraph(path: string = DEFAULT_GRAPH_PATH): LoadedGraph {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as GraphFile;

  const nodes: LatLon[] = raw.nodes.map(([lat, lon]) => ({ lat, lon }));
  const geometries: LatLon[][] = raw.geometries.map((row) => row.map(([lat, lon]) => ({ lat, lon })));

  const edges: Edge[] = [];
  const outgoing: number[][] = nodes.map(() => []);
  const incoming: number[][] = nodes.map(() => []);
  const dangling: string[] = [];

  for (const row of raw.edges) {
    if (row.from < 0 || row.from >= nodes.length || row.to < 0 || row.to >= nodes.length) {
      // A committed file should never contain these; skipping silently would quietly
      // disconnect the network, so the count is surfaced instead.
      dangling.push(row.id);
      continue;
    }
    const shared = geometries[row.geometryIndex];
    if (!Array.isArray(shared) || shared.length < 2) {
      // An out-of-range geometry index silently degraded to an empty polyline, which
      // measures zero length and reports a drive across the county as instantaneous.
      dangling.push(row.id);
      continue;
    }
    if (!Number.isFinite(row.travelSeconds) || row.travelSeconds <= 0) {
      // travelSeconds drives the solve's monotonicity argument, and a non-finite value
      // slips through its relaxation as NaN — rejected by latestDeparture but accepted by
      // routeTo, whose `arriveAt > deadline` test is false for NaN. The loader is where
      // it is cheap to refuse.
      dangling.push(row.id);
      continue;
    }
    const geometry = row.reversed ? [...shared].reverse() : shared;
    const index = edges.length;
    edges.push({
      id: row.id,
      from: row.from,
      to: row.to,
      geometry,
      highway: row.highway,
      name: row.name,
      travelSeconds: row.travelSeconds,
    });
    outgoing[row.from].push(index);
    incoming[row.to].push(index);
  }

  if (dangling.length > 0) {
    console.warn(`[graph] skipped ${dangling.length} unusable edges (node ids, geometry or travel time): ${dangling.slice(0, 3).join(', ')}`);
  }

  return {
    graph: { nodes, edges, outgoing, incoming },
    speedByHighway: raw.speedByHighway,
    source: raw.source,
    fetched: raw.fetched,
  };
}

export interface TopologyReport {
  nodes: number;
  edges: number;
  /** Size of the largest weakly-connected component. */
  largestComponent: number;
  components: number;
  isolatedNodes: number;
}

/**
 * Weak-connectivity check. Worth running after regenerating the graph: an earlier
 * version keyed nodes on way endpoints only and produced 1,695 components with the
 * largest holding a fifth of the nodes, which no routing test would have caught because
 * a single reachable destination is enough to make the solve return an answer.
 */
export function topology(graph: RoadGraph): TopologyReport {
  const n = graph.nodes.length;
  const parent = new Int32Array(n);
  for (let i = 0; i < n; i++) parent[i] = i;
  const find = (a: number): number => {
    let root = a;
    while (parent[root] !== root) root = parent[root];
    while (parent[a] !== root) {
      const next = parent[a];
      parent[a] = root;
      a = next;
    }
    return root;
  };
  for (const edge of graph.edges) {
    const ra = find(edge.from);
    const rb = find(edge.to);
    if (ra !== rb) parent[ra] = rb;
  }
  const sizes = new Map<number, number>();
  for (let i = 0; i < n; i++) {
    const root = find(i);
    sizes.set(root, (sizes.get(root) ?? 0) + 1);
  }
  const degree = new Int32Array(n);
  for (const edge of graph.edges) {
    degree[edge.from] += 1;
    degree[edge.to] += 1;
  }
  let isolated = 0;
  for (let i = 0; i < n; i++) if (degree[i] === 0) isolated += 1;
  return {
    nodes: n,
    edges: graph.edges.length,
    components: sizes.size,
    largestComponent: Math.max(0, ...sizes.values()),
    isolatedNodes: isolated,
  };
}

/**
 * Index of the nearest graph node to a point.
 *
 * Every class the fetcher keeps is one a car can use — footways, paths, steps and
 * cycleways never enter the graph — so there is no separate "is this drivable" filter
 * to apply here. Road *quality* is a different question and the solve answers it by
 * reporting the worst class on the chosen route.
 */
export function nearestNode(graph: RoadGraph, p: LatLon): number | null {
  let best = Number.POSITIVE_INFINITY;
  let bestIndex: number | null = null;
  for (let i = 0; i < graph.nodes.length; i++) {
    const node = graph.nodes[i];
    const dLat = node.lat - p.lat;
    const dLon = (node.lon - p.lon) * Math.cos((p.lat * Math.PI) / 180);
    const d = dLat * dLat + dLon * dLon;
    if (d < best) {
      best = d;
      bestIndex = i;
    }
  }
  return bestIndex;
}
