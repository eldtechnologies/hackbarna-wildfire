// Egress contracts: the road graph, when fire reaches each segment, and how long a
// pocket has to leave. Draft for the H0-4 freeze — see docs/work-plan.md.
//
// Type-only, matching shared/fires.ts: ISO strings rather than Date, LatLon rather
// than GeoJSON, ids as strings. The band types exist because the spike showed a
// point departure time is not defensible: the same exit road read 19:38, 21:18 or
// 00:03 depending on buffer radius and sensor mix.

import type { LatLon } from './fires';

/** A range, plus what was varied to produce it. Never a bare point estimate. */
export interface TimeBand {
  earliest: string; // ISO 8601
  /**
   * ISO 8601, or null when at least one configuration in the sweep never closes this at
   * all within the modelled window.
   *
   * Nullable for the same reason `CutTime.cutAt` is: "never within the window" and
   * "a very late time" are different statements, and without this the only way to say
   * the former is to invent a window-end timestamp. The engine's internal value here is
   * Infinity, and `JSON.stringify(Infinity)` is `null` — which the route contract reads
   * as "already cut", inverting the safest state into the most alarming one. Making the
   * type nullable forces every consumer to handle it deliberately.
   */
  latest: string | null;
  /** Human-readable description of what was swept, printed beside the number. */
  basis: string;
}

/** One directed drivable edge of the quantised OSM graph. */
export interface RoadSegment {
  id: string;
  fromNodeId: string;
  toNodeId: string;
  /** Sampled centreline in order. */
  geometry: LatLon[];
  /** OSM highway class, e.g. 'primary', 'track'. */
  highway: string;
  name: string | null;
}

/**
 * When the fire reaches a segment — the first timestep whose accumulated,
 * sensor-calibrated mask intersects it. `cutAt: null` means never, within the
 * modelled window, which is a different statement from "not yet".
 */
/**
 * What one sensor family contributed to the cut field.
 *
 * Published because the omission of a family is otherwise discoverable only by reading the code
 * that builds the mask: the field carries per-cut evidence ids, but nothing that says which
 * instruments those ids came from or which instruments were absent. Decision 5 named three
 * families for two months while the capture carried four and the table knew seven sources, and
 * neither document nor response showed it.
 *
 * Counted per FAMILY, not per source. The three VIIRS feeds are one instrument on three
 * satellites, and a table headed "family" listing VIIRS three times would read as three sensors —
 * `sources` names the feeds so the grouping is legible rather than taken on trust.
 */
export interface SensorFamilyRow {
  family: string;
  /** The source keys this family comprises, as they appear in the capture. */
  sources: string[];
  /** Detections the capture holds for this family. */
  detections: number;
  /**
   * How many of those had a disc reach a road — whether or not they set a cut time.
   *
   * Not "attained a cut": most do not. Measured on the committed capture, 2,451 detections reach a
   * road and only 130 are cited as the detection that set one, so the two readings differ by 95%
   * and the wrong one would report every family as a far larger contributor than it is. The cut
   * count is `cutSegments`, below.
   */
  usedDetections: number;
  /** Distinct cut segments this family attained at least one of. */
  cutSegments: number;
}

export interface CutTime {
  segmentId: string;
  cutAt: string | null;
  /** Calibration sweep over sensor footprint and detection source. */
  band: TimeBand | null;
  /** Detection ids that produced the cut, so the decision ledger can cite them. */
  evidenceHotspotIds: string[];
}

/** A cluster of buildings treated as one population to evacuate. */
export interface Pocket {
  id: string;
  name: string;
  centroid: LatLon;
  /** Catastro footprints in the pocket. */
  buildings: number;
  /** INE padrón for the municipality; null when unknown, never zero-by-default. */
  population: number | null;
  /** Language code to share of population, from the padrón nationality mix. */
  languageMix: Record<string, number>;
}

