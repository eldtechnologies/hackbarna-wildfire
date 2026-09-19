import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  latestDeparture,
  allNodesSafe,
  routeTo,
  bottleneckOf,
  type Edge,
  type RoadGraph,
} from './solve';
import { polylineLengthMetres } from './geometry';
import type { LatLon } from '../../shared/fires';

const NEVER = Number.POSITIVE_INFINITY;

interface Spec {
  from: number;
  to: number;
  seconds: number;
  /** Seconds since origin at which the fire reaches this edge. */
  cut: number;
  id?: string;
  highway?: string;
  /** Edge length in degrees of longitude. Explicit so a spec can be reordered. */
  lonSpan?: number;
}

/**
 * Build a graph from an edge list. Node coordinates are laid out so that edge lengths
 * increase with the edge's index in `spec`, which makes the length tie-break testable.
 */
function makeGraph(nodeCount: number, spec: Spec[]): RoadGraph {
  const nodes: LatLon[] = Array.from({ length: nodeCount }, (_, i) => ({ lat: 37 + i * 1e-6, lon: -2 }));
  const edges: Edge[] = spec.map((s, i) => ({
    id: s.id ?? `e${i}`,
    from: s.from,
    to: s.to,
    // Length comes from the spec, not the index, so reordering a spec does not
    // silently change the geometry and make an order-independence test vacuous.
    geometry: [
      { lat: 37 + s.from * 1e-6, lon: -2 },
      { lat: 37 + s.from * 1e-6, lon: -2 + (s.lonSpan ?? (i + 1) * 1e-4) },
    ],
    highway: s.highway ?? 'tertiary',
    name: null,
    travelSeconds: s.seconds,
  }));
  const outgoing: number[][] = Array.from({ length: nodeCount }, () => []);
  const incoming: number[][] = Array.from({ length: nodeCount }, () => []);
  edges.forEach((e, i) => {
    outgoing[e.from].push(i);
    incoming[e.to].push(i);
  });
  return { nodes, edges, outgoing, incoming };
}

const cutsOf = (spec: Spec[]): number[] => spec.map((s) => s.cut);
const cutIndex = (spec: Spec[]): Map<string, number> => new Map(spec.map((s, i) => [s.id ?? `e${i}`, i]));

/**
 * The definition, evaluated exhaustively: over every simple path from `source` to a
 * destination, the latest departure is the largest t such that the vehicle reaches the
 * head of every edge on the path before that edge is cut.
 *
 *     t <= cut(e_i) - T_i     for every edge, where T_i is the running travel time
 *
 * plus the destination's own deadline. This is the yardstick the Dijkstra must match.
 */
function bruteForce(
  graph: RoadGraph,
  cutAtSeconds: number[],
  destinations: Set<number>,
  source: number,
  nodeCut: number[] = allNodesSafe(graph.nodes.length),
): number {
  let best = Number.NEGATIVE_INFINITY;
  const stack: Array<{ node: number; seen: Set<number>; elapsed: number; cap: number }> = [
    { node: source, seen: new Set([source]), elapsed: 0, cap: NEVER },
  ];
  while (stack.length > 0) {
    const { node, seen, elapsed, cap } = stack.pop()!;
    if (destinations.has(node)) {
      best = Math.max(best, Math.min(cap, nodeCut[node] - elapsed));
      continue;
    }
    for (const edgeIndex of graph.outgoing[node]) {
      const edge = graph.edges[edgeIndex];
      if (seen.has(edge.to)) continue;
      const nextElapsed = elapsed + edge.travelSeconds;
      const nextCap = Math.min(cap, cutAtSeconds[edgeIndex] - nextElapsed);
      const nextSeen = new Set(seen);
      nextSeen.add(edge.to);
      stack.push({ node: edge.to, seen: nextSeen, elapsed: nextElapsed, cap: nextCap });
    }
  }
  return best;
}

const same = (a: number, b: number): boolean =>
  Number.isFinite(a) || Number.isFinite(b) ? a === b : a === b;

test('the worked case: the longer detour wins', () => {
  // 0->1->3 closes early at 1; 0->2->3 is longer but the road stays open.
  const spec: Spec[] = [
    { from: 0, to: 1, seconds: 10, cut: 60 },
    { from: 1, to: 3, seconds: 15, cut: 90 },
    { from: 0, to: 2, seconds: 10, cut: 120 },
    { from: 2, to: 3, seconds: 25, cut: 90 },
  ];
  const graph = makeGraph(4, spec);
  const cuts = cutsOf(spec);
  const solve = latestDeparture(graph, cuts, [3]);

  assert.equal(solve.latestDeparture[0], 55);
  assert.equal(solve.latestDeparture[1], 75);
  assert.equal(solve.latestDeparture[2], 65);
  assert.equal(solve.latestDeparture[3], NEVER);

  // The optimum goes via node 2, which is the slow road.
  const route = routeTo(solve, graph, cuts, 0)!;
  assert.deepEqual(route.segmentIds, ['e2', 'e3']);
  assert.equal(bruteForce(graph, cuts, new Set([3]), 0), 55);
});

