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

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  AssumptionProfile,
  ClearanceRange,
  CutTime,
  EgressAssumptions,
  EgressResponse,
  EgressRoute,
  PocketEgress,
  SensorFamilyRow,
  TimeBand,
} from '../../shared/egress';
import type { LatLon } from '../../shared/fires';
import {
  ASSUMPTION_PROFILES,
  NOMINAL_CAPACITY_PER_HOUR,
  profileById,
  withAssumedSpeeds,
} from './assumptions';
import { detectionsFromCapture, groupClustersIntoEvents, loadCapture, pickEventForWindow } from './capture';
import { DEFAULT_GRAPH_PATH, loadGraph, nearestNode, type LoadedGraph } from './graph';
import { sensorFamilyRows, subtractStaticHeatSources, type Detection } from './mask';
import { ownLookup } from './tables';
import { loadPocketGeometry } from './pockets';
import {
  allNodesSafe,
  bottleneckOf,
  edgesById,
  latestDeparture,
  routeTo,
  type RoadGraph,
  type Route,
} from './solve';
import { NOMINAL_ID, SWEEP_CONFIGS, basisFor, configLabel, sweepField } from './sweep';

import { DEFAULT_LATENCY_SECONDS, LATENCY_SECONDS, fromEpochMs, resolveTimelineOrigin } from './time';

const HERE = dirname(fileURLToPath(import.meta.url));
export const CAPTURE_PATH = resolve(HERE, '../../data/snapshots/los-gallardos-2026-07-09.json');
const SETTLEMENTS_PATH = resolve(HERE, '../../data/pockets/settlements.json');
export const STATIC_HEAT_PATH = resolve(HERE, '../../data/fixtures/static-heat-sources.json');

/**
 * A short content digest of a file.
 *
 * Used to key the recommendation ledger on the inputs a recommendation was computed from. A path
 * cannot serve: a re-import leaves the path exactly where it was while changing everything the
 * file describes, which is the case the key has to catch.
 */
function digestOf(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex').slice(0, 16);
}

/**
 * The latency to add for a detection from `source` — the delay between the satellite seeing a
 * pixel and the record being usable.
 *
 * `ownLookup`, not `LATENCY_SECONDS[source] ?? ...`. The source comes from the capture, and for a
 * name like `'constructor'` the bare lookup returns a function rather than nothing — truthy, so the
 * fallback never fired. That value then reached the latency `Float64Array` as NaN, and every
 * `cut + NaN <= cursor` is false: the engine stopped marking roads cut and published
 * `not_yet_observed` at cursors where the same capture with an unknown source name publishes
 * `no_verified_action`, with different routes recommended. The permissive direction, found by
 * review one table over from the same defect in the mask.
 *
 * Exported so the site itself is reachable by a test. `loadContext` reads a fixed capture path, so
 * a hostile source cannot be put through it from outside — and this is the difference between
 * marking a road cut and not, which is worth more than a test of the helper alone.
 */
export function latencyFor(source: string): number {
  return ownLookup(LATENCY_SECONDS, source) ?? DEFAULT_LATENCY_SECONDS;
}

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
   * Vehicles per hour by road class — the NOMINAL centre, which the swept profiles are
   * scaled from. There is no measurement behind any of these; they are order-of-magnitude
   * figures for a single carriageway, and the clearance they produce is an assumption
   * rather than a finding.
   *
   * Aliased to the table in `assumptions.ts` rather than repeated, because the two are the
   * same claim: the profile scaling divides by this table, so a copy that drifted would
   * make the published centre and the swept ends disagree about what "nominal" means.
   */
  capacityPerHour: NOMINAL_CAPACITY_PER_HOUR,
};

const DEFAULT_CAPACITY_PER_HOUR = 600;

/**
 * The longest time from decision to first vehicle moving, across the swept profiles.
 *
 * The gate is a statement about whether the coordinator can still start in time, so the
 * delay it subtracts has to be the pessimistic one for the same reason the departure and
 * the clearance are.
 */
export const PESSIMISTIC_DELAY_MINUTES = Math.max(
  ...ASSUMPTION_PROFILES.map((p) => p.assumptions.departureDelayMinutes),
);

