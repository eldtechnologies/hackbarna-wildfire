// Last safe departure: the latest a vehicle can leave a node and still reach safety.
//
// The recurrence is
//
//     g(v) = max over edges e=(v->w) of [ min(c(e), g(w)) - tau(e) ]
//
// where c(e) is the time the fire reaches edge e and tau(e) is its free-flow travel
// time. Read it as: to leave v at t and be safe, you must arrive at w by
// min(c(e), g(w)), and the drive itself takes tau(e).
//
// Two properties make this exact and cheap, and both are load-bearing:
//
//   * Extending a path never increases the value: min(c, g(w)) <= g(w), so a candidate
//     g(v) <= g(w) - tau(e) <= g(w). Labels therefore fall monotonically as a path is
//     extended, which is what lets a Dijkstra settle nodes once, in decreasing order.
//   * The propagation runs along REVERSE adjacency. Information flows from the
//     destination back toward the pocket. Relaxing forward along outgoing edges looks
//     almost identical and is wrong — it was written that way first, and comparing
//     against exhaustive path enumeration over 20,000 random graphs produced 2,419
//     mismatches before the direction was fixed.
//
// Waiting is free and needs no special handling: leaving earlier is never worse, so
// the feasible departure times from any node are downward-closed and a single scalar
// per node captures the whole state. The route the optimum takes has zero slack on
// every edge, which is why the travel time it reports is a lower bound on the drive,
// not a promise about arrival.

import type { LatLon } from '../../shared/fires';
import { polylineLengthMetres } from './geometry';

export interface Edge {
  id: string;
  from: number;
  to: number;
  geometry: LatLon[];
  highway: string;
  name: string | null;
  /** Free-flow travel time in seconds. Integer. */
  travelSeconds: number;
}

export interface RoadGraph {
  nodes: LatLon[];
  edges: Edge[];
  /** Node index -> indices of its outgoing edges. */
  outgoing: number[][];
  /** Node index -> indices of its incoming edges. */
  incoming: number[][];
}

export interface SolveResult {
  /**
   * Latest departure per node, in seconds since the scenario origin. Infinity means
   * nothing on any surviving route is ever cut. -Infinity means no safe route.
   */
  latestDeparture: number[];
  /** Edge index leaving each node toward safety; -1 when the node is a destination or unreachable. */
  viaEdge: number[];
  /** True for nodes from which a destination was actually reached. */
  reachable: boolean[];
}

/**
 * When the fire reaches each node, computed from the mask directly rather than derived
 * from the incident edges.
 *
 * Deriving it as "the earliest cut among my incident edges" is tempting and wrong: a
 * disc covering only the far end of a 1 km access road cuts that road without the
 * village being touched, so the derived value closes settlements the fire never
 * reaches. The two quantities mean different things — an edge is cut when the fire
 * reaches any part of it, a node when the fire reaches the node — and only the mask
 * knows the difference.
 *
 * `mask.ts:nodeCutField` produces this. Callers that have no node field pass nothing
 * and every node reads as never reached, which is the historic spike semantics.
 */
export function allNodesSafe(nodeCount: number): number[] {
  return new Array<number>(nodeCount).fill(Number.POSITIVE_INFINITY);
}

/** Minimal binary heap ordered by decreasing value, then by ascending node index. */
class MaxHeap {
  private readonly values: number[] = [];
  private readonly nodes: number[] = [];

  get size(): number {
    return this.nodes.length;
  }