test('waiting at an intermediate node is implicit, and the no-waiting answer differs', () => {
  // Reaching B early and leaving late is allowed because feasibility at B depends only
  // on the arrival time. An implementation that chains departures without slack gets
  // g(A) = 1380 here instead of 940.
  const spec: Spec[] = [
    { from: 0, to: 1, seconds: 60, cut: 1000, id: 'AB' },
    { from: 1, to: 2, seconds: 60, cut: 2000, id: 'BC' },
    { from: 1, to: 3, seconds: 60, cut: 1500, id: 'BD' },
    { from: 3, to: 1, seconds: 60, cut: 1500, id: 'DB' },
  ];
  const graph = makeGraph(4, spec);
  const cuts = cutsOf(spec);
  const solve = latestDeparture(graph, cuts, [2]);

  assert.equal(solve.latestDeparture[2], NEVER);
  assert.equal(solve.latestDeparture[3], 1440);
  assert.equal(solve.latestDeparture[1], 1940);
  assert.equal(solve.latestDeparture[0], 940);
  assert.equal(bruteForce(graph, cuts, new Set([2]), 0), 940);
});

test('a destination that burns later still stops being safe', () => {
  // Arriving at a village twenty minutes before it burns is not arriving safely. The
  // deadline comes from the node's own cut time, which the mask computes separately
  // from the edge cuts — a road can be cut at its far end without the village burning.
  // Both roads stay open all evening, so only the destination's own deadline binds.
  const spec: Spec[] = [
    { from: 0, to: 1, seconds: 600, cut: 5000, id: 'AB' },
    { from: 1, to: 2, seconds: 600, cut: 5000, id: 'BC' },
  ];
  const graph = makeGraph(3, spec);
  const cuts = cutsOf(spec);

  // The village is reached by the fire at 2000, so the vehicle must arrive before then.
  const nodeCut = [NEVER, NEVER, 2000];
  const withDeadline = latestDeparture(graph, cuts, [2], { nodeCutSeconds: nodeCut });
  assert.equal(withDeadline.latestDeparture[0], 800, 'must arrive at node 2 by 2000');
  assert.equal(bruteForce(graph, cuts, new Set([2]), 0, nodeCut), 800);

  // Told the village is never reached, the same graph allows the full evening.
  const withoutDeadline = latestDeparture(graph, cuts, [2]);
  assert.equal(withoutDeadline.latestDeparture[0], 3800);
  assert.notEqual(withDeadline.latestDeparture[0], withoutDeadline.latestDeparture[0],
    'the deadline must actually change the answer');
});

test('an edge cut at its far end does not close the node at its near end', () => {
  // The bug this guards: deriving a node's cut time from its incident edges. A disc
  // over the far end of a long road cuts the road, not the village it leads from.
  const spec: Spec[] = [
    { from: 0, to: 1, seconds: 600, cut: 100, id: 'long' },
    { from: 1, to: 2, seconds: 600, cut: NEVER, id: 'on' },
  ];
  const graph = makeGraph(3, spec);
  const cuts = cutsOf(spec);
  // Node 0's own cut stays Infinity even though 'long' is cut at 100.
  const nodeCut = [NEVER, NEVER, NEVER];
  const solve = latestDeparture(graph, cuts, [2], { nodeCutSeconds: nodeCut });
  assert.equal(solve.latestDeparture[2], NEVER);
  assert.equal(solve.latestDeparture[1], NEVER);
  // Node 0 is bounded by edge 'long' itself, not by any node deadline.
  assert.equal(solve.latestDeparture[0], 100 - 600);
});

test('an unreachable destination is null-like, never a plausible finite number', () => {
  const spec: Spec[] = [{ from: 0, to: 1, seconds: 600, cut: NEVER }];
  const graph = makeGraph(4, spec);
  const cuts = cutsOf(spec);
  const solve = latestDeparture(graph, cuts, [3]);

  assert.equal(solve.latestDeparture[0], Number.NEGATIVE_INFINITY);
  assert.equal(solve.reachable[0], false);
  assert.equal(routeTo(solve, graph, cuts, 0), null, 'no route is a first-class answer');
  assert.equal(bruteForce(graph, cuts, new Set([3]), 0), Number.NEGATIVE_INFINITY);
});