interface Context {
  loaded: LoadedGraph;
  graph: RoadGraph;
  /**
   * The road graph under each swept assumption profile, keyed by profile id.
   *
   * Only travel times differ between them, and they are built once here rather than per
   * request because the profiles are fixed. Each is a scaled copy of the committed graph;
   * `graph` itself remains the nominal answer, which is what the response's `assumptions`
   * describes and what an unscaled solve would use.
   */
  graphsByProfile: Map<string, RoadGraph>;
  /**
   * The banded cut field as the response publishes it.
   *
   * Cursor-independent — a cut time is a whole-window property and the cursor only decides
   * which of them have happened yet — so it is built once and reused rather than
   * reconstructed on every scrub frame. Measured at 12.5 ms of a 156 ms request.
   */
  segments: CutTime[];
  /**
   * What each sensor family contributed to the cut field.
   *
   * Cursor-independent like `segments` — which detections reached which road is a whole-window
   * property, not a function of the moment being asked about — so it is built once here rather
   * than derived per scrub frame.
   */
  sensorFamilies: SensorFamilyRow[];
  /** Cut segments no family could claim. See `EgressResponse.unattributedCutSegments`. */
  unattributedCutSegments: number;
  detections: Detection[];
  originMs: number;
  /**
   * A digest of the road data this context was built from.
   *
   * The recommendation ledger keys entries on the inputs they were computed from, and the graph
   * is one of them: a re-imported OSM extract changes the routes, the distances and the travel
   * times, so an entry computed on the old geometry must not answer for the new one. A content
   * digest rather than the path, because the path is precisely what stays the same across a
   * re-import.
   */
  graphHash: string;
  /**
   * A digest of the detection capture, and of the persistent-heat fixture.
   *
   * Both were previously represented in the ledger's key by a count — the number of detections,
   * the number of heat polygons and removals — and a count is not an input. A re-fetched capture
   * with the same number of detections, or a re-exported heat fixture with the same geometry
   * count and different geometry, changes the mask and therefore the answer while leaving the key
   * where it was, so a recorded entry answers for inputs it never saw. Same reasoning as
   * `graphHash`: a digest of the bytes, because the path survives the change.
   */
  captureHash: string;
  heatFixtureHash: string;
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

/**
 * The banded cut field as the response publishes it.
 *
 * Depends on the graph, the sweep and the timeline origin and on nothing else — the cursor
 * only decides which cuts have happened yet, which is a filter over this array rather than
 * a change to it. Building it inside the request path rebuilt 29,834 objects on every
 * scrub frame for an identical answer.
 */
function buildSegments(graph: RoadGraph, sweep: Context['sweep'], originMs: number): CutTime[] {
  const segments = graph.edges.map((edge, i) => {
    const cut = sweep.field.nominalCutAtSeconds[i];
    const earliest = sweep.field.earliestCutAtSeconds[i];
    const latest = sweep.field.latestCutAtSeconds[i];
    const banded = Number.isFinite(earliest) && Number.isFinite(latest);
    return {
      segmentId: edge.id,
      // null means never within the modelled window, which is a different statement
      // from "not yet" — the contract's own distinction, and it is kept here.
      cutAt: Number.isFinite(cut) ? fromEpochMs(originMs + cut * 1000) : null,
      band: banded
        ? {
            earliest: fromEpochMs(originMs + earliest * 1000),
            latest: fromEpochMs(originMs + latest * 1000),
            // `contributorCount` is passed here for the same reason the route band below
            // passes its own: a configuration that never closes this segment contributes
            // nothing to its band, and a basis line claiming all twelve while most of
            // them stood down overstates the evidence behind the number. Measured on the
            // committed capture, fewer than twelve configurations cut most segments.
            basis: basisFor(
              sweep.field.earliestConfigId[i],
              sweep.field.latestConfigId[i],
              sweep.field.contributorCount[i],
            ),
          }
        : null,
      evidenceHotspotIds: sweep.field.nominalEvidence[i] ?? [],
    };
  });

  // Frozen, all the way down, before it is shared.
  //
  // Hoisting this array into the context made every response hand out the SAME 29,834
  // objects — verified by identity, and by an in-place edit through one response coming
  // back out of the next build — where the previous code rebuilt them per request and so
  // could not share them. The response is memoised and re-served on top of that, so a
  // future in-place edit anywhere on the response path would persist for the process
  // rather than for one answer. Freezing turns that from a silent corruption into a
  // TypeError at the point of the write.
  for (const segment of segments) {
    Object.freeze(segment.evidenceHotspotIds);
    if (segment.band) Object.freeze(segment.band);
    Object.freeze(segment);
  }
  return Object.freeze(segments) as CutTime[];
}

/** Everything that does not depend on the cursor, built once. */
export function loadContext(graphPath: string = DEFAULT_GRAPH_PATH): Context {
  if (cached && cachedPath === graphPath) return cached;

  const loaded = loadGraph(graphPath);

  // Read a second time to digest them, rather than threading the raw bytes through the loaders.
  // Paid once per process, against a cold build already measured in seconds. The heat fixture is
  // digested only if it is there; a missing fixture is itself an input, and 'absent' says so
  // without pretending to be a digest.
  const graphHash = digestOf(graphPath);
  const captureHash = digestOf(CAPTURE_PATH);
  const heatFixtureHash = existsSync(STATIC_HEAT_PATH) ? digestOf(STATIC_HEAT_PATH) : 'absent';

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
  const latencyOf = latencyFor;
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

  // The graphs the band is solved over, built once because the profiles are fixed. Every
  // swept profile scales the committed graph; the committed graph itself is the nominal
  // answer and is what the response's `assumptions` describes, but it is not a swept point
  // — a centre is never an end of an envelope.
  const graphsByProfile = new Map<string, RoadGraph>();
  for (const profile of ASSUMPTION_PROFILES) {
    graphsByProfile.set(
      profile.id,
      withAssumedSpeeds(loaded.graph, loaded.speedByHighway, profile.assumptions.speedByHighway),
    );
  }

  // Cursor-independent, like `segments`: which detections reached which road is a whole-window
  // property, so it is built once here rather than derived per scrub frame.
  const familyBreakdown = sensorFamilyRows(
    detections,
    sweep.field.nominalUsedDetectionIds,
    sweep.field.nominalEvidence,
  );

  cached = {
    loaded, graph: loaded.graph, graphsByProfile, segments: buildSegments(loaded.graph, sweep, originMs),
    sensorFamilies: familyBreakdown.rows,
    unattributedCutSegments: familyBreakdown.unattributedCutSegments,
    detections, originMs, graphHash, captureHash, heatFixtureHash,
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
    /**
     * Per combination of road-cut configuration and assumption profile: how many
     * detections it used, and the pocket's departure under it. The two axes are separate
     * fields rather than a composite string so a consumer never has to parse one back out.
     */
    sweep: Array<{
      id: string;
      configId: string;
      profileId: string;
      label: string;
      detectionsUsed: number;
      departureSeconds: number | null;
    }>;
    /**
     * Settlements the fire reaches within the modelled window, by id.
     *
     * Cursor-independent, because it is a property of the fire rather than of now: a
     * settlement is threatened if the fire arrives at any point in the window, and asking
     * again a minute later does not change that. Under the nominal configuration, for the
     * same reason the published band takes its centre from it.
     *
     * Exists for reach, which needs the complement — the people inside a served footprint
     * for a fire that does NOT threaten them. The distinction is the whole point of that
     * figure and it cannot be derived from `segments`, which carries per-EDGE cuts and not
     * which settlement each edge is next to. Deriving it here, where the settlement-to-node
     * snapping already happened, keeps that snapping in one place.
     */
    threatenedSettlementIds: string[];
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
function profileLabelOf(id: string): string {
  return profileById(id)?.label ?? id;
}

/**
 * A route band's basis, naming BOTH axes that attained each end.
 *
 * The mask sweep alone used to be enough to describe a band, so `basisFor` names a
 * configuration and stops. With a second axis that is no longer a complete description:
 * "earliest from polar-only" does not say whether that was under cautious or optimistic
 * assumptions, and those are different claims about the world. Each end therefore names
 * its configuration and its profile.
 */
export function routeBasisFor(
  earliest: { configId: string; profileId: string },
  latest: { configId: string; profileId: string },
  contributors: number,
  total: number,
): string {
  const scope =
    contributors >= total
      ? `across all ${total} combinations of configuration and assumption profile`
      : `across ${contributors} of ${total} combinations of configuration and assumption profile ` +
        // "Found no route" is the -Infinity case, and it is what a route band drops. The
        // phrase "never close this route inside the window" belongs to the segment bands,
        // where the excluded configurations gave Infinity; carried over here it made the
        // opposite and more reassuring claim about the combinations that were excluded.
        `(${total - contributors} found no route under these assumptions)`;
  const describe = (combo: { configId: string; profileId: string }): string =>
    `${configLabel(combo.configId)} under ${profileLabelOf(combo.profileId)}`;
  if (earliest.configId === latest.configId && earliest.profileId === latest.profileId) {
    return `all contributing combinations agree (${describe(earliest)}); ${scope}`;
  }
  return `earliest from ${describe(earliest)}; latest from ${describe(latest)}; ${scope}`;
}

interface ClearanceEntry {
  profile: AssumptionProfile;
  bottleneck: { segmentId: string; clearMinutes: number };
}

/**
 * The entries with the largest and smallest value, chosen by comparing values.
 *
 * Exported and pure because the profile labels cannot be trusted to encode direction, and
 * on the shipped profiles that is currently unfalsifiable: measured over every road class,
 * `cautious` is never faster than `optimistic` and never has a higher capacity, so it is
 * dominated on every axis and always IS the pessimistic end. A "select by label"
 * implementation would therefore be observationally identical on every input this system
 * can generate — which is exactly why the selection has to be callable with a pair of its
 * own, where the labels disagree with the values, or the row that names this case has no
 * discriminating test at all.
 *
 * The band's ends are selected by `indexOf` over the value array for the same reason; there
 * is no label involved in that path, so no equivalent seam is needed.
 */
export function extremesBy<T>(entries: readonly T[], value: (entry: T) => number): { max: T; min: T } {
  if (entries.length === 0) throw new RangeError('extremesBy needs at least one entry');
  let max = entries[0];
  let min = entries[0];
  for (const entry of entries) {
    if (value(entry) > value(max)) max = entry;
    if (value(entry) < value(min)) min = entry;
  }
  return { max, min };
}

/**
 * The clearance range's basis, naming the values behind each end rather than only the
 * profiles — the point of publishing a range is that the reader can see which assumption
 * moved it, and "cautious to optimistic" does not say which number did the moving.
 */
function clearanceBasis(
  population: number,
  worst: ClearanceEntry,
  best: ClearanceEntry,
  graph: RoadGraph,
): string {
  const byId = edgesById(graph);
  const part = (entry: ClearanceEntry): string => {
    const a = entry.profile.assumptions;
    const edge = byId.get(entry.bottleneck.segmentId);
    const highway = edge?.highway ?? 'unknown class';
    const capacity = (edge && ownLookup(a.capacityPerHour, edge.highway)) ?? DEFAULT_CAPACITY_PER_HOUR;
    // The road class and the segment are named, not just the throughput. The contract
    // promises the basis says which segment produced each end, and the class is the part a
    // reader can act on: "track" is why a village of 953 takes three hours to leave.
    return (
      `${entry.bottleneck.clearMinutes.toFixed(0)} min under ${entry.profile.label} ` +
      `(${a.mobileFraction} mobile ÷ ${a.vehicleOccupancy} per vehicle, ` +
      `${capacity} vehicles/h on ${highway} at ${entry.bottleneck.segmentId})`
    );
  };
  return (
    `${population} residents: worst ${part(worst)}; best ${part(best)}. ` +
    'The action gate reads the worst.'
  );
}

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
    (d) => d.atSeconds + latencyFor(d.source) <= cursor,
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

  // Cursor-independent and identical on every request, so it comes from the context rather
  // than being rebuilt here. Only the hypothesis about which cuts have arrived yet is a
  // function of the cursor, and that is a filter the route layer applies on the way out.
  const segments = ctx.segments;

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
      /** Which combination attained each departure, so the basis can name both axes. */
      combos: Array<{ configId: string; profileId: string }>;
      /** The raw solve route, so the clearance calculation can reuse its segment list. */
      route: Route | null;
      /** The profile the route above was solved under, so its numbers can be attributed. */
      routeProfileId: string | null;
    }
    const byDestination = new Map<string, RouteAccumulator>();

    // Profiles are iterated outermost and in declared order — cautious first — because the
    // route published is the first one a combination yields, and the road a sentence names
    // should be one that survives the pessimistic assumptions rather than one that only
    // works if the optimistic ones are true. That is the spike's own failure: people left
    // by a track that led nowhere.
    // The masked fields depend on the configuration and the cursor, not on the profile, so
    // they are computed once per configuration and read by both profiles. Rebuilding them
    // per profile was 2.6 ms of a ~250 ms request spent producing an identical pair of
    // arrays twice.
    //
    // The loops are NOT swapped to config-major to get this. Profile-major is what makes
    // the first route found the one that survives the pessimistic assumptions; config-major
    // would pick whichever configuration happened to come first and could name a road that
    // only works under the optimistic profile.
    const maskedByConfig = new Map<string, { cuts: number[]; nodeCut: number[] }>();
    const maskedField = (configId: string): { cuts: number[]; nodeCut: number[] } => {
      let field = maskedByConfig.get(configId);
      if (field === undefined) {
        field = { cuts: knownCut(configId), nodeCut: knownNodeCut(configId) };
        maskedByConfig.set(configId, field);
      }
      return field;
    };

    for (const profile of ASSUMPTION_PROFILES) {
      // Refused rather than falling back to the committed graph. The fallback would solve
      // the nominal road network and then publish the answer under this profile's label and
      // this profile's assumptions — a basis citing an end no combination attained, which
      // is the plausible-but-wrong number the rest of this file is written to avoid. The map
      // is built from this same constant in the same call, so the branch is unreachable
      // today; it is the reachable-tomorrow shape that matters.
      const profileGraph = ctx.graphsByProfile.get(profile.id);
      if (profileGraph === undefined) {
        throw new Error(`no road graph was built for assumption profile "${profile.id}"`);
      }

      for (const config of SWEEP_CONFIGS) {
        const { cuts, nodeCut } = maskedField(config.id);

        // The pocket is not a destination for its own residents, and its own node is
        // excluded from the per-destination solves too. Including it does not merely add a
        // zero-length route: with the node deadline in place the solve's value at the
        // pocket is at least the pocket's own burn time, so the number published as this
        // combination's departure was the moment the fire reaches the village — 134 s later
        // than every route the same response publishes, in the permissive direction. It
        // also costs a full `latestDeparture` to produce a value `routeTo` can never fill.
        const values: number[] = [];

        for (const { settlement, node } of settlementNodes) {
          if (node === null || !destinations.has(node)) continue;
          if (node === pocketNode) continue;
          const solo = latestDeparture(profileGraph, cuts, [node], { nodeCutSeconds: nodeCut });
          const value = solo.latestDeparture[pocketNode];
          values.push(value);
          // Infinity is a real answer — nothing on this route is ever cut under this
          // combination — and skipping it silently dropped whole combinations from the
          // band while the published basis still claimed they all contributed. Only
          // -Infinity, which means no route at all, is a non-answer.
          if (value === Number.NEGATIVE_INFINITY) continue;

          const acc =
            byDestination.get(settlement.id) ??
            { departures: [], combos: [], route: null, routeProfileId: null };
          acc.departures.push(value);
          acc.combos.push({ configId: config.id, profileId: profile.id });
          if (acc.route === null) {
            const r = routeTo(solo, profileGraph, cuts, pocketNode, [node]);
            if (r) {
              acc.route = r;
              // Remembered because this profile's travel times become the route's published
              // `travelMinutes`, `distanceKm` and `segmentIds`. Iterating pessimistic-first
              // is deliberate — the named road should be one that survives the pessimistic
              // assumptions — but it left those numbers unattributed against a response
              // that names the nominal set.
              acc.routeProfileId = profile.id;
            }
          }
          byDestination.set(settlement.id, acc);
        }

        // The pocket's overall departure is DERIVED, not solved. It is the pointwise max of
        // the per-destination values, because the multi-destination solve is the fixed point
        // of a monotone max-plus system seeded with every destination at once. Checked
        // rather than asserted: across all twelve configurations and all 13,069 nodes,
        // 156,828 values, the derived figure matched a full multi-destination solve exactly.
        // Deriving it removes 12 of the 60 solves this request used to run.
        const primaryValue = values.length > 0 ? Math.max(...values) : Number.NEGATIVE_INFINITY;
        sweepDiagnostics.push({
          id: `${profile.id}/${config.id}`,
          configId: config.id,
          profileId: profile.id,
          label: `${config.label} under ${profile.label}`,
          detectionsUsed: ctx.sweep.usedByConfig.get(config.id) ?? 0,
          departureSeconds: departureFor(primaryValue, windowEndSeconds),
        });
      }
    }

    const routes: EgressRoute[] = [];
    for (const [settlementId, acc] of byDestination) {
      if (acc.route === null || acc.departures.length === 0) continue;
      // The two are set together, so one without the other is a programming error rather
      // than a state to paper over — the fallback here would be exactly the plausible-but-
      // wrong attribution the rest of this file argues against.
      if (acc.routeProfileId === null) {
        throw new Error(`${settlementId} has a route solved under no profile; refusing to publish it unattributed`);
      }
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
      const totalCombos = SWEEP_CONFIGS.length * ASSUMPTION_PROFILES.length;
      const band: TimeBand = {
        earliest: fromEpochMs(origin + Math.min(minValue, windowEndSeconds) * 1000),
        latest: Number.isFinite(maxValue) ? fromEpochMs(origin + maxValue * 1000) : null,
        basis: neverClosed
          ? `no combination of road-cut configuration and assumption profile closes this ` +
            `route inside the modelled window (all ${acc.departures.length} of ${totalCombos} ` +
            'unbounded); earliest is the end of the window, not a departure deadline'
          : routeBasisFor(acc.combos[minIndex], acc.combos[maxIndex], acc.departures.length, totalCombos),
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
      let clearanceMinutes: ClearanceRange | null = null;
      let bottleneckSegmentId: string | null = null;
      // `> 0` used to guard this, so a settlement whose population is a KNOWN zero fell
      // through with a null clearance and the gate reported "pocket population is unknown,
      // which is false about data we hold. The contract already distinguishes null (unknown)
      // from 0 (nobody), so a zero flows through the arithmetic: no vehicles, no clearance,
      // and the gate turns on the departure alone.
      if (population !== null) {
        // One clearance per swept profile, over the same segment list. This is where the
        // assumption set actually bites: measured on the committed capture the span is 89
        // to 185 minutes, against a departure band the speed axis moves by under one.
        const perProfile: ClearanceEntry[] = [];
        for (const profile of ASSUMPTION_PROFILES) {
          const a = profile.assumptions;
          const vehicles = (population * a.mobileFraction) / a.vehicleOccupancy;
          const bottleneck = bottleneckOf(
            acc.route,
            graph,
            vehicles,
            a.capacityPerHour,
            DEFAULT_CAPACITY_PER_HOUR,
          );
          if (bottleneck) perProfile.push({ profile, bottleneck });
        }
        if (perProfile.length > 0) {
          // Selected by VALUE, never by the profile's name. See `extremesBy` for why that
          // distinction is currently unfalsifiable on the shipped profiles, and why the
          // selection is therefore testable on its own.
          const { max: worst, min: best } = extremesBy(perProfile, (e) => e.bottleneck.clearMinutes);
          clearanceMinutes = {
            pessimisticMinutes: Number(worst.bottleneck.clearMinutes.toFixed(1)),
            optimisticMinutes: Number(best.bottleneck.clearMinutes.toFixed(1)),
            pessimisticProfileId: worst.profile.id,
            optimisticProfileId: best.profile.id,
            basis: clearanceBasis(population, worst, best, graph),
          };
          // The pessimistic bottleneck is the one that decides, so it is the one named.
          bottleneckSegmentId = worst.bottleneck.segmentId;
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
        // The drive time, distance and segment list above are this profile's, not nominal.
        solvedUnderProfileId: acc.routeProfileId,
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
      // Nothing has been observed yet, so nothing about this route can be assessed. Its
      // band is unbounded precisely because the mask is empty, so left alone it passes
      // every gate below and the response publishes `usable: true` — four routes that
      // survived scrutiny, beside a verdict saying none could be assessed. The verdict is
      // the pocket-level statement of this, and the per-route flag has to agree with it.
      if (!anyObserved) {
        return {
          ...r,
          usable: false,
          unusableReason: 'no detection has arrived at this cursor, so the route cannot be assessed',
        };
      }
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
      // All three terms are now swept, so all three are read at their pessimistic end: the
      // earliest the band permits, the longest the pocket could take to clear, and the
      // slowest the coordinator could start. Taking the pessimistic clearance and then a
      // nominal delay would mix the axes and understate the deadline by the width of the
      // delay's own spread.
      const startBy =
        departure - r.clearanceMinutes.pessimisticMinutes * 60 - PESSIMISTIC_DELAY_MINUTES * 60;
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

  // Which settlements the fire reaches, from the same node snapping the routes already use,
  // so the settlement-to-node mapping lives in one place. Read off the nominal configuration,
  // for the same reason the published band takes its centre from it.
  //
  // A settlement that snaps to no node is treated as NOT threatened. That is a choice, and it
  // is the direction that RAISES the reach figure: the alternative reads "we could not place
  // this village on the road graph" as "the fire is coming", which lowers a number about
  // over-alerting. Neither reading is evidence, so the choice is stated rather than buried —
  // and a null node is already reported by the pocket's own `no_verified_action` verdict.
  //
  // `nodeCutByConfig` is indexed by GRAPH NODE directly, not by position in the combined
  // segments-then-nodes array: `sweepField` already sliced the segment prefix off when it
  // built this map. Indexing it `segments.length + node` applies that offset a second time
  // and reads past the end — where `arr[i]` is `undefined`, `Number.isFinite(undefined)` is
  // false, and every settlement silently filters out into an empty list that looks like a
  // finding. Nothing throws, and the length check below does NOT catch it: the array is the
  // right length under either index expression. What catches it is asserting the RESULT,
  // which `egress.test.ts` does by naming the settlements the fire reaches.
  //
  // The check below asserts a different invariant — that the field is aligned to the graph at
  // all — so a future change in how `sweepField` slices is refused here rather than misread as
  // cuts at the wrong nodes.
  const nominalNodeCut = ctx.sweep.nodeCutByConfig.get(NOMINAL_ID);
  // A missing field is thrown rather than read as "no settlement is threatened". That reading
  // is the dangerous default the indexing bug above arrived at by accident, and it needs no
  // help: an absent nominal cut means the sweep did not run a configuration the response is
  // supposed to be centred on, which is a fault in the engine and not a fact about the fire.
  if (nominalNodeCut === undefined) {
    throw new RangeError(
      `the sweep produced no cut field for the nominal configuration "${NOMINAL_ID}"; ` +
        'refusing to report that this fire threatens nowhere',
    );
  }
  if (nominalNodeCut.length !== graph.nodes.length) {
    throw new RangeError(
      `node cut field has ${nominalNodeCut.length} entries against ${graph.nodes.length} graph nodes; ` +
        'refusing to read settlement cuts from a field that is not aligned to the graph',
    );
  }
  const threatenedSettlementIds = settlementNodes
    .filter(({ node }) => node !== null && Number.isFinite(nominalNodeCut[node]))
    .map(({ settlement }) => settlement.id);

  return {
    response: {
      provenance: 'replay',
      at: fromEpochMs(origin + cursor * 1000),
      // Copied, like the tables below and for the same reason: the context is cached and every
      // response hands out these rows, so a consumer editing one would edit it for every later
      // request. The rows themselves are frozen with the context.
      sensorFamilies: ctx.sensorFamilies.map((row) => ({ ...row, sources: [...row.sources] })),
      unattributedCutSegments: ctx.unattributedCutSegments,
      // Copied, not shared. `ctx.loaded.speedByHighway` is the very table the solver scales
      // travel times with, and the response is memoised and re-served, so a consumer that
      // touched it in place would not merely misprint an assumption — it would change the
      // road network every later request is solved on. The `profiles` array below is copied
      // for the same reason, and this line was the remaining hole.
      assumptions: {
        ...ASSUMPTIONS,
        speedByHighway: { ...ctx.loaded.speedByHighway },
        capacityPerHour: { ...ASSUMPTIONS.capacityPerHour },
      },
      // Copied all the way down. Spreading only the top level leaves `speedByHighway` and
      // `capacityPerHour` as the very objects the solver reads at context load, and the
      // response is memoised and re-served — so a consumer that normalised a table in place
      // would corrupt the process-wide profile for every later request.
      profiles: ASSUMPTION_PROFILES.map((profile) => ({
        ...profile,
        assumptions: {
          ...profile.assumptions,
          speedByHighway: { ...profile.assumptions.speedByHighway },
          capacityPerHour: { ...profile.assumptions.capacityPerHour },
        },
      })),
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
      threatenedSettlementIds,
    },
  };
}
