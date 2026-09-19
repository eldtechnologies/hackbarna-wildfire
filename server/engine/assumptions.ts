// The assumption axis of the sweep: the values the egress model assumes, and the profiles
// the published band is enveloped over.
//
// The band used to vary only over the hazard mask — which sensors are trusted and how far
// each detection reaches — while these five values were fixed and merely printed. That
// made the response look swept when it was not, and it named a set of assumptions that no
// published number had actually been computed under.
//
// Not all five belong to the same part of the answer, and the split is worth stating
// because it is what keeps this affordable:
//
//   * `speedByHighway` is the only one that can move the DEPARTURE BAND. The band is a
//     solve over cut times and travel times, so a speed assumption has to be re-solved.
//   * `mobileFraction`, `departureDelayMinutes`, `vehicleOccupancy` and `capacityPerHour`
//     enter only through clearance and the action gate, which are computed by arithmetic
//     over a route that is already known. Sweeping those four costs nothing.
//
// Measured on the committed Los Gallardos capture: sweeping the speeds over a broader range
// than the profiles below adopt moves Bédar's pessimistic departure by 0.9 minutes, while
// the same profiles move its clearance by 96 minutes. The drive out is short relative to
// the fire's arrival uncertainty; the queue at the track is not.

import type { AssumptionProfile } from '../../shared/egress';
import type { RoadGraph } from './solve';

// The profile shape lives in the frozen contract rather than here, because it is what the
// response publishes; this module owns the values and the arithmetic, not the vocabulary.
export type { AssumptionProfile };

/** The speed table the committed graph's travel times were computed from. */
export const NOMINAL_SPEED_KMH: Record<string, number> = {
  motorway: 100, motorway_link: 60, trunk: 90, trunk_link: 60,
  primary: 80, primary_link: 50, secondary: 70, secondary_link: 45,
  tertiary: 60, tertiary_link: 40, unclassified: 50, residential: 30,
  living_street: 20, service: 20, track: 15, road: 30,
};

/**
 * Vehicles per hour a segment of each class can clear, at the nominal assumption.
 *
 * There is no measurement behind any of these. They are order-of-magnitude figures for a
 * single carriageway, and the profile scaling below inherits that status — which is why the
 * clearance they produce is published as a range rather than as a finding.
 */
export const NOMINAL_CAPACITY_PER_HOUR: Record<string, number> = {
  motorway: 3600, trunk: 2400, primary: 1800, secondary: 1500, tertiary: 1200,
  unclassified: 900, residential: 600, living_street: 400, service: 300, track: 300, road: 600,
};

/**
 * A speed table scaled from the nominal one.
 *
 * Derived rather than written out, so that "cautious is never faster than nominal" is true
 * by construction instead of by a hand-checked pair of sixteen-row tables that a later edit
 * can silently break. `Math.round` keeps the table printable in whole km/h; the scaling
 * itself works from the ratio, so the rounding here is presentational.
 */
function speedsAt(scale: number): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [highway, speed] of Object.entries(NOMINAL_SPEED_KMH)) {
    out[highway] = Math.max(1, Math.round(speed * scale));
  }
  return out;
}

function capacitiesAt(scale: number): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [highway, capacity] of Object.entries(NOMINAL_CAPACITY_PER_HOUR)) {
    out[highway] = Math.max(1, Math.round(capacity * scale));
  }
  return out;
}

/**
 * The swept profiles: two, bracketing the nominal centre.
 *
 * The count is a decision rather than a default, and there is deliberately no "nominal"
 * profile among them. A band is an envelope, so only its ends are ever read, and the
 * nominal set sits between the two by construction — measured on the committed capture,
 * the nominal profile strictly attained an end in 0 of 48 configuration-by-destination
 * combinations. Adding it back would spend a third of the solve budget to publish nothing,
 * and the centre it would describe is already published as the response's `assumptions`.
 *
 * Two rather than more because the whole speed axis moves the Bédar departure by under a
 * minute while the mask axis moves it by hours, so further points would add resolution the
 * data does not have. The other four assumptions are swept at the same two points because
 * sweeping them costs no solve at all, and they are where the decision actually moves.
 *
 * Every value here is an assumption. None has a field measurement behind it, and each is
 * labelled as one wherever it surfaces.
 */
export const ASSUMPTION_PROFILES: readonly AssumptionProfile[] = [
  {
    id: 'cautious',
    label: 'cautious assumptions',
    assumptions: {
      mobileFraction: 0.7,
      departureDelayMinutes: 30,
      vehicleOccupancy: 1.2,
      speedByHighway: speedsAt(0.7),
      capacityPerHour: capacitiesAt(0.6),
    },
  },
  {
    id: 'optimistic',
    label: 'optimistic assumptions',
    assumptions: {
      mobileFraction: 0.9,
      departureDelayMinutes: 5,
      vehicleOccupancy: 1.6,
      speedByHighway: speedsAt(1.15),
      capacityPerHour: capacitiesAt(1.2),
    },
  },
];