/** What the solve assumes. Every field is printed beside the output it produces. */
export interface EgressAssumptions {
  /** Share of the pocket that can leave without assistance, 0..1. */
  mobileFraction: number;
  /** Time from decision to first vehicle moving, in minutes. */
  departureDelayMinutes: number;
  /** People per vehicle. */
  vehicleOccupancy: number;
  /** Modelled speed by OSM highway class, km/h. */
  speedByHighway: Record<string, number>;
  /**
   * Vehicles per hour a segment of each highway class can clear, for the bottleneck
   * calculation. An assumption with no measurement behind it, and labelled as one
   * wherever it surfaces.
   */
  capacityPerHour: Record<string, number>;
}

/**
 * One assumption set the departure band was swept over, with the id and label its basis
 * line cites.
 *
 * The shape is the contract's rather than the engine's on purpose: a profile is a complete
 * `EgressAssumptions`, so it prints in the same shape every other assumption already
 * prints in, and a reader never has to learn a second layout to compare the swept values
 * against the nominal centre.
 */
export interface AssumptionProfile {
  /** Stable key, cited by the basis line. */
  id: string;
  /** Printed beside every number this profile produced. */
  label: string;
  assumptions: EgressAssumptions;
}

/**
 * How long the pocket takes to clear the tightest point on a route, across the swept
 * assumption set.
 *
 * A range rather than a number, for the same reason a departure is a band rather than a
 * time: the quantity rests on assumptions nobody has measured, and a single figure would
 * present the middle of a wide spread as though it were the answer. The ends are named for
 * the direction they mean rather than as `min`/`max`, because "minimum clearance" is the
 * optimistic end and an unlabelled pair is exactly where a reader swaps them.
 *
 * On the committed Los Gallardos capture this spread is 89 to 185 minutes for Bédar —
 * ninety-six minutes of the decision resting on values that are labelled assumptions
 * everywhere they surface.
 */
export interface ClearanceRange {
  /** The longest the pocket could take to clear, across the swept assumptions. The gate reads this one. */
  pessimisticMinutes: number;
  /** The shortest. Published so the reader can see how much the decision rests on assumptions. */
  optimisticMinutes: number;
  /**
   * Which swept profile attained each end.
   *
   * Carried as ids rather than left to the basis string because the ledger records the
   * inputs a reader would recompute from. It used to record the nominal mobile fraction and
   * occupancy beside a clearance computed from the cautious ones, so recomputing from the
   * ledger's own inputs gave 181.5 or 108.9 against a published 185.3 — an audit artifact
   * that could not reproduce the number it was auditing, reading permissive because the
   * nominal values imply fewer vehicles.
   */
  pessimisticProfileId: string;
  optimisticProfileId: string;
  /** Which values produced each end, and at which segment, in words. */
  basis: string;
}

/** One way out of a pocket, and how long it stays viable. */
export interface EgressRoute {
  id: string;
  /** Named destination the route leads to. */
  destination: string;
  segmentIds: string[];
  distanceKm: number;
  travelMinutes: number;
  /**
   * Worst road class on the path, worst-first. A route that exists only because
   * `highway=track` is in the graph has to say so on its face — the spike's own account
   * of the deaths includes people who left by a track that led nowhere, and burying
   * that inside a free-text basis string loses it.
   */
  slowestHighway: string;
  /**
   * How long the pocket takes to clear the tightest point on this route, swept over the
   * assumption set. Vehicles divided by the road's throughput: the number that decides
   * whether a departure band is achievable at all, and the acceptance criterion in
   * docs/work-plan.md. Null when the pocket's population is unknown.
   */
  clearanceMinutes: ClearanceRange | null;
  /** The segment the pessimistic clearance was reached at, since that is the one that decides. */
  bottleneckSegmentId: string | null;
  /**
   * Which swept profile this route was solved under.
   *
   * `segmentIds`, `distanceKm` and `travelMinutes` are that profile's values, not the
   * nominal ones — the route is taken from the first combination that yields one, and the
   * profiles are iterated pessimistic-first so the named road is one that survives the
   * pessimistic assumptions. Without this field the response published a cautious-profile
   * drive time (72 minutes to Los Gallardos, against the nominal graph's 52) while naming
   * the nominal set as its `assumptions`, so a reader had no way to tell which values the
   * route's own numbers came from.
   */
  solvedUnderProfileId: string;
  /**
   * Band, not a point. Null when the route is already cut at this cursor.
   */
  lastSafeDeparture: TimeBand | null;
  /**
   * Whether this route survives the pessimistic gate at the cursor — the band's earliest
   * end, minus the clearance at the bottleneck, minus the departure delay.
   *
   * Published so a consumer does not have to re-derive it. An earlier version left the
   * message to recompute the gate with a weaker test than the pocket verdict used, which
   * produced a window where the response said `no_verified_action` and the CAP sentence
   * told people to leave.
   */
  usable: boolean;
  /** Why not, in words, when `usable` is false. Null when it is true. */
  unusableReason: string | null;
}

