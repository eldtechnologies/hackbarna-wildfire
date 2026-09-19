import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildEgress, loadContext } from './egress';
import { buildAlerts } from './alerts';
import { nearestNode } from './graph';

const ctx = loadContext();

// The window end the engine itself publishes, so these assertions describe the same
// window the response does rather than a constant copied out of a probe run.
const base = buildEgress({}).diagnostics;
const originSeconds = Date.parse(base.originIso) / 1000;
const windowEndSeconds = Date.parse(base.windowEnd) / 1000 - originSeconds;

const bedarNode = ((): number => {
  const bedar = ctx.settlements.find((s) => s.id === 'bedar');
  assert.ok(bedar, 'fixture sanity: Bedar is in the settlement list');
  const node = nearestNode(ctx.graph, { lat: bedar.lat, lon: bedar.lon });
  assert.ok(node !== null, 'fixture sanity: Bedar snaps to the road graph');
  return node;
})();

test("a published departure is a departure, not the pocket's own burn deadline", () => {
  // The node deadline means "be gone before the fire arrives here". While the pocket was
  // left in its own destination set, the solve's value at the pocket was at least that
  // seed, so ten of the twelve configurations published the moment the fire reaches the
  // village — 19:38:21 CEST, the AL-6109 cut time — as the latest departure. It read as
  // 134 seconds MORE time than any route the same response published, which is the
  // permissive direction, and it is the number a coordinator would have acted on.
  const { diagnostics } = buildEgress({});
  const published = new Map(diagnostics.sweep.map((s) => [s.id, s.departureSeconds]));

  let checked = 0;
  for (const [id, departure] of published) {
    if (departure === null) continue;
    const burn = ctx.sweep.nodeCutByConfig.get(id)?.[bedarNode];
    assert.ok(burn !== undefined, `${id} has a node cut field`);
    if (!Number.isFinite(burn)) continue;
    checked += 1;
    assert.ok(
      departure < burn,
      `${id} published ${departure} as a departure, at or after the fire reaches the pocket (${burn})`,
    );
  }
  assert.ok(checked >= 10, `expected most configurations to be checkable, checked ${checked}`);
});

test('an unbounded departure publishes the window-end clamp, never null', () => {
  // +Infinity here means no configuration closes any route inside the window. Mapping it
  // to null inverted the meaning: null is the contract's word for "cut", so an unbounded
  // deadline — the safest state there is — was published as the most alarming one.
  const { diagnostics } = buildEgress({});
  const hundred = diagnostics.sweep.find((s) => s.id === 'all-100m');
  assert.ok(hundred, 'the 100 m configuration ships');
  assert.equal(
    hundred.departureSeconds,
    windowEndSeconds,
    'the 100 m mask never closes a route, so its departure is the end of the window',
  );
});

test('the cursor masks the destination deadline as well as the road cut', () => {
  // At cursor 0 no detection has arrived, so nothing is known and no deadline exists.
  // Left unmasked the node field enforced burn times from the 10th of July — evidence
  // the replay itself says was not yet in hand — so early cursors were bounded by the
  // future instead of by what a coordinator could have known.
  const { diagnostics } = buildEgress({ atSeconds: 0 });
  for (const s of diagnostics.sweep) {
    assert.equal(
      s.departureSeconds,
      windowEndSeconds,
      `${s.id} enforced a deadline at cursor 0, before any detection had arrived`,
    );
  }
});

test('nothing observed is its own verdict, not an all-clear', () => {
  // Before the first detection arrives the cut field is empty, so every band is unbounded
  // and every route survives the gate trivially. A two-valued verdict reported
  // `routes_open` on that, which is the most consequential sentence this response can
  // publish, produced by no data at all.
  const nothing = buildEgress({ atSeconds: 0 }).response.pockets[0];
  assert.equal(nothing.verdict, 'not_yet_observed');

  // And the alert layer must not compose an evacuation out of it. At 17:00 a real route
  // is known and the sentence names a real road; at 00:00 there is no route to name.
  const silent = buildAlerts({ atSeconds: 0 });
  for (const pkg of silent.response.packages) {
    assert.equal(pkg.instruction, 'no_verified_action', 'no evacuation is composed before anything is observed');
  }
});

test('the timeline is three states with two transitions', () => {
  // The whole replay, asserted because the transitions are the demo's most
  // consequential numbers and both moved when the node field started being masked.
  const verdictAt = (h: number): string => buildEgress({ atSeconds: h * 3600 }).response.pockets[0].verdict;

  assert.equal(verdictAt(0), 'not_yet_observed', 'nothing has arrived yet');
  assert.equal(verdictAt(17), 'routes_open', 'at 17:00 CEST a route is known and still open');
  assert.equal(verdictAt(19), 'no_verified_action', 'by 19:00 CEST the decision is already late');

  // The verdict is not decoration: it is what the message layer gates on, so each state
  // has to carry a different instruction or the third state would buy nothing.
  assert.equal(buildAlerts({ atSeconds: 17 * 3600 }).response.packages[0]?.instruction, 'evacuate_alternate');
  assert.equal(buildAlerts({ atSeconds: 19 * 3600 }).response.packages[0]?.instruction, 'no_verified_action');
});
