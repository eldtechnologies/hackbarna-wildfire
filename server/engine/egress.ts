// Assemble an EgressResponse: the banded cut field, the routes out of each pocket, and
// the last safe departure for each of them.
//
// Two things here are the difference between a tool and a hazard.
//
// 1. The cursor models *knowledge*, not physics. A road that will close in an hour reads
//    as open, because at the cursor nobody knows it will close. That is why the cut
//    field is masked to the cursor rather than the detections being filtered by it: at
//    18:00 a coordinator has the detections and the closures that have already happened,
//    and asking what they could have decided then is the whole point of the replay.
//
// 2. Detection latency is applied. The fire reaching a road at 19:38 and the coordinator
//    being able to act on that at 19:55 are different facts, and the spike is explicit
//    that it could not demonstrate lead time partly because it conflated them. The
//    physical cut time stays physical; a separate offset decides when it became known.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  CutTime,
  EgressAssumptions,
  EgressResponse,
  EgressRoute,
  PocketEgress,
  TimeBand,
} from '../../shared/egress';
import { detectionsFromCapture, groupClustersIntoEvents, loadCapture, pickEventForWindow } from './capture';
import { DEFAULT_GRAPH_PATH, loadGraph, nearestNode, type LoadedGraph } from './graph';
import type { Detection } from './mask';
import { allNodesSafe, latestDeparture, routeTo, type RoadGraph } from './solve';
import { NOMINAL_ID, SWEEP_CONFIGS, basisFor, sweepField } from './sweep';
import { DEFAULT_LATENCY_SECONDS, LATENCY_SECONDS, fromEpochMs, resolveTimelineOrigin } from './time';

const HERE = dirname(fileURLToPath(import.meta.url));
const CAPTURE_PATH = resolve(HERE, '../../data/snapshots/los-gallardos-2026-07-09.json');
const SETTLEMENTS_PATH = resolve(HERE, '../../data/pockets/settlements.json');

export interface Settlement {
  id: string;
  name: string;
  municipality: string;
  lat: number;
  lon: number;
  population: number | null;
  buildings: number;
}

/**
 * What the tool assumes. Printed beside every number it produces, because a departure
 * time without its assumptions is exactly the point estimate the spike showed is
 * indefensible. Occupancy and departure delay have no measurement behind them and are
 * labelled as assumptions wherever they surface.
 */
export const ASSUMPTIONS: Omit<EgressAssumptions, 'speedByHighway'> = {
  mobileFraction: 0.8,
  departureDelayMinutes: 15,
  vehicleOccupancy: 1.4,
};

interface Context {
  loaded: LoadedGraph;
  graph: RoadGraph;
  detections: Detection[];
  originMs: number;
  scenario: string;
  settlements: Settlement[];
  /** Per-edge latency of the detection that set the nominal cut, seconds. */
  nominalLatency: number[];
  sweep: ReturnType<typeof sweepField>;
}

let cached: Context | null = null;

/** Everything that does not depend on the cursor, built once. */
export function loadContext(graphPath: string = DEFAULT_GRAPH_PATH): Context {
  if (cached && graphPath === DEFAULT_GRAPH_PATH) return cached;

  const loaded = loadGraph(graphPath);
  const capture = loadCapture(JSON.parse(readFileSync(CAPTURE_PATH, 'utf8')));
  const originMs = resolveTimelineOrigin(
    capture.hotspots.map((h) => h.properties.observed_at ?? null),
    capture.window?.from,
  );
  if (originMs === null) throw new Error('capture has no usable timeline origin');

  // The fire is carried as two cluster ids — one all-geostationary, one all-polar — plus
  // three unrelated heat sources 20 km away. Grouping picks the fire and leaves the
  // decoys out; every detection in the bbox would paint cuts for a different fire.
  const events = groupClustersIntoEvents(capture.clusters, capture.hotspots);
  const fire = pickEventForWindow(events, capture.window?.from ?? '', capture.window?.to ?? '');
  if (!fire) throw new Error('no fire event found in the capture');
  const detections = detectionsFromCapture(capture, { clusterIds: new Set(fire.clusterIds), originMs });

  const settlements = (
    JSON.parse(readFileSync(SETTLEMENTS_PATH, 'utf8')) as { settlements: Settlement[] }
  ).settlements;

  const edgeGeometries = loaded.graph.edges.map((e) => e.geometry);
  const sweep = sweepField(edgeGeometries, loaded.graph.nodes, detections);

  const byId = new Map(detections.map((d) => [d.id, d]));
  const nominalLatency = sweep.field.nominalEvidence.map((ids) => {
    const first = ids[0];
    if (!first) return DEFAULT_LATENCY_SECONDS;
    const det = byId.get(first);
    if (!det) return DEFAULT_LATENCY_SECONDS;
    return LATENCY_SECONDS[det.source] ?? DEFAULT_LATENCY_SECONDS;
  });

  cached = {
    loaded, graph: loaded.graph, detections, originMs,
    scenario: capture.scenario, settlements, nominalLatency, sweep,
  };
  return cached;
}

