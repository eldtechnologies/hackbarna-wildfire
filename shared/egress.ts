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
   * How long the pocket takes to clear the tightest point on this route, in minutes,
   * and which segment that is. Vehicles divided by the road's throughput: the number
   * that decides whether a departure band is achievable at all, and the acceptance
   * criterion in docs/work-plan.md. Null when the pocket's population is unknown.
   */
  clearanceMinutes: number | null;
  bottleneckSegmentId: string | null;
  /**
   * Band, not a point. Null when the route is already cut at this cursor.
   */
  lastSafeDeparture: TimeBand | null;
}

export interface PocketEgress {
  pocketId: string;
  routes: EgressRoute[];
  /**
   * 'no_verified_action' is not shelter-in-place. Failing to find a route does
   * not show the building is survivable, so the default is operator assessment.
   */
  verdict: 'routes_open' | 'no_verified_action';
}

export interface EgressResponse {
  provenance: 'live' | 'replay';
  /** The cursor this answered for, at or before the requested time. */
  at: string;
  assumptions: EgressAssumptions;
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