  push(value: number, node: number): void {
    this.values.push(value);
    this.nodes.push(node);
    let i = this.values.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (!this.before(i, parent)) break;
      this.swap(i, parent);
      i = parent;
    }
  }

  pop(): { value: number; node: number } {
    const value = this.values[0];
    const node = this.nodes[0];
    const lastValue = this.values.pop()!;
    const lastNode = this.nodes.pop()!;
    if (this.nodes.length > 0) {
      this.values[0] = lastValue;
      this.nodes[0] = lastNode;
      let i = 0;
      for (;;) {
        const left = 2 * i + 1;
        const right = left + 1;
        let best = i;
        if (left < this.values.length && this.before(left, best)) best = left;
        if (right < this.values.length && this.before(right, best)) best = right;
        if (best === i) break;
        this.swap(i, best);
        i = best;
      }
    }
    return { value, node };
  }

  /** Larger value first; on a tie, smaller node index first, so settling is deterministic. */
  private before(a: number, b: number): boolean {
    if (this.values[a] !== this.values[b]) return this.values[a] > this.values[b];
    return this.nodes[a] < this.nodes[b];
  }

  private swap(a: number, b: number): void {
    [this.values[a], this.values[b]] = [this.values[b], this.values[a]];
    [this.nodes[a], this.nodes[b]] = [this.nodes[b], this.nodes[a]];
  }
}

export interface SolveOptions {
  /**
   * Prefer a route by these keys when two yield the same departure time. Without a
   * total order the chosen path — and therefore the road named in the alert — can
   * differ between two identical calls.
   */
  edgeLengthM?: (edge: Edge) => number;
  /**
   * Seconds since origin at which the fire reaches each node. Arriving at a destination
   * after this is not arriving safely, so it becomes the destination's departure
   * ceiling. Omitted means every node is treated as never reached.
   */
  nodeCutSeconds?: number[];
}

/**
 * Latest departure from every node, in one pass.
 *
 * O(E log V). One call answers for every pocket, which is what makes sweeping twelve
 * assumption sets cheap: the sweep is twelve passes here, not twelve solves per pocket.
 */
export function latestDeparture(
  graph: RoadGraph,
  cutAtSeconds: number[],
  destinations: Iterable<number>,
  options: SolveOptions = {},
): SolveResult {
  const n = graph.nodes.length;
  const nodeCut = options.nodeCutSeconds ?? allNodesSafe(n);
  const g = new Array<number>(n).fill(Number.NEGATIVE_INFINITY);
  const viaEdge = new Array<number>(n).fill(-1);
  const settled = new Uint8Array(n);

  const lengthOf = options.edgeLengthM ?? ((e: Edge) => polylineLengthMetres(e.geometry));

  const heap = new MaxHeap();
  for (const d of destinations) {
    if (d < 0 || d >= n) continue;
    const seed = nodeCut[d];
    if (seed > g[d]) {
      g[d] = seed;
      heap.push(seed, d);
    }
  }

  while (heap.size > 0) {
    const { node: w } = heap.pop();
    if (settled[w]) continue;
    settled[w] = 1;
    const gw = g[w];

    // Walk the edges that ARRIVE at w, and offer each predecessor a departure time.
    for (const edgeIndex of graph.incoming[w]) {
      const edge = graph.edges[edgeIndex];
      const v = edge.from;
      if (settled[v]) continue;
      const cand = Math.min(cutAtSeconds[edgeIndex], gw) - edge.travelSeconds;
      if (cand > g[v]) {
        g[v] = cand;
        viaEdge[v] = edgeIndex;
        heap.push(cand, v);
      } else if (cand === g[v] && viaEdge[v] >= 0 && !settled[v]) {
        // Equal departure: pick deterministically so the named road cannot flicker.
        const incumbent = graph.edges[viaEdge[v]];
        if (candidateIsBetter(edge, incumbent, lengthOf)) viaEdge[v] = edgeIndex;
      }
    }
  }

  const reachable = g.map((value) => value > Number.NEGATIVE_INFINITY);
  return { latestDeparture: g, viaEdge, reachable };
}

function candidateIsBetter(candidate: Edge, incumbent: Edge, lengthOf: (e: Edge) => number): boolean {
  if (candidate.travelSeconds !== incumbent.travelSeconds) {
    return candidate.travelSeconds < incumbent.travelSeconds;
  }
  const lc = lengthOf(candidate);
  const li = lengthOf(incumbent);
  if (lc !== li) return lc < li;
  return candidate.id < incumbent.id;
}

/**
 * Road classes worst-first. A route that only exists because a forest track is in the
 * graph should say so on its face rather than inside a free-text basis string — the
 * spike's own warning is that people died on tracks that looked like roads.
 */
