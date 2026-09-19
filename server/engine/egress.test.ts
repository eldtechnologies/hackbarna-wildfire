import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildEgress, loadContext } from './egress';
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

test('a cursor before the fire is observed reports the routes open, and changes once it is', () => {
  // The whole timeline is two states with one transition. It is asserted because the
  // transition is the demo's most consequential number, and because it moved when the
  // node field started being masked.
  const before = buildEgress({ atSeconds: 17 * 3600 }).response.pockets[0];
  assert.equal(before.verdict, 'routes_open', 'at 17:00 CEST nothing is known and the road is open');

  const after = buildEgress({ atSeconds: 19 * 3600 }).response.pockets[0];
  assert.equal(after.verdict, 'no_verified_action', 'by 19:00 CEST the decision is already late');
});