test('a pocket with no outgoing edge is unreachable, not infinite', () => {
  // Bédar's dispersed sierra dwellings will produce this: a Catastro cluster whose
  // centroid has no road within the snap radius.
  const spec: Spec[] = [
    { from: 1, to: 2, seconds: 600, cut: NEVER },
    { from: 2, to: 3, seconds: 600, cut: NEVER },
  ];
  const graph = makeGraph(4, spec);
  const cuts = cutsOf(spec);
  const solve = latestDeparture(graph, cuts, [3]);
  assert.equal(solve.latestDeparture[0], Number.NEGATIVE_INFINITY);
  assert.equal(routeTo(solve, graph, cuts, 0), null);
});

test('a never-cut network allows an unbounded departure, which must be clamped before serialising', () => {
  const spec: Spec[] = [
    { from: 0, to: 1, seconds: 600, cut: NEVER },
    { from: 1, to: 2, seconds: 600, cut: NEVER },
  ];
  const graph = makeGraph(3, spec);
  const solve = latestDeparture(graph, cutsOf(spec), [2]);
  assert.equal(solve.latestDeparture[0], NEVER);
  // JSON.stringify turns Infinity into null, and null means "already cut" in the
  // contract — the safest state would render as the most alarming one.
  assert.equal(JSON.stringify({ v: solve.latestDeparture[0] }), '{"v":null}');
});

test('self-loops cannot improve a label and cannot hang the walk', () => {
  const base: Spec[] = [
    { from: 0, to: 1, seconds: 600, cut: NEVER, id: 'AB' },
    { from: 1, to: 2, seconds: 600, cut: NEVER, id: 'BC' },
  ];
  const graph = makeGraph(3, base);
  const plain = latestDeparture(graph, cutsOf(base), [2]);

  const looped: Spec[] = [...base, { from: 1, to: 1, seconds: 60, cut: 100, id: 'BB' }];
  const loopGraph = makeGraph(3, looped);
  const withLoop = latestDeparture(loopGraph, cutsOf(looped), [2]);

  assert.deepEqual(withLoop.latestDeparture, plain.latestDeparture, 'a self-loop changes nothing');
  const route = routeTo(withLoop, loopGraph, cutsOf(looped), 0)!;
  assert.ok(!route.segmentIds.includes('BB'));
});

test('a route reports the worst road class it needs', () => {
  const spec: Spec[] = [
    { from: 0, to: 1, seconds: 600, cut: NEVER, highway: 'tertiary' },
    { from: 1, to: 2, seconds: 600, cut: NEVER, highway: 'track' },
    { from: 2, to: 3, seconds: 600, cut: NEVER, highway: 'primary' },
  ];
  const graph = makeGraph(4, spec);
  const cuts = cutsOf(spec);
  const route = routeTo(latestDeparture(graph, cuts, [3]), graph, cuts, 0)!;
  assert.equal(route.slowestHighway, 'track', 'a route that needs a track must say so');
});

test('the bottleneck is the slowest-to-clear segment, in minutes', () => {
  const spec: Spec[] = [
    { from: 0, to: 1, seconds: 60, cut: NEVER, id: 'a', highway: 'primary' },
    { from: 1, to: 2, seconds: 60, cut: NEVER, id: 'b', highway: 'track' },
  ];
  const graph = makeGraph(3, spec);
  const cuts = cutsOf(spec);
  const route = routeTo(latestDeparture(graph, cuts, [2]), graph, cuts, 0)!;
  // 545 vehicles at 1200/h on the primary is 27.25 min; at 300/h on the track, 109 min.
  const bottleneck = bottleneckOf(route, graph, 545, { primary: 1200, track: 300 }, 600)!;
  assert.equal(bottleneck.segmentId, 'b');
  assert.ok(Math.abs(bottleneck.clearMinutes - 109) < 0.5, `got ${bottleneck.clearMinutes}`);
});

