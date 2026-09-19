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
  NOMINAL_SPEED_KMH,
  assertProfile,
  scaledTravelSeconds,
  withAssumedSpeeds,
} from './assumptions';
import type { RoadGraph } from './solve';
import { loadGraph } from './graph';
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

test('the swept profiles bracket the nominal table and sit either side of it', () => {
  const ids = ASSUMPTION_PROFILES.map((p) => p.id);
  assert.equal(new Set(ids).size, ids.length, 'profile ids are unique');
  for (const profile of ASSUMPTION_PROFILES) assertProfile(profile);

  // Neither swept end is the centre. A band is an envelope, so a nominal profile among
  // these could never attain either end — measured on the committed capture it strictly
  // attained 0 of 48 configuration-by-destination ends — and it would cost a third of the
  // solve budget to publish a value nothing reads. The centre survives as the table below,
  // which is what the response publishes as `assumptions`.
  assert.ok(!ids.includes('nominal'), 'the nominal centre is a table, not a swept profile');

  const cautious = ASSUMPTION_PROFILES.find((p) => p.id === 'cautious')!;
  const optimistic = ASSUMPTION_PROFILES.find((p) => p.id === 'optimistic')!;
  for (const [highway, nominal] of Object.entries(NOMINAL_SPEED_KMH)) {
    assert.ok(
      cautious.assumptions.speedByHighway[highway] <= nominal,
      `cautious must not be faster than the nominal table on ${highway}`,
    );
    assert.ok(
      optimistic.assumptions.speedByHighway[highway] >= nominal,
      `optimistic must not be slower than the nominal table on ${highway}`,
    );
  }
});

test('an invalid profile is refused at construction, naming what is wrong', () => {
  const nominal = ASSUMPTION_PROFILES[0];
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

test('the nominal table is the one the committed graph was built with', () => {
  // Source of expected: the committed graph file itself, which is what scripts/fetch-roads.mjs
  // computed the committed travelSeconds from.
  // Read from the committed graph rather than compared against literals. The profiles scale
  // from this table while the engine scales with the graph's own `speedByHighway`, so a
  // refetch that changed one class speed would leave "cautious is never faster than the
  // nominal table" true against a copy and false against the published nominal — silently
  // inverting the label in the permissive direction. Three spot values would not catch that.
  const loaded = loadGraph();
  assert.deepEqual(
    NOMINAL_SPEED_KMH,
    loaded.speedByHighway,
    'the sweep scales from this table, so it must be the table the committed travel times came from',
  );
});
