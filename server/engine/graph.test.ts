import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadGraph, topology, nearestNode, DEFAULT_GRAPH_PATH } from './graph';
import { HIGHWAY_RANK } from './solve';

// graph.ts had no test file: its invariants were only ever observed through the pipeline,
// where a broken graph surfaces as a route that goes the long way round rather than as a
// failure. The topology check is the thing that catches it, and it had no caller at all.

test('the committed graph loads and is one connected road network', () => {
  const { graph, speedByHighway } = loadGraph();
  const report = topology(graph);

  assert.ok(report.nodes > 10_000, `expected a real network, got ${report.nodes} nodes`);
  assert.ok(report.edges >= report.nodes, 'a road network has at least as many edges as nodes');

  // The failure this guards actually happened: keying nodes on way endpoints instead of
  // on every shared vertex produced 1,695 components with the largest holding a fifth of
  // the nodes, and no routing test caught it because one reachable destination is enough
  // for the solve to return an answer.
  assert.ok(
    report.largestComponent / report.nodes > 0.9,
    `only ${((report.largestComponent / report.nodes) * 100).toFixed(1)}% of nodes are in one component`,
  );
  assert.ok(report.components < 100, `${report.components} components is a fragmented graph, not a road network`);

  assert.ok(Object.keys(speedByHighway).length > 0, 'the graph must carry a speed table');
});

test('every edge carries a usable travel time and a known road class', () => {
  // travelSeconds drives the solve's monotonicity argument: a negative or zero value
  // breaks the settling order, and a zero one yields a drive of no duration.
  const { graph } = loadGraph();
  let checked = 0;
  for (const edge of graph.edges) {
    assert.ok(edge.travelSeconds >= 1, `${edge.id} has travelSeconds ${edge.travelSeconds}`);
    assert.ok(Number.isFinite(edge.travelSeconds));
    assert.ok(HIGHWAY_RANK.includes(edge.highway), `${edge.id} has class "${edge.highway}"`);
    assert.notEqual(edge.from, edge.to, `${edge.id} is a self-loop`);
    assert.ok(edge.geometry.length >= 2, `${edge.id} has a degenerate geometry`);
    checked += 1;
  }
  assert.ok(checked > 0, 'the graph must have edges');
});

test('a reversed edge walks its shared geometry backwards', () => {
  // Geometry rows are shared between an edge and its reverse, and the loader flips them.
  // A missed flip reports a back-edge's distance walked the wrong way and its segment
  // list read backwards along the road.
  const { graph } = loadGraph();
  const forward = graph.edges.find((e) => !e.id.endsWith('#rev') && e.geometry.length > 2);
  assert.ok(forward, 'expected at least one multi-vertex forward edge');
  const reverse = graph.edges.find((e) => e.id === `${forward.id}#rev`);
  assert.ok(reverse, 'every forward edge in a bidirectional pair has a reverse');

  assert.deepEqual(reverse.from, forward.to);
  assert.deepEqual(reverse.to, forward.from);
  assert.deepEqual(
    reverse.geometry[0],
    forward.geometry[forward.geometry.length - 1],
    'the reverse edge must start where the forward one ends',
  );
});

test('a graph file with an out-of-range node id is refused rather than silently thinned', () => {
  // Silently dropping such an edge quietly disconnects the network; the loader counts
  // them and says so.
  const dir = mkdtempSync(join(tmpdir(), 'graph-'));
  const file = join(dir, 'broken.json');
  writeFileSync(file, JSON.stringify({
    source: 'test', fetched: '2026-09-19', bbox: [0, 0, 0, 0], speedByHighway: {},
    nodes: [[37, -2], [37.001, -2]],
    geometries: [[[37, -2], [37.001, -2]]],
    edges: [
      { id: 'ok', from: 0, to: 1, highway: 'tertiary', name: null, travelSeconds: 60, geometryIndex: 0, reversed: false },
      { id: 'bad', from: 0, to: 99, highway: 'tertiary', name: null, travelSeconds: 60, geometryIndex: 0, reversed: false },
    ],
    outgoing: [[0, 1], []], incoming: [[], [0, 1]],
  }));
  const { graph } = loadGraph(file);
  assert.equal(graph.edges.length, 1, 'the dangling edge is dropped, not the whole file');
  assert.equal(graph.edges[0].id, 'ok');
});

test('nearestNode snaps to the closest node and reports nothing for an empty graph', () => {
  const { graph } = loadGraph();
  const bedar = nearestNode(graph, { lat: 37.1909, lon: -1.9806 });
  assert.ok(bedar !== null);
  const node = graph.nodes[bedar];
  const metres = Math.hypot((node.lat - 37.1909) * 110977, (node.lon + 1.9806) * 88970);
  assert.ok(metres < 100, `Bédar snapped ${metres.toFixed(0)} m away`);

  assert.equal(nearestNode({ nodes: [], edges: [], outgoing: [], incoming: [] }, { lat: 0, lon: 0 }), null);
});

test('the default graph path resolves from the module, not the working directory', () => {
  // Resolving from process.cwd() works from the repo root and fails everywhere else,
  // which is the deployment case the path exists to survive.
  assert.ok(DEFAULT_GRAPH_PATH.endsWith('data/graph/los-gallardos.json'));
  assert.ok(DEFAULT_GRAPH_PATH.startsWith('/'), 'the path must be absolute');
  assert.ok(loadGraph(DEFAULT_GRAPH_PATH).graph.nodes.length > 0);
});