test('the tie-break is total: two identical calls pick the same road', () => {
  // Two routes to the destination with the same departure time and travel time, so
  // only the comparator decides. Without one, the road named in the alert can differ
  // between calls, or between sweep configurations.
  // The 'a' route is the shorter one, so the comparator must pick it in both orders.
  const spec: Spec[] = [
    { from: 0, to: 1, seconds: 600, cut: 3000, id: 'a1', lonSpan: 1e-4 },
    { from: 1, to: 3, seconds: 600, cut: 3000, id: 'a2', lonSpan: 1e-4 },
    { from: 0, to: 2, seconds: 600, cut: 3000, id: 'b1', lonSpan: 3e-4 },
    { from: 2, to: 3, seconds: 600, cut: 3000, id: 'b2', lonSpan: 3e-4 },
  ];
  const graph = makeGraph(4, spec);
  const cuts = cutsOf(spec);
  const first = routeTo(latestDeparture(graph, cuts, [3]), graph, cuts, 0)!;
  const second = routeTo(latestDeparture(graph, cuts, [3]), graph, cuts, 0)!;
  assert.deepEqual(first.segmentIds, second.segmentIds);
  // Edge order in the input must not change the answer either.
  const reversed: Spec[] = [...spec].reverse();
  const rGraph = makeGraph(4, reversed);
  const rCuts = cutsOf(reversed);
  const rRoute = routeTo(latestDeparture(rGraph, rCuts, [3]), rGraph, rCuts, 0)!;
  assert.deepEqual(rRoute.segmentIds, first.segmentIds);
});

test('raising a cut time never lowers any departure (monotonicity)', () => {
  // The property that makes the sweep's envelope well behaved: g is non-decreasing in
  // every c(e), so the per-configuration band cannot invert.
  const spec: Spec[] = [
    { from: 0, to: 1, seconds: 10, cut: 100 },
    { from: 1, to: 3, seconds: 15, cut: 200 },
    { from: 0, to: 2, seconds: 20, cut: 150 },
    { from: 2, to: 3, seconds: 25, cut: 400 },
  ];
  const graph = makeGraph(4, spec);
  const base = cutsOf(spec);
  const before = latestDeparture(graph, base, [3]).latestDeparture;

  for (let i = 0; i < base.length; i++) {
    const raised = base.map((c, j) => (j === i ? c + 1 : c));
    const after = latestDeparture(graph, raised, [3]).latestDeparture;
    for (let n = 0; n < before.length; n++) {
      assert.ok(
        after[n] >= before[n] - 1e-9,
        `raising cut ${i} lowered node ${n}: ${before[n]} -> ${after[n]}`,
      );
    }
  }
});

test('the recurrence matches exhaustive path enumeration on random graphs', () => {
  // The independent check. An earlier version relaxed along outgoing edges instead of
  // incoming ones and disagreed on 2,419 of 4,000 graphs; this is the test that caught
  // it, kept in the repository so the direction cannot silently regress.
  let seed = 12345;
  const rand = (n: number): number => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed % n;
  };
  let checked = 0;

  for (let trial = 0; trial < 9000; trial++) {
    const nodeCount = 2 + rand(6);
    const edgeCount = 1 + rand(12);
    const spec: Spec[] = [];
    for (let e = 0; e < edgeCount; e++) {
      const from = rand(nodeCount);
      const to = rand(nodeCount);
      if (from === to) continue;
      spec.push({
        from,
        to,
        seconds: [1, 2, 3, 5, 10][rand(5)],
        cut: rand(4) === 0 ? NEVER : rand(40),
      });
    }
    if (spec.length === 0) continue;
    const graph = makeGraph(nodeCount, spec);
    const cuts = cutsOf(spec);
    const destination = nodeCount - 1;
    const viaDijkstra = latestDeparture(graph, cuts, [destination]).latestDeparture[0];
    const viaPaths = bruteForce(graph, cuts, new Set([destination]), 0);
    checked += 1;
    assert.ok(
      same(viaDijkstra, viaPaths),
      `trial ${trial}: dijkstra=${viaDijkstra} brute=${viaPaths} spec=${JSON.stringify(spec)}`,
    );
  }
  // The value of this test is the zero mismatches above, not the count; the count only
  // proves the generator produced a meaningful sample rather than mostly-empty graphs.
  assert.ok(checked > 2500, `expected a few thousand usable graphs, checked ${checked}`);
});

test('polyline length is used for the distance tie-break, not the hop count', () => {
  const spec: Spec[] = [
    { from: 0, to: 1, seconds: 10, cut: NEVER, id: 'short' },
    { from: 1, to: 2, seconds: 10, cut: NEVER, id: 'long' },
  ];
  const graph = makeGraph(3, spec);
  assert.ok(polylineLengthMetres(graph.edges[1].geometry) > polylineLengthMetres(graph.edges[0].geometry));
  const index = cutIndex(spec);
  assert.equal(index.get('short'), 0);
  assert.equal(index.get('long'), 1);
});
