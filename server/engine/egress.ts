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

import { existsSync, readFileSync } from 'node:fs';
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
import { loadPocketGeometry } from './pockets';
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
  sweep: ReturnType<typeof sweepField>;
  /** Detections dropped for sitting on persistent industrial heat. */
  staticHeatRemoved: number;
  staticHeatPolygons: number;
  /** False when the fixture is missing, which is different from a fixture with no polygons. */
  heatFixtureLoaded: boolean;
  /** The cluster ids grouped into this fire. */
  fireClusterIds: string[];
}

let cached: Context | null = null;
/** The path the cache was built from. Without this the guard checked the *requested*
 * path, so loading a custom graph and then asking for the default returned the custom
 * one — a caller silently solving on the wrong road network. */
let cachedPath: string | null = null;

/** Everything that does not depend on the cursor, built once. */
export function loadContext(graphPath: string = DEFAULT_GRAPH_PATH): Context {
  if (cached && cachedPath === graphPath) return cached;

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
  // Zero polygons is either a loaded-but-empty fixture or a missing one, and the two
  // mean different things, so the count alone does not settle it.
  const heatFixtureLoaded = heatRings.length > 0 || existsSync(STATIC_HEAT_PATH);
  const { kept: detections, removed } = subtractStaticHeatSources(raw, heatRings);

  // A fire event with no usable detections is a broken input, not a quiet fire.
  //
  // Without this the pipeline degrades exactly the wrong way: an empty mask gives every
  // node an infinite cut time, `fireReaches` reads false, and the engine emits
  // `no_action` — "No action is required in Bédar at this time" — from a mask that
  // cannot see anything. Measured on the real capture: strip the UTC offset from every
  // `observed_at` and 0 of 2,743 records survive, which is a valid-looking capture that
  // produces a confident all-clear. The `originMs === null` guard below does not catch
  // it, because the declared window still parses.
  if (detections.length === 0) {
    throw new Error(
      `fire event ${fire.clusterIds.join(', ')} yielded no usable detections out of ` +
        `${capture.hotspots.length} in the capture; refusing to compute a cut field from an empty mask`,
    );
  }

  // Building counts come from the Catastro fixture rather than being duplicated into
  // settlements.json, so the two cannot drift. When the fixture is absent the count stays
  // at zero, which is a count we do not have rather than one we measured.
  const geometry = loadPocketGeometry();
  const settlements = (
    JSON.parse(readFileSync(SETTLEMENTS_PATH, 'utf8')) as { settlements: Settlement[] }
  ).settlements.map((s) => {
    const g = geometry.get(s.id);
    return g ? { ...s, buildings: g.buildings } : s;
  });

  const edgeGeometries = loaded.graph.edges.map((e) => e.geometry);
  const latencyOf = (source: string): number => LATENCY_SECONDS[source] ?? DEFAULT_LATENCY_SECONDS;
  const sweep = sweepField(
    edgeGeometries,
    loaded.graph.nodes,
    detections,
    undefined,
    latencyOf,
    // So the `all-1x-withstatic` configuration actually runs against the unsubtracted
    // set rather than being a second copy of the nominal one.
    raw,
  );

  cached = {
    loaded, graph: loaded.graph, detections, originMs,
    scenario: capture.scenario, settlements, sweep,
    staticHeatRemoved: removed.length, staticHeatPolygons: heatRings.length, heatFixtureLoaded,
    fireClusterIds: fire.clusterIds,
  };
  cachedPath = graphPath;
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
    staticHeat: { polygons: number; removed: number; fixtureLoaded: boolean };
    /** Per configuration: how many detections it used, and the pocket's departure. */
    sweep: Array<{ id: string; label: string; detectionsUsed: number; departureSeconds: number | null }>;
  };
}

/**
 * A departure as the diagnostics publish it.
 *
 * Two unbounded cases that the raw value does not distinguish: `+Infinity` means no
 * configuration closes any route inside the window, so the honest reading is the end of
 * the modelled window — the same clamp the route bands use for their pessimistic end.
 * `-Infinity` means no route exists at all, which is the only true "no departure", and
 * `null` is reserved for it. Publishing `+Infinity` as `null` inverted the meaning, the
 * same way serialising an infinite departure would have.
 */