// Refused at load rather than at the first request that happens to use the profile. A
// profile with a zero speed or a zero capacity produces a plausible-looking number that is
// wrong in the permissive direction, and the place to find that out is startup.
for (const profile of ASSUMPTION_PROFILES) assertProfile(profile);

export function profileById(id: string): AssumptionProfile | undefined {
  return ASSUMPTION_PROFILES.find((p) => p.id === id);
}

/**
 * Travel time for an edge under a swept speed, from the committed time rather than from
 * geometry.
 *
 * Scaling the committed value rather than recomputing from the polyline is deliberate. The
 * fetch script measures distance with an equirectangular approximation, this engine
 * measures it with WGS84, and the two disagree by enough to move 628 of 29,834 edges by a
 * second. Recomputing would therefore shift every travel time in the graph the moment this
 * module was introduced, and a change meant to widen the published uncertainty would be
 * indistinguishable from a change to the model. Scaling the committed number makes the
 * nominal case an exact identity, which is the property the test suite pins.
 *
 * `max(1, ...)` is load-bearing: a zero travel time is refused by the graph loader and
 * breaks the monotonicity argument the solve's correctness rests on.
 */
export function scaledTravelSeconds(
  committedSeconds: number,
  nominalSpeedKmh: number,
  sweptSpeedKmh: number,
): number {
  assertPositiveSpeed(nominalSpeedKmh, 'nominal');
  assertPositiveSpeed(sweptSpeedKmh, 'swept');
  return Math.max(1, Math.round((committedSeconds * nominalSpeedKmh) / sweptSpeedKmh));
}

function assertPositiveSpeed(value: number, which: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`the ${which} speed must be a positive, finite km/h value; got ${value}`);
  }
}

/**
 * A copy of the graph with travel times scaled to a swept speed table.
 *
 * A road class the swept table does not mention keeps its committed travel time rather than
 * being dropped or scaled by an implied zero — a profile that says nothing about tracks has
 * not said tracks are impassable.
 */
export function withAssumedSpeeds(
  graph: RoadGraph,
  nominal: Record<string, number>,
  swept: Record<string, number>,
): RoadGraph {
  const edges = graph.edges.map((edge) => {
    const from = nominal[edge.highway];
    const to = swept[edge.highway];
    if (from === undefined || to === undefined) return edge;
    if (!Number.isFinite(from) || from <= 0 || !Number.isFinite(to) || to <= 0) {
      throw new RangeError(
        `profile scaling is unusable for highway "${edge.highway}": ${from} km/h nominal, ${to} km/h swept`,
      );
    }
    const travelSeconds = scaledTravelSeconds(edge.travelSeconds, from, to);
    return travelSeconds === edge.travelSeconds ? edge : { ...edge, travelSeconds };
  });
  // Only the edges are rebuilt. `outgoing` and `incoming` are index-based, so they survive
  // the copy untouched and no reindexing is needed.
  return { ...graph, edges };
}

/** Refuse a profile whose values cannot produce a meaningful number. */
export function assertProfile(profile: AssumptionProfile): void {
  const { id, assumptions } = profile;
  const bad = (what: string, value: number): never => {
    throw new RangeError(`assumption profile "${id}" has an unusable ${what}: ${value}`);
  };
  if (!Number.isFinite(assumptions.mobileFraction) || assumptions.mobileFraction <= 0 || assumptions.mobileFraction > 1) {
    bad('mobileFraction', assumptions.mobileFraction);
  }
  if (!Number.isFinite(assumptions.vehicleOccupancy) || assumptions.vehicleOccupancy <= 0) {
    bad('vehicleOccupancy', assumptions.vehicleOccupancy);
  }
  if (!Number.isFinite(assumptions.departureDelayMinutes) || assumptions.departureDelayMinutes < 0) {
    bad('departureDelayMinutes', assumptions.departureDelayMinutes);
  }
  for (const [highway, speed] of Object.entries(assumptions.speedByHighway)) {
    if (!Number.isFinite(speed) || speed <= 0) bad(`speed for ${highway}`, speed);
  }
  for (const [highway, capacity] of Object.entries(assumptions.capacityPerHour)) {
    if (!Number.isFinite(capacity) || capacity <= 0) bad(`capacity for ${highway}`, capacity);
  }
}
