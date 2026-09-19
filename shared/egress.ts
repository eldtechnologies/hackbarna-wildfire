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
  latest: string; // ISO 8601
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
  segments: CutTime[];
  pockets: PocketEgress[];
  fetchedAt: string;
}