export const HIGHWAY_RANK: readonly string[] = [
  'motorway',
  'trunk',
  'primary',
  'secondary',
  'tertiary',
  'unclassified',
  'residential',
  'living_street',
  'service',
  'track',
  'road',
];

/** Classes a passenger car can reasonably use for evacuation. */
export const DRIVABLE_HIGHWAYS = new Set<string>(HIGHWAY_RANK);

export interface Route {
  segmentIds: string[];
  /** Sum of free-flow travel times along the chosen path. */
  travelSeconds: number;
  distanceKm: number;
  /** The worst road class on the path, so "this route needs a track" is visible. */
  slowestHighway: string;
  /** The segment that closes first relative to when the vehicle reaches it. */
  tightestEdgeId: string | null;
  /** Slack on that segment, seconds — zero means the plan has no margin anywhere. */
  tightestSlackSeconds: number | null;
}

/**
 * Walk the predecessor chain from `source` to a destination.
 *
 * Returns null when the node has no safe route, which is a first-class answer, not an
 * error: the caller reports `no_verified_action` rather than inventing a departure.
 */
export function routeTo(
  solve: SolveResult,
  graph: RoadGraph,
  cutAtSeconds: number[],
  source: number,
): Route | null {
  if (source < 0 || source >= graph.nodes.length) return null;
  if (!solve.reachable[source]) return null;

  const segmentIds: string[] = [];
  let travelSeconds = 0;
  let distanceKm = 0;
  let slowestHighway = '';
  let tightestEdgeId: string | null = null;
  let tightestSlack = Number.POSITIVE_INFINITY;

  const visited = new Set<number>([source]);
  let current = source;
  // Bounded by the node count: g strictly decreases along the chain whenever travel
  // times are positive, so this terminates; the guard covers zero-length edges.
  for (let hops = 0; hops <= graph.nodes.length; hops++) {
    const edgeIndex = solve.viaEdge[current];
    if (edgeIndex < 0) break;
    const edge = graph.edges[edgeIndex];
    segmentIds.push(edge.id);
    travelSeconds += edge.travelSeconds;
    distanceKm += polylineLengthMetres(edge.geometry) / 1000;
    if (HIGHWAY_RANK.indexOf(edge.highway) > HIGHWAY_RANK.indexOf(slowestHighway)) {
      slowestHighway = edge.highway;
    }
    // Slack measured against the cut time of the edge itself, which is the quantity a
    // driver actually experiences. Zero or negative means the plan has no margin.
    const slack = cutAtSeconds[edgeIndex] - edge.travelSeconds;
    if (slack < tightestSlack) {
      tightestSlack = slack;
      tightestEdgeId = edge.id;
    }
    current = edge.to;
    if (visited.has(current)) break;
    visited.add(current);
  }

  if (segmentIds.length === 0) return null;
  return {
    segmentIds,
    travelSeconds,
    distanceKm,
    slowestHighway,
    tightestEdgeId,
    tightestSlackSeconds: Number.isFinite(tightestSlack) ? tightestSlack : null,
  };
}

/**
 * The edge the convoy clears last: the one where the number of vehicles divided by the
 * road's throughput takes longest. This is the acceptance number in docs/work-plan.md —
 * "how long the population takes to clear each bottleneck" — and it is what decides
 * whether the departure band is achievable at all.
 */
export function bottleneckOf(
  route: Route,
  graph: RoadGraph,
  vehicles: number,
  capacityPerHourByHighway: Record<string, number>,
  defaultCapacityPerHour: number,
): { segmentId: string; clearMinutes: number } | null {
  const byId = new Map(graph.edges.map((e) => [e.id, e]));
  let worst: { segmentId: string; clearMinutes: number } | null = null;
  for (const id of route.segmentIds) {
    const edge = byId.get(id);
    if (!edge) continue;
    const capacity = capacityPerHourByHighway[edge.highway] ?? defaultCapacityPerHour;
    if (capacity <= 0) continue;
    const clearMinutes = (vehicles / capacity) * 60;
    if (worst === null || clearMinutes > worst.clearMinutes) worst = { segmentId: id, clearMinutes };
  }
  return worst;
}
