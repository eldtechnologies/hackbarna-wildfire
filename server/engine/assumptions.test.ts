// The assumption axis: travel times scaled by a swept speed table, and the profiles the
// whole sweep is built from.
//
// The property that matters most here is the identity: under the nominal speed table the
// scaling must return the committed travel time exactly. Without that, every band in the
// response shifts the moment this code is introduced, and a change meant to widen the
// published uncertainty would instead be indistinguishable from a change to the model.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ASSUMPTION_PROFILES,
  NOMINAL_PROFILE_ID,
  assertProfile,
  scaledTravelSeconds,
  withAssumedSpeeds,
} from './assumptions';
import type { RoadGraph } from './solve';
import type { LatLon } from '../../shared/fires';

const SPEEDS: Record<string, number> = { primary: 80, track: 15, service: 20 };

/** A one-edge graph, so the scaling is read directly rather than inferred from a solve. */
function graphWith(travelSeconds: number, highway = 'primary'): RoadGraph {
  const a: LatLon = { lat: 37.1, lon: -2.0 };
  const b: LatLon = { lat: 37.11, lon: -2.0 };
  return {
    nodes: [a, b],
    edges: [{ id: 'way/1', from: 0, to: 1, geometry: [a, b], highway, name: null, travelSeconds }],
    outgoing: [[0], []],
    incoming: [[], [0]],
  };
}

test('scaling is exactly the committed travel time under the nominal speed table', () => {
  // Source of expected: the committed value itself. Recomputing a travel time under the
  // same speeds that produced it must not move it — 3600 s is the value being preserved.
  assert.equal(scaledTravelSeconds(3600, 80, 80), 3600);
  // Source of expected: the committed graph's distribution, which is integers throughout.
  assert.equal(scaledTravelSeconds(1816, 15, 15), 1816);
});

test('halving the speed doubles the travel time, and halving it again halves nothing', () => {
  // Source of expected: 10 km at 80 km/h is 450 s; at 40 km/h it is 900 s. The
  // discriminating input is a class whose swept speed differs from nominal by exactly 2x,
  // where the inverted implementation would give 450 -> 225.
  assert.equal(scaledTravelSeconds(450, 80, 40), 900);
  // And the other direction, so an implementation that always lengthens is also caught.
  assert.equal(scaledTravelSeconds(450, 40, 80), 225);
});

test('a short edge at a low speed never rounds to zero travel time', () => {
  // Source of expected: 5 m at 20 km/h is 0.9 s, which rounds to 1. A zero would be
  // refused by the graph loader and breaks the solve's monotonicity argument, so the
  // floor is the point of this test rather than the rounding.
  assert.equal(scaledTravelSeconds(1, 20, 200), 1);
  assert.ok(scaledTravelSeconds(1, 20, 100000) >= 1);
});

test('a missing or unusable speed is refused rather than silently scaling by zero', () => {
  assert.throws(() => scaledTravelSeconds(100, 80, 0), RangeError);
  assert.throws(() => scaledTravelSeconds(100, 80, -40), RangeError);
  assert.throws(() => scaledTravelSeconds(100, 80, Number.NaN), RangeError);
  assert.throws(() => scaledTravelSeconds(100, 0, 40), RangeError);
});

test('a speed table is applied per road class, leaving other classes untouched', () => {
  const graph = graphWith(450, 'primary');
  const scaled = withAssumedSpeeds(graph, SPEEDS, { ...SPEEDS, primary: 40 });
  assert.equal(scaled.edges[0].travelSeconds, 900, 'the swept class is rescaled');
  // Topology is index-based and must survive the copy.
  assert.equal(scaled.edges[0].from, 0);
  assert.deepEqual(scaled.incoming, [[], [0]]);

  const untouched = withAssumedSpeeds(graph, SPEEDS, { ...SPEEDS, track: 7 });
  assert.equal(untouched.edges[0].travelSeconds, 450, 'an untouched class is identical');
});

test('a class absent from the swept table falls back to nominal rather than dropping out', () => {
  const graph = graphWith(3600, 'track');
  // The profile says nothing about `track`, which the graph uses. Identity, not removal.
  const scaled = withAssumedSpeeds(graph, SPEEDS, { primary: 40 });
  assert.equal(scaled.edges.length, 1);
  assert.equal(scaled.edges[0].travelSeconds, 3600);
});

test('the profiles bracket the nominal centre and are conventionally ordered', () => {
  const ids = ASSUMPTION_PROFILES.map((p) => p.id);
  assert.ok(ids.includes(NOMINAL_PROFILE_ID), 'the nominal profile is present by id');
  assert.equal(new Set(ids).size, ids.length, 'profile ids are unique');
  for (const profile of ASSUMPTION_PROFILES) {
    assertProfile(profile);
  }
  const nominal = ASSUMPTION_PROFILES.find((p) => p.id === NOMINAL_PROFILE_ID)!;
  const cautious = ASSUMPTION_PROFILES.find((p) => p.id === 'cautious')!;
  const optimistic = ASSUMPTION_PROFILES.find((p) => p.id === 'optimistic')!;
  for (const highway of Object.keys(nominal.assumptions.speedByHighway)) {
    const n = nominal.assumptions.speedByHighway[highway];
    assert.ok(
      cautious.assumptions.speedByHighway[highway] <= n,
      `cautious must not be faster than nominal on ${highway}`,
    );
    assert.ok(
      optimistic.assumptions.speedByHighway[highway] >= n,
      `optimistic must not be slower than nominal on ${highway}`,
    );
  }
});

test('an invalid profile is refused at construction, naming what is wrong', () => {
  const nominal = ASSUMPTION_PROFILES.find((p) => p.id === NOMINAL_PROFILE_ID)!;
  assertProfile(nominal);
  assert.throws(
    () => assertProfile({ ...nominal, id: 'bad', assumptions: { ...nominal.assumptions, mobileFraction: 0 } }),
    RangeError,
  );
  assert.throws(
    () => assertProfile({ ...nominal, id: 'bad', assumptions: { ...nominal.assumptions, vehicleOccupancy: 0 } }),
    RangeError,
  );
  assert.throws(
    () =>
      assertProfile({
        ...nominal,
        id: 'bad',
        assumptions: { ...nominal.assumptions, capacityPerHour: { ...nominal.assumptions.capacityPerHour, track: 0 } },
      }),
    RangeError,
  );
});

test('the nominal profile carries the graph speed table the committed graph was built with', () => {
  const nominal = ASSUMPTION_PROFILES.find((p) => p.id === NOMINAL_PROFILE_ID)!;
  // Source of expected: scripts/fetch-roads.mjs HIGHWAY_SPEED_KMH, which is what the
  // committed travelSeconds were computed from. If these diverge, the identity property
  // above still holds per-edge but the "nominal" label is no longer the committed reality.
  assert.equal(nominal.assumptions.speedByHighway.primary, 80);
  assert.equal(nominal.assumptions.speedByHighway.track, 15);
  assert.equal(nominal.assumptions.speedByHighway.motorway, 100);
});