export interface EgressOptions {
  /** Seconds since the scenario origin. Omitted serves the end of the window. */
  atSeconds?: number;
  graphPath?: string;
  /** Settlements to solve for, by id. Defaults to Bédar, the pocket the spike is about. */
  pocketIds?: string[];
}

export interface BuiltEgress {
  response: EgressResponse;
  /** Numbers the routes carry that the frozen contract has no field for yet. */
  diagnostics: {
    originIso: string;
    scenario: string;
    detections: number;
    windowEnd: string;
    /** Per configuration: how many detections it used, and the pocket's departure. */
    sweep: Array<{ id: string; label: string; detectionsUsed: number; departureSeconds: number | null }>;
  };
}

export function buildEgress(options: EgressOptions = {}): BuiltEgress {
  const ctx = loadContext(options.graphPath);
  const graph = ctx.graph;
  const origin = ctx.originMs;

  const windowEndSeconds =
    ctx.detections.length > 0 ? Math.max(...ctx.detections.map((d) => d.atSeconds)) + 3600 : 0;
  const cursor = options.atSeconds ?? windowEndSeconds;

  // The cut field as known at the cursor, per configuration.
  const knownCut = (configId: string): number[] => {
    const raw = ctx.sweep.cutByConfig.get(configId);
    const out = new Array<number>(graph.edges.length).fill(Number.POSITIVE_INFINITY);
    if (!raw) return out;
    for (let i = 0; i < out.length; i++) {
      const cut = raw[i];
      if (!Number.isFinite(cut)) continue;
      // Known only once the detection that produced it has arrived. The physical cut
      // time is unchanged; this decides whether anyone could have acted on it yet.
      if (cut + ctx.nominalLatency[i] <= cursor) out[i] = cut;
    }
    return out;
  };

  const nominalNodeCut = ctx.sweep.nodeCutByConfig.get(NOMINAL_ID) ?? allNodesSafe(graph.nodes.length);
  const settlementNodes = ctx.settlements.map((s) => ({
    settlement: s,
    node: nearestNode(graph, { lat: s.lat, lon: s.lon }),
  }));

  // A settlement the fire reaches is not a destination, however convenient.
  const safe = settlementNodes.filter(
    (s) => s.node !== null && nominalNodeCut[s.node] === Number.POSITIVE_INFINITY,
  );
  const destinations = new Set(
    (safe.length > 0 ? safe : settlementNodes)
      .map((s) => s.node)
      .filter((n): n is number => n !== null),
  );

  const pocketIds = options.pocketIds ?? ['bedar'];
  const pockets = ctx.settlements.filter((s) => pocketIds.includes(s.id));

  const segments: CutTime[] = graph.edges.map((edge, i) => {
    const cut = ctx.sweep.field.nominalCutAtSeconds[i];
    const earliest = ctx.sweep.field.earliestCutAtSeconds[i];
    const latest = ctx.sweep.field.latestCutAtSeconds[i];
    const banded = Number.isFinite(earliest) && Number.isFinite(latest);
    return {
      segmentId: edge.id,
      // null means never within the modelled window, which is a different statement
      // from "not yet" — the contract's own distinction, and it is kept here.
      cutAt: Number.isFinite(cut) ? fromEpochMs(origin + cut * 1000) : null,
      band: banded
        ? {
            earliest: fromEpochMs(origin + earliest * 1000),
            latest: fromEpochMs(origin + latest * 1000),
            basis: basisFor(ctx.sweep.field.earliestConfigId[i], ctx.sweep.field.latestConfigId[i]),
          }
        : null,
      evidenceHotspotIds: ctx.sweep.field.nominalEvidence[i] ?? [],
    };
  });

  const sweepDiagnostics: BuiltEgress['diagnostics']['sweep'] = [];
  const pocketResults: PocketEgress[] = [];

  for (const pocket of pockets) {
    const pocketNode = nearestNode(graph, { lat: pocket.lat, lon: pocket.lon });
    if (pocketNode === null) {
      pocketResults.push({ pocketId: pocket.id, routes: [], verdict: 'no_verified_action' });
      continue;
    }

    interface RouteAccumulator {
      departures: number[];
      configIds: string[];
      route: Omit<EgressRoute, 'lastSafeDeparture'> | null;
    }
    const byDestination = new Map<string, RouteAccumulator>();

    for (const config of SWEEP_CONFIGS) {
      const cuts = knownCut(config.id);
      const nodeCut = Array.from(
        ctx.sweep.nodeCutByConfig.get(config.id) ?? allNodesSafe(graph.nodes.length),
      );

      // Primary number: the latest departure to any safe destination.
      const primary = latestDeparture(graph, cuts, destinations, { nodeCutSeconds: nodeCut });
      sweepDiagnostics.push({
        id: config.id,
        label: config.label,
        detectionsUsed: ctx.sweep.usedByConfig.get(config.id) ?? 0,
        departureSeconds: Number.isFinite(primary.latestDeparture[pocketNode])
          ? primary.latestDeparture[pocketNode]
          : null,
      });

      // Per-destination detail, so each route can report its own band. The destination
      // set is small (four settlements), so one extra solve each is affordable.
      for (const { settlement, node } of settlementNodes) {
        if (node === null || !destinations.has(node)) continue;
        const solo = latestDeparture(graph, cuts, [node], { nodeCutSeconds: nodeCut });
        const value = solo.latestDeparture[pocketNode];
        if (!Number.isFinite(value)) continue;

        const acc = byDestination.get(settlement.id) ?? { departures: [], configIds: [], route: null };
        acc.departures.push(value);
        acc.configIds.push(config.id);
        if (acc.route === null) {
          const r = routeTo(solo, graph, cuts, pocketNode);
          if (r) {
            acc.route = {
              id: `${pocket.id}-${settlement.id}`,
              destination: settlement.name,
              segmentIds: r.segmentIds,
              distanceKm: Number(r.distanceKm.toFixed(2)),
              travelMinutes: Math.round(r.travelSeconds / 60),
            };
          }
        }
        byDestination.set(settlement.id, acc);
      }
    }

    const routes: EgressRoute[] = [];
    for (const [settlementId, acc] of byDestination) {
      if (acc.route === null || acc.departures.length === 0) continue;
      const minValue = Math.min(...acc.departures);
      const maxValue = Math.max(...acc.departures);
      const minIndex = acc.departures.indexOf(minValue);
      const maxIndex = acc.departures.indexOf(maxValue);
      const band: TimeBand = {
        earliest: fromEpochMs(origin + minValue * 1000),
        latest: fromEpochMs(origin + maxValue * 1000),
        basis: basisFor(acc.configIds[minIndex], acc.configIds[maxIndex]),
      };
      const settlement = ctx.settlements.find((s) => s.id === settlementId);
      routes.push({
        ...acc.route,
        destination: settlement?.name ?? acc.route.destination,
        // Null means the route is already cut at this cursor, which the contract
        // defines. An uncut route must never serialise as null via Infinity.
        lastSafeDeparture: maxValue >= cursor ? band : null,
      });
    }
    routes.sort((a, b) => a.destination.localeCompare(b.destination));

    // The gate is the PESSIMISTIC end of the band: a route counts as usable only if it
    // is still open under every configuration in the sweep. Gating on the encouraging
    // end is what reports a road as open when it may not be, and it is the choice that
    // kills people. It would also make a better demo, which is the trap.
    const usableRoutes = routes.filter(
      (r) =>
        r.lastSafeDeparture !== null &&
        Date.parse(r.lastSafeDeparture.earliest) / 1000 - origin / 1000 >= cursor,
    );
    const verdict: PocketEgress['verdict'] =
      usableRoutes.length > 0 ? 'routes_open' : 'no_verified_action';

    pocketResults.push({ pocketId: pocket.id, routes, verdict });
  }

  return {
    response: {
      provenance: 'replay',
      at: fromEpochMs(origin + cursor * 1000),
      assumptions: { ...ASSUMPTIONS, speedByHighway: ctx.loaded.speedByHighway },
      segments,
      pockets: pocketResults,
      fetchedAt: new Date().toISOString(),
    },
    diagnostics: {
      originIso: fromEpochMs(origin),
      scenario: ctx.scenario,
      detections: ctx.detections.length,
      windowEnd: fromEpochMs(origin + windowEndSeconds * 1000),
      sweep: sweepDiagnostics,
    },
  };
}
