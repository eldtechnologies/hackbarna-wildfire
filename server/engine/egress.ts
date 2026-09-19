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
import type { LatLon } from '../../shared/fires';
import { detectionsFromCapture, groupClustersIntoEvents, loadCapture, pickEventForWindow } from './capture';
import { DEFAULT_GRAPH_PATH, loadGraph, nearestNode, type LoadedGraph } from './graph';
import { subtractStaticHeatSources, type Detection } from './mask';
import { allNodesSafe, bottleneckOf, latestDeparture, routeTo, type RoadGraph, type Route } from './solve';
import { SWEEP_CONFIGS, basisFor, sweepField } from './sweep';
import { DEFAULT_LATENCY_SECONDS, LATENCY_SECONDS, fromEpochMs, resolveTimelineOrigin } from './time';

const HERE = dirname(fileURLToPath(import.meta.url));
const CAPTURE_PATH = resolve(HERE, '../../data/snapshots/los-gallardos-2026-07-09.json');
const SETTLEMENTS_PATH = resolve(HERE, '../../data/pockets/settlements.json');
const STATIC_HEAT_PATH = resolve(HERE, '../../data/fixtures/static-heat-sources.json');

interface StaticHeatFile {
  source: string;
  count: number;
  features: Array<{ geometry: { type: string; coordinates: unknown } | null }>;
}

/** Outer rings of the persistent-heat polygons, as LatLon. */
function staticHeatRings(path: string): LatLon[][] {
  let raw: StaticHeatFile;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8')) as StaticHeatFile;
  } catch (err) {
    // A missing fixture must not silently leave the flares in the mask.
    console.warn(`[engine] no static heat source fixture at ${path}; the mask will include them:`, err);
    return [];
  }
  const rings: LatLon[][] = [];
  for (const feature of raw.features ?? []) {
    const geom = feature.geometry;
    if (!geom) continue;
    const coords = geom.coordinates as number[][][] | number[][][][];
    if (!Array.isArray(coords)) continue;
    const outer = geom.type === 'Polygon'
      ? (coords as number[][][])[0]
      : (coords as number[][][][])[0]?.[0];
    if (!Array.isArray(outer)) continue;
    const ring = outer
      .filter((c) => Array.isArray(c) && c.length >= 2)
      .map(([lon, lat]) => ({ lat: Number(lat), lon: Number(lon) }))
      .filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon));
    if (ring.length >= 3) rings.push(ring);
  }
  return rings;
}

export interface Settlement {
  id: string;
  name: string;
  municipality: string;
  lat: number;
  lon: number;
  population: number | null;
  buildings: number;
  /**
   * Languages to broadcast in, derived per settlement rather than fixed. Bédar is in
   * Andalucía — Spanish and English, not Catalan — and `ca` belongs to the Castelltallat
   * scenario.
   */
  languages?: string[];
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
  /**
   * Vehicles per hour by road class. There is no measurement behind any of these — they
   * are order-of-magnitude figures for a single carriageway, and the clearance number
   * they produce is therefore an assumption, not a finding. Stated here so it is printed
   * beside every clearance figure rather than buried.
   */
  capacityPerHour: {
    motorway: 3600, trunk: 2400, primary: 1800, secondary: 1500, tertiary: 1200,
    unclassified: 900, residential: 600, living_street: 400, service: 300, track: 300, road: 600,
  },
};

const DEFAULT_CAPACITY_PER_HOUR = 600;

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
  /** Detections dropped for sitting on persistent industrial heat. */
  staticHeatRemoved: number;
  staticHeatPolygons: number;
  /** The cluster ids grouped into this fire. */
  fireClusterIds: string[];
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
  const raw = detectionsFromCapture(capture, { clusterIds: new Set(fire.clusterIds), originMs });

  // Persistent industrial heat is not fire. The archive carries cells around 18 MW
  // within about 20 km of Gallardos, and a mask built from raw detections would cut a
  // road on a gas flare. Measured on this capture the subtraction removes nothing —
  // none of the 2,660 fire detections falls inside a known source — so it does not move
  // the Bédar cut time, which is what decision 5 and decision 9 need in order not to
  // contradict each other.
  const heatRings = staticHeatRings(STATIC_HEAT_PATH);
  const { kept: detections, removed } = subtractStaticHeatSources(raw, heatRings);

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
    staticHeatRemoved: removed.length, staticHeatPolygons: heatRings.length,
    fireClusterIds: fire.clusterIds,
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
    /** Persistent-heat polygons loaded, and detections dropped for sitting on one. */
    staticHeat: { polygons: number; removed: number };
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

  const settlementNodes = ctx.settlements.map((s) => ({
    settlement: s,
    node: nearestNode(graph, { lat: s.lat, lon: s.lon }),
  }));

  // Every settlement is a candidate destination, and safety is enforced by the solve's
  // own node deadline rather than by filtering the list here.
  //
  // Pre-filtering to "settlements the fire never reaches in the window" looks tidier and
  // is wrong for this fire: it spreads over 10 July, so Los Gallardos and Lubrín are
  // both reached within 48 hours and both drop out — leaving Bédar able to evacuate only
  // east to Turre and Mojácar, which is not what happened and not what the model should
  // say. With the deadline in place the answer is right by construction: arriving at
  // Los Gallardos before the fire gets there on the 10th is fine, arriving after it is
  // refused, and neither needs a hand-maintained list.
  const destinations = new Set(
    settlementNodes.map((s) => s.node).filter((n): n is number => n !== null),
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
      /** The raw solve route, so the clearance calculation can reuse its segment list. */
      route: Route | null;
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
          const r = routeTo(solo, graph, cuts, pocketNode, [node]);
          if (r) acc.route = r;
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
      // The bypass gate: vehicles divided by the tightest road's throughput. It is what
      // turns a departure time into a question of whether the convoy can physically be
      // gone in time, and it is the acceptance number in docs/work-plan.md.
      const population = settlement?.population ?? null;
      let clearanceMinutes: number | null = null;
      let bottleneckSegmentId: string | null = null;
      if (population !== null && population > 0) {
        const vehicles = (population * ASSUMPTIONS.mobileFraction) / ASSUMPTIONS.vehicleOccupancy;
        const bottleneck = bottleneckOf(
          acc.route,
          graph,
          vehicles,
          ASSUMPTIONS.capacityPerHour,
          DEFAULT_CAPACITY_PER_HOUR,
        );
        if (bottleneck) {
          clearanceMinutes = Number(bottleneck.clearMinutes.toFixed(1));
          bottleneckSegmentId = bottleneck.segmentId;
        }
      }
      routes.push({
        id: `${pocket.id}-${settlementId}`,
        destination: settlement?.name ?? settlementId,
        segmentIds: acc.route.segmentIds,
        distanceKm: Number(acc.route.distanceKm.toFixed(2)),
        travelMinutes: Math.round(acc.route.travelSeconds / 60),
        slowestHighway: acc.route.slowestHighway,
        clearanceMinutes,
        bottleneckSegmentId,
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
      fireId: ctx.scenario,
      clusterIds: ctx.fireClusterIds,
      origin: fromEpochMs(origin),
      segments,
      pockets: pocketResults,
      fetchedAt: new Date().toISOString(),
    },
    diagnostics: {
      originIso: fromEpochMs(origin),
      scenario: ctx.scenario,
      detections: ctx.detections.length,
      windowEnd: fromEpochMs(origin + windowEndSeconds * 1000),
      staticHeat: { polygons: ctx.staticHeatPolygons, removed: ctx.staticHeatRemoved },
      sweep: sweepDiagnostics,
    },
  };
}