function departureFor(value: number, windowEndSeconds: number): number | null {
  if (value === Number.NEGATIVE_INFINITY) return null;
  return Math.min(value, windowEndSeconds);
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
    const latency = ctx.sweep.latencyByConfig.get(configId);
    const out = new Array<number>(graph.edges.length).fill(Number.POSITIVE_INFINITY);
    if (!raw) return out;
    for (let i = 0; i < out.length; i++) {
      const cut = raw[i];
      if (!Number.isFinite(cut)) continue;
      // Known only once the detection that produced it has arrived, and under this
      // configuration that is not necessarily the detection the nominal one used — the
      // two disagree on a large share of cut edges, by up to hours where a polar
      // detection replaces a geostationary one.
      const wait = latency ? latency[i] : DEFAULT_LATENCY_SECONDS;
      if (cut + wait <= cursor) out[i] = cut;
    }
    return out;
  };

  // Has the engine been told anything at all by this cursor? A detection is in hand once
  // it has been observed and its delivery latency has elapsed, which is the same rule the
  // two masks above apply — asked here as a question about the data rather than about the
  // road, because "no road is cut" and "nothing has been reported" are different states
  // and only one of them is evidence that the road is open.
  const anyObserved = ctx.detections.some(
    (d) => d.atSeconds + (LATENCY_SECONDS[d.source] ?? DEFAULT_LATENCY_SECONDS) <= cursor,
  );

  // The node field is masked to the cursor exactly like the edge field above, and for
  // the same reason. The cursor models what the coordinator knew, not what the fire did.
  // Left raw, a destination's own burn time — a 10 July arrival that no sensor had
  // reported at cursor 0 — was enforced as a deadline, so the band at early cursors was
  // bounded by evidence the replay itself says was not yet in hand.
  //
  // `latencyByConfig` covers nodes as well as edges: it is sized segments + nodes, with
  // node j at segments + j, matching how `nodeCutByConfig` is sliced.
  const knownNodeCut = (configId: string): number[] => {
    const raw = ctx.sweep.nodeCutByConfig.get(configId);
    const latency = ctx.sweep.latencyByConfig.get(configId);
    const offset = graph.edges.length;
    const out = allNodesSafe(graph.nodes.length);
    if (!raw) return out;
    for (let i = 0; i < out.length; i++) {
      const cut = raw[i];
      if (!Number.isFinite(cut)) continue;
      const wait = latency ? latency[offset + i] : DEFAULT_LATENCY_SECONDS;
      if (cut + wait <= cursor) out[i] = cut;
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
      const nodeCut = knownNodeCut(config.id);

      // The pocket is not a destination for its own residents. Including it does not
      // merely add a zero-length route: with the node deadline in place the solve's value
      // at the pocket is at least the pocket's own burn time, so the number published as
      // this configuration's departure was the moment the fire reaches the village — 134 s
      // later than every route the same response publishes, in the permissive direction.
      const escapeNodes = new Set([...destinations].filter((n) => n !== pocketNode));

      // Primary number: the latest departure to any destination that is not the pocket.
      const primary = latestDeparture(graph, cuts, escapeNodes, { nodeCutSeconds: nodeCut });
      sweepDiagnostics.push({
        id: config.id,
        label: config.label,
        detectionsUsed: ctx.sweep.usedByConfig.get(config.id) ?? 0,
        departureSeconds: departureFor(primary.latestDeparture[pocketNode], windowEndSeconds),
      });

      // Per-destination detail, so each route can report its own band. The destination
      // set is small (four settlements), so one extra solve each is affordable.
      for (const { settlement, node } of settlementNodes) {
        if (node === null || !destinations.has(node)) continue;
        const solo = latestDeparture(graph, cuts, [node], { nodeCutSeconds: nodeCut });
        const value = solo.latestDeparture[pocketNode];
        // Infinity is a real answer — nothing on this route is ever cut under this
        // configuration — and skipping it silently dropped whole configurations from
        // the band while the published basis still claimed all twelve contributed.
        // Only -Infinity, which means no route at all, is a non-answer.
        if (value === Number.NEGATIVE_INFINITY) continue;

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
      // The band is the envelope of whole solves: each end is attained by one named
      // configuration, so the basis can say which. A per-segment mixture would be
      // attained by nothing, and in a bottleneck problem its pessimism is contagious.
      //
      // Infinity means "nothing on this route is ever cut within the window". When the
      // pessimistic end is itself unbounded, `earliest` is pinned to the end of the
      // modelled window — the honest reading is "no departure deadline exists inside the
      // window" — and `latest` becomes null, which the contract added for exactly this.
      const neverClosed = !Number.isFinite(minValue);
      const band: TimeBand = {
        earliest: fromEpochMs(origin + Math.min(minValue, windowEndSeconds) * 1000),
        latest: Number.isFinite(maxValue) ? fromEpochMs(origin + maxValue * 1000) : null,
        basis: neverClosed
          ? `no configuration closes this route inside the modelled window ` +
            `(all ${acc.departures.length} of ${SWEEP_CONFIGS.length} unbounded); ` +
            'earliest is the end of the window, not a departure deadline'
          : basisFor(acc.configIds[minIndex], acc.configIds[maxIndex], acc.departures.length),
      };
      const settlement = ctx.settlements.find((s) => s.id === settlementId);
      // The bypass gate: vehicles divided by the tightest road's throughput. It is what
      // turns a departure time into a question of whether the convoy can physically be
      // gone in time, and it is the acceptance number in docs/work-plan.md.
      //
      // The population is the POCKET's, not the destination's. Using the destination's
      // made Bédar's 953 residents clear at Mojácar's 7,680 rate and reported a
      // fourteen-hour clearance for a village of under a thousand — an eight-fold error
      // in the number the acceptance criterion is written around.
      const population = pocket.population ?? null;
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
        // Filled by the gate below; the object is pushed with the provisional values so
        // the gate reads the same shape the response will.
        usable: true,
        unusableReason: null,
        // Null means the route is already cut at this cursor, which the contract
        // defines. An uncut route must never serialise as null via Infinity.
        lastSafeDeparture: maxValue >= cursor ? band : null,
      });
    }
    routes.sort((a, b) => a.destination.localeCompare(b.destination));

    // The gate is the PESSIMISTIC end of the band, and it is a gate on the DECISION, not
    // on the departure.
    //
    // A departure time is when the last vehicle must be moving. Clearing the pocket takes
    // `clearanceMinutes` at the tightest point on the route, and the decision has to
    // precede that by the departure delay. So the question is whether the coordinator can
    // still start the process in time, which is a stricter question than whether a road
    // is open — and it is the one docs/work-plan.md makes the acceptance criterion.
    //
    // Gating on the encouraging end of the band instead would be more permissive and
    // would make a better demo. That is the trap.
    const gated = routes.map((r) => {
      if (r.lastSafeDeparture === null) {
        return { ...r, usable: false, unusableReason: 'route is already cut at this cursor' };
      }
      // Unknown clearance is not zero clearance. `clearanceMinutes` is null exactly when
      // the pocket's population is unknown, and the contract is explicit that unknown is
      // never zero-by-default — but `?? 0` made it free, which moved the deadline later
      // and made a pocket with no population *more* likely to be cleared for evacuation
      // than one whose population is known. Unverifiable is the honest reading.
      if (r.clearanceMinutes === null) {
        return { ...r, usable: false, unusableReason: 'pocket population is unknown, so clearance cannot be verified' };
      }
      const departure = Date.parse(r.lastSafeDeparture.earliest) / 1000 - origin / 1000;
      const startBy = departure - r.clearanceMinutes * 60 - ASSUMPTIONS.departureDelayMinutes * 60;
      return {
        ...r,
        usable: startBy >= cursor,
        unusableReason:
          startBy >= cursor
            ? null
            : `the decision had to be made ${Math.round((cursor - startBy) / 60)} minutes ago to clear the bottleneck in time`,
      };
    });
    const usableRoutes = gated.filter((r) => r.usable);
    routes.length = 0;
    routes.push(...gated);

    // Whether any detection has reached the engine by this cursor at all, which is a
    // different question from whether any route survives the gate. Before the first one
    // arrives the cut field is empty and every band is unbounded, so every route passes
    // trivially and the old two-valued verdict reported `routes_open` on no data.
    const verdict: PocketEgress['verdict'] = !anyObserved
      ? 'not_yet_observed'
      : usableRoutes.length > 0
        ? 'routes_open'
        : 'no_verified_action';
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
      staticHeat: { polygons: ctx.staticHeatPolygons, removed: ctx.staticHeatRemoved, fixtureLoaded: ctx.heatFixtureLoaded },
      sweep: sweepDiagnostics,
    },
  };
}
