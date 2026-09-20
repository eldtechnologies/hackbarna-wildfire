// The prototype-chain lookup, and the four tables it was found in.
//
// `TABLE[key] ?? fallback` is the obvious spelling and it is wrong whenever the key comes from
// data. For `key = 'constructor'` the lookup returns the `Object` function; for `'__proto__'` it
// returns `Object.prototype`. Both are truthy, so the fallback never fires and the value flows on.
//
// It was found four times, in four tables, each with a different consequence — which is why the fix
// is one function in `tables.ts` and why this file tests the function and each site:
//
//   * `SENSOR_FAMILY`   — a family that was not a string, reaching the wire as `{"family":{}}`
//   * `SENSOR_FOOTPRINT_M` — `Object * scale` is NaN, and every `distanceM > NaN` is false, so the
//     detection was treated as reaching every road segment in the graph
//   * `LATENCY_SECONDS` — the NaN reached a `Float64Array` and every `cut + NaN <= cursor` was
//     false, so the engine stopped marking roads cut and published `not_yet_observed` where the
//     same capture with an unknown source name publishes `no_verified_action`
//   * the speed and capacity tables — a `RangeError` out of `withAssumedSpeeds`, failing every
//     engine route closed
//
// The keys are data. A closed set of literals would not need any of this.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ownLookup } from './tables';
import { withAssumedSpeeds } from './assumptions';
import { DEFAULT_LATENCY_SECONDS, LATENCY_SECONDS } from './time';
import { latencyFor } from './egress';
import type { RoadGraph } from './solve';

/** Every name that resolves through `Object.prototype` rather than through the table. */
const HOSTILE = [
  '__proto__',
  'constructor',
  'toString',
  'valueOf',
  'hasOwnProperty',
  'isPrototypeOf',
  '__defineGetter__',
  'propertyIsEnumerable',
];

test('a table lookup returns nothing for a key that only the prototype has', () => {
  const table: Record<string, number> = { primary: 80, track: 15 };

  // The plain spelling, for contrast: this is what the sites used to do, and why a fallback
  // written beside it never fired.
  assert.equal(typeof (table as Record<string, unknown>)['constructor'], 'function');
  assert.equal(typeof (table as Record<string, unknown>)['__proto__'], 'object');

  for (const key of HOSTILE) {
    assert.equal(ownLookup(table, key), undefined, `${key} is not an entry in the table`);
  }

  // And it still reads what is actually there, including a key that is easy to get wrong.
  assert.equal(ownLookup(table, 'primary'), 80);
  assert.equal(ownLookup(table, 'toString'), undefined, 'and an absent own key stays absent');
});

test('the latency table cannot answer with a member of Object', () => {
  // Not an abstract property: this table's lookup feeds the latency `Float64Array`, and a NaN
  // there makes every `cut + NaN <= cursor` false, so the engine stops marking roads cut.
  for (const key of HOSTILE) {
    const latency = ownLookup(LATENCY_SECONDS, key);
    assert.equal(latency, undefined, `${key} must not resolve to a latency`);
  }
  assert.ok(Object.keys(LATENCY_SECONDS).length > 0, 'the table is not empty, so the check means something');
});

test('a graph carrying a highway named after an Object member is left alone, not thrown on', () => {
  // The second site, and the one whose bare lookup failed closed rather than silently: the value
  // it returned was a function, so `from`/`to` were neither undefined nor finite and
  // `withAssumedSpeeds` threw a RangeError out of context load — taking every engine route down
  // with a 502. The intended behaviour for a class the profile says nothing about is to keep the
  // committed travel time, which is what an absent entry already means.
  const graph: RoadGraph = {
    nodes: [{ lat: 37.17, lon: -2.01 }, { lat: 37.18, lon: -2.02 }],
    edges: [
      {
        id: 'e-hostile', from: 0, to: 1,
        geometry: [{ lat: 37.17, lon: -2.01 }, { lat: 37.18, lon: -2.02 }],
        highway: 'constructor', name: null, travelSeconds: 600,
      },
      {
        id: 'e-known', from: 0, to: 1,
        geometry: [{ lat: 37.17, lon: -2.01 }, { lat: 37.18, lon: -2.02 }],
        highway: 'track', name: null, travelSeconds: 600,
      },
    ],
    outgoing: [[0, 1], []],
    incoming: [[], [0, 1]],
  };

  const scaled = withAssumedSpeeds(graph, { track: 15 }, { track: 7.5 });
  assert.equal(scaled.edges[0].travelSeconds, 600, 'the unrecognised class keeps its committed time');
  assert.equal(scaled.edges[1].travelSeconds, 1200, 'and the recognised one is still scaled');
});

test('the latency lookup used by the engine refuses a prototype member', () => {
  // The site itself, not only the helper — `latencyFor` is what `loadContext` and the
  // known-cut test both call, and it is exported so this can reach it.
  for (const key of HOSTILE) {
    assert.equal(
      latencyFor(key),
      DEFAULT_LATENCY_SECONDS,
      `${key} must fall back to the default latency, not to a member of Object`,
    );
    assert.ok(Number.isFinite(latencyFor(key)), 'and the value must be a usable number');
  }

  // A genuinely known source still gets its own latency, so the fallback has not eaten the table.
  const known = Object.keys(LATENCY_SECONDS)[0];
  if (known !== undefined) {
    assert.equal(latencyFor(known), LATENCY_SECONDS[known]);
  }
});