export interface PocketEgress {
  pocketId: string;
  routes: EgressRoute[];
  /**
   * 'no_verified_action' is not shelter-in-place. Failing to find a route does
   * not show the building is survivable, so the default is operator assessment.
   *
   * 'not_yet_observed' is a third state, and it exists because the other two cannot
   * express it. Before any detection has arrived the cut field is empty, every band is
   * unbounded, and every route trivially survives the gate — so `routes_open` was
   * produced by absence of information rather than by evidence of safety. A clean
   * all-clear is the most consequential thing this response can say, and it must not be
   * something the engine says when it has seen nothing. This is not a stronger
   * `no_verified_action`: that one means a route was sought and withdrawn, this one means
   * none could be assessed.
   */
  verdict: 'routes_open' | 'no_verified_action' | 'not_yet_observed';
}

export interface EgressResponse {
  provenance: 'live' | 'replay';
  /** The cursor this answered for, at or before the requested time. */
  at: string;
  /**
   * The nominal assumption set — the centre the swept profiles bracket. Printed because a
   * number without its assumptions is the point estimate the spike showed is indefensible.
   */
  assumptions: EgressAssumptions;
  /**
   * What each sensor family contributed to the cut field, including the ones that contributed
   * nothing. Published beside the assumptions for the same reason: a number without the inputs
   * behind it is the point estimate the spike showed is indefensible, and this is the input that
   * was silently missing a family. See `SensorFamilyRow`.
   */
  sensorFamilies: SensorFamilyRow[];
  /**
   * Cut segments whose cited detections are not in the capture, so no family could claim them.
   *
   * Published so that zero is a statement rather than a silence: without it a reader cannot tell
   * "every cut was attributed" from "the response does not say". Expected to be 0 — a non-zero
   * value means the evidence ids and the detections have stopped corresponding, which would
   * otherwise show up only as families reading quietly low.
   */
  unattributedCutSegments: number;
  /**
   * The assumption sets this response was actually solved under, in the order the band's
   * basis names them. Every band and clearance range in the response is the envelope of
   * these, so a reader can see the values behind a published end rather than only the
   * centre it was varied around.
   */
  profiles: AssumptionProfile[];
  /**
   * Which fire this describes. The capture's bbox holds three separate heat sources and
   * the fire itself is carried as two cluster ids, so a response with no fire identity
   * is ambiguous about which one it solved for.
   */
  fireId: string | null;
  /** The cluster ids that were grouped into this fire. */
  clusterIds: string[];
  /**
   * The instant `?at=<seconds>` counts from. Published because the client's globe and
   * this engine must agree on what time it is, and a flat snapshot declares no timeline
   * for either to read.
   */
  origin: string;
  segments: CutTime[];
  pockets: PocketEgress[];
  fetchedAt: string;
}
