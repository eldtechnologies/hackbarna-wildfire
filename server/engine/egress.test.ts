import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildEgress, extremesBy, loadContext, routeBasisFor } from './egress';
import { buildAlerts } from './alerts';
import { nearestNode } from './graph';
import { ASSUMPTION_PROFILES, withAssumedSpeeds } from './assumptions';
import { allNodesSafe, bottleneckOf, latestDeparture } from './solve';
import { SWEEP_CONFIGS } from './sweep';
import { DEFAULT_LATENCY_SECONDS } from './time';

/**
 * A ledger path in a temporary directory.
 *
 * Every call gets its own by default, because the store makes a repeated cursor return the
 * RECORDED entry rather than a fresh computation — so a shared path would turn any test
 * that asks for a cursor twice into a test of the store, and would make the suite's result
 * depend on what an earlier run left behind in the working tree.
 */
function tmpLedger(): string {
  return join(mkdtempSync(join(tmpdir(), 'alerts-ledger-')), 'recommendations.jsonl');
}

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

  // The property is asserted for every combination of configuration and assumption
  // profile, not for the nominal one alone. A profile scales travel times, so it could in
  // principle move the published value back onto the pocket's own deadline — the exact
  // permissive inversion this test exists to catch — and only checking the nominal profile
  // would miss it.
  let checked = 0;
  for (const { configId, profileId, departureSeconds } of diagnostics.sweep) {
    if (departureSeconds === null) continue;
    const burn = ctx.sweep.nodeCutByConfig.get(configId)?.[bedarNode];
    assert.ok(burn !== undefined, `${configId} has a node cut field`);
    if (!Number.isFinite(burn)) continue;
    checked += 1;
    assert.ok(
      departureSeconds < burn,
      `${profileId}/${configId} published ${departureSeconds} as a departure, at or after the ` +
        `fire reaches the pocket (${burn})`,
    );
  }
  // Most combinations must actually be checkable, or the loop above proves nothing. The
  // bound is derived from the sweep rather than hardcoded, so adding or removing a profile
  // moves it — a fixed number written for one sweep size silently becomes vacuous when the
  // sweep changes underneath it.
  const combinations = ASSUMPTION_PROFILES.length * SWEEP_CONFIGS.length;
  assert.ok(
    checked >= Math.floor(combinations * 0.8),
    `expected most of the ${combinations} combinations to be checkable, checked ${checked}`,
  );
});

test('an unbounded departure publishes the window-end clamp, never null', () => {
  // +Infinity here means no configuration closes any route inside the window. Mapping it
  // to null inverted the meaning: null is the contract's word for "cut", so an unbounded
  // deadline — the safest state there is — was published as the most alarming one.
  const { diagnostics } = buildEgress({});
  const hundreds = diagnostics.sweep.filter((s) => s.configId === 'all-100m');
  assert.equal(
    hundreds.length,
    ASSUMPTION_PROFILES.length,
    'the 100 m configuration ships under every swept profile',
  );
  for (const entry of hundreds) {
    // The clamp is a property of the mask, not of the assumptions: a profile that scales
    // travel times changes how long the drive takes, not whether any road is ever cut.
    assert.equal(
      entry.departureSeconds,
      windowEndSeconds,
      `the 100 m mask never closes a route under ${entry.profileId}, so its departure is the end of the window`,
    );
  }
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
  const silent = buildAlerts({ atSeconds: 0, ledgerPath: tmpLedger() });
  for (const pkg of silent.response.packages) {
    assert.equal(pkg.instruction, 'no_verified_action', 'no evacuation is composed before anything is observed');
  }
});

test('a pocket with no observation says so in every artifact of the same response', () => {
  // The state is only worth having if the whole response carries it. It reached the
  // verdict and nothing else, so at cursor 0 the response published four routes with
  // `usable: true` — surviving a gate they were never put through — beside a verdict
  // saying none could be assessed, and a ledger line asserting that no route survived
  // the sweep. Three artifacts of one response, three different stories.
  const pocket = buildEgress({ atSeconds: 0 }).response.pockets[0];
  assert.equal(pocket.verdict, 'not_yet_observed');
  for (const route of pocket.routes) {
    assert.equal(route.usable, false, `${route.destination} was usable before anything had been observed`);
    assert.match(route.unusableReason ?? '', /no detection has arrived/);
  }

  // The audit line has to describe the search that happened, which was none. "No route
  // survived the sweep" would read as a search that came up empty.
  const ledger = buildAlerts({ atSeconds: 0, ledgerPath: tmpLedger() }).ledger[0];
  assert.match(ledger.evidence[0], /no detection had arrived/, `ledger says: ${ledger.evidence[0]}`);
  assert.doesNotMatch(ledger.evidence[0], /no route survived the sweep/);
});

test('a band never claims more contributing configurations than produced it', () => {
  // `basisFor` takes the contributor count and documents why it must be passed, and the
  // per-segment call did not pass it — so most of the served field claimed all twelve
  // configurations while fewer than twelve had closed the segment inside the window. A
  // provenance line that overstates the evidence is worse than no line.
  const segments = buildEgress({}).response.segments;
  const banded = segments.filter((s) => s.band !== null);
  assert.ok(banded.length > 0, 'fixture sanity: some segments carry a band');

  let underTwelve = 0;
  for (const s of banded) {
    const basis = s.band!.basis;
    const claimed = /across (\d+) of 12 configurations/.exec(basis);
    if (claimed) {
      underTwelve += 1;
      const n = Number(claimed[1]);
      assert.ok(n >= 1 && n < 12, `a contributor count must be a real subset of the sweep, got ${n}`);
    }
    assert.doesNotMatch(
      basis,
      /across 12 configurations \(0 never close/,
      'a count of twelve cannot also be a subset',
    );
  }
  assert.ok(underTwelve > 0, 'on this capture most segments are cut by fewer than twelve configurations');
});

test('the timeline is three states with two transitions', () => {
  // The whole replay, asserted because the transitions are the demo's most
  // consequential numbers and both moved when the node field started being masked.
  //
  // `atSeconds` counts from the scenario ORIGIN, which for this capture is 00:00Z on
  // 9 July — so hour 17 is 19:00 CEST, not 17:00. The earlier wording here said "17:00
  // CEST" while the arithmetic was hours from origin, which is an invitation to a later
  // reader to "fix" the code to match the comment.
  //
  // Both transitions were re-measured when the assumption axis landed and are unchanged:
  // the band stays unbounded — hence trivially gating open — until hour 18, and the
  // moment it becomes finite the gate fails under either assumption set.
  const verdictAt = (h: number): string => buildEgress({ atSeconds: h * 3600 }).response.pockets[0].verdict;

  assert.equal(verdictAt(0), 'not_yet_observed', 'nothing has arrived yet');
  assert.equal(verdictAt(17), 'routes_open', 'the band is still unbounded, so a route gates open');
  assert.equal(verdictAt(19), 'no_verified_action', 'the band is finite and the decision is already late');

  // The verdict is not decoration: it is what the message layer gates on, so each state
  // has to carry a different instruction or the third state would buy nothing.
  assert.equal(buildAlerts({ atSeconds: 17 * 3600, ledgerPath: tmpLedger() }).response.packages[0]?.instruction, 'evacuate_alternate');
  assert.equal(buildAlerts({ atSeconds: 19 * 3600, ledgerPath: tmpLedger() }).response.packages[0]?.instruction, 'no_verified_action');
});

// ---------------------------------------------------------------------------------------
// The assumption axis. Each test below is the verification command for one acceptance
// criterion of issue #25, and each is named so the gate's --test-name-pattern finds it.
// ---------------------------------------------------------------------------------------

/** The cursor masking, re-derived here rather than imported, so a test can recompute what
 *  a named combination should have produced without borrowing the engine's own answer. */
function maskedField(configId: string, cursor: number): { cuts: number[]; nodeCut: number[] } {
  const rawCut = ctx.sweep.cutByConfig.get(configId);
  const rawNode = ctx.sweep.nodeCutByConfig.get(configId);
  const latency = ctx.sweep.latencyByConfig.get(configId);
  const edgeCount = ctx.graph.edges.length;
  const cuts = new Array<number>(edgeCount).fill(Number.POSITIVE_INFINITY);
  const nodeCut = allNodesSafe(ctx.graph.nodes.length);
  if (rawCut) {
    for (let i = 0; i < edgeCount; i++) {
      const c = rawCut[i];
      if (!Number.isFinite(c)) continue;
      if (c + (latency ? latency[i] : DEFAULT_LATENCY_SECONDS) <= cursor) cuts[i] = c;
    }
  }
  if (rawNode) {
    for (let i = 0; i < nodeCut.length; i++) {
      const c = rawNode[i];
      if (!Number.isFinite(c)) continue;
      if (c + (latency ? latency[edgeCount + i] : DEFAULT_LATENCY_SECONDS) <= cursor) nodeCut[i] = c;
    }
  }
  return { cuts, nodeCut };
}

/** The departure a named (profile, configuration) combination produces for one destination. */
function recomputeDeparture(configId: string, profileId: string, cursor: number, destNode: number): number {
  const profile = ASSUMPTION_PROFILES.find((p) => p.id === profileId);
  assert.ok(profile, `profile ${profileId} exists`);
  const graph = withAssumedSpeeds(ctx.graph, ctx.loaded.speedByHighway, profile.assumptions.speedByHighway);
  const { cuts, nodeCut } = maskedField(configId, cursor);
  return latestDeparture(graph, cuts, [destNode], { nodeCutSeconds: nodeCut }).latestDeparture[bedarNode];
}

function destNodeFor(destination: string): number {
  const settlement = ctx.settlements.find((s) => s.name === destination);
  assert.ok(settlement, `route names a settlement the fixture holds: ${destination}`);
  const node = nearestNode(ctx.graph, { lat: settlement.lat, lon: settlement.lon });
  assert.ok(node !== null, `${destination} snaps to the road graph`);
  return node;
}

test('each band end is attained by a named combination of configuration and assumption profile', () => {
  const cursor = 20 * 3600;
  const built = buildEgress({ atSeconds: cursor });
  const originSeconds = Date.parse(built.diagnostics.originIso) / 1000;
  const pocket = built.response.pockets[0];
  assert.ok(pocket, 'fixture sanity: the pocket is published');

  let attributed = 0;
  for (const route of pocket.routes) {
    const band = route.lastSafeDeparture;
    if (!band || band.basis.startsWith('no combination')) continue;

    // "earliest from <config> under <profile>; latest from <config> under <profile>; ..."
    const parsed = /^earliest from (.+?) under (.+?); latest from (.+?) under (.+?);/.exec(band.basis);
    assert.ok(parsed, `the basis does not attribute both ends to a named combination: ${band.basis}`);
    const [, eConfigLabel, eProfileLabel, lConfigLabel, lProfileLabel] = parsed;

    const eConfig = SWEEP_CONFIGS.find((c) => c.label === eConfigLabel);
    const lConfig = SWEEP_CONFIGS.find((c) => c.label === lConfigLabel);
    const eProfile = ASSUMPTION_PROFILES.find((p) => p.label === eProfileLabel);
    const lProfile = ASSUMPTION_PROFILES.find((p) => p.label === lProfileLabel);
    assert.ok(
      eConfig && lConfig && eProfile && lProfile,
      `the basis names a combination that does not exist: ${band.basis}`,
    );

    // Recompute BOTH named ends from the named combination. A basis naming the wrong
    // profile still reads plausibly, and this is the only check that catches it: the value
    // has to come back out of the combination the string points at.
    const destNode = destNodeFor(route.destination);
    const expectedPessimistic = recomputeDeparture(eConfig.id, eProfile.id, cursor, destNode);
    assert.equal(
      Date.parse(band.earliest) / 1000 - originSeconds,
      Math.min(expectedPessimistic, windowEndSeconds),
      `basis names ${eProfile.id}/${eConfig.id} as the pessimistic end, but recomputing it gives a different value`,
    );
    // The optimistic half is checked whether or not a finite `latest` is published. On this
    // fixture every band's `latest` is null — some configuration never closes each route —
    // so a test that skipped the null case would never run the optimistic assertion at all,
    // and "recomputes the named end" would be indistinguishable from "recomputes the
    // cautious end twice". When `latest` is null the named combination must therefore
    // itself come back unbounded.
    const expectedOptimistic = recomputeDeparture(lConfig.id, lProfile.id, cursor, destNode);
    if (band.latest !== null) {
      assert.equal(
        Date.parse(band.latest) / 1000 - originSeconds,
        expectedOptimistic,
        `basis names ${lProfile.id}/${lConfig.id} as the optimistic end, but recomputing it gives a different value`,
      );
    } else {
      assert.equal(
        expectedOptimistic,
        Number.POSITIVE_INFINITY,
        `basis names ${lProfile.id}/${lConfig.id} as the optimistic end and publishes no ` +
          `latest, but that combination is bounded — so the named end is the wrong one`,
      );
    }
    attributed += 1;
  }
  assert.ok(attributed > 0, 'fixture sanity: at least one route publishes an attributed band');
});

test('changing a swept assumption value changes the published band', () => {
  const cursor = 20 * 3600;
  const built = buildEgress({ atSeconds: cursor });
  const originSeconds = Date.parse(built.diagnostics.originIso) / 1000;
  const pocket = built.response.pockets[0];

  // If the profile axis were declared but never solved, every profile's departure would be
  // identical and the published band would be exactly the nominal-only one. So the check is
  // not "the band exists" but "it is strictly wider than one profile's answer".
  const route = pocket.routes.find((r) => r.lastSafeDeparture !== null);
  assert.ok(route?.lastSafeDeparture, 'fixture sanity: a route publishes a band');
  const destNode = destNodeFor(route.destination);

  // The nominal answer is the committed graph, unscaled — it is the centre the profiles
  // bracket, not one of them.
  const { cuts: nominalCuts, nodeCut: nominalNodeCut } = maskedField('all-2x', cursor);
  const nominalOnly = latestDeparture(ctx.graph, nominalCuts, [destNode], {
    nodeCutSeconds: nominalNodeCut,
  }).latestDeparture[bedarNode];
  const cautious = recomputeDeparture('all-2x', 'cautious', cursor, destNode);
  const optimistic = recomputeDeparture('all-2x', 'optimistic', cursor, destNode);

  assert.ok(cautious < nominalOnly, `the cautious profile must move the departure earlier: ${cautious} vs ${nominalOnly}`);
  assert.ok(nominalOnly < optimistic, `the optimistic profile must move it later: ${nominalOnly} vs ${optimistic}`);

  const published = Date.parse(route.lastSafeDeparture.earliest) / 1000 - originSeconds;
  assert.ok(
    published < nominalOnly,
    `the published pessimistic end ${published} is not earlier than the nominal-only answer ` +
      `${nominalOnly}, so the assumption axis did not reach the band`,
  );
  assert.ok(published <= Math.min(cautious, windowEndSeconds) + 1);
});

test('every response prints the assumption set that produced its band', () => {
  // The band's basis names a profile by label. That is only useful if the reader can
  // resolve the label to the values behind it from the same response, so the swept set
  // travels with every answer — including the cursors where no band exists yet.
  for (const at of [undefined, 17 * 3600, 20 * 3600]) {
    const built = buildEgress(at === undefined ? {} : { atSeconds: at });
    const profiles = built.response.profiles;
    assert.equal(profiles.length, ASSUMPTION_PROFILES.length, 'the swept set is published in full');
    const publishedIds = new Set(profiles.map((p) => p.id));
    for (const profile of profiles) {
      assert.ok(profile.id.length > 0 && profile.label.length > 0, 'each profile is nameable');
      assert.ok(Number.isFinite(profile.assumptions.mobileFraction), `${profile.id} prints its mobile fraction`);
      assert.ok(Number.isFinite(profile.assumptions.vehicleOccupancy), `${profile.id} prints its occupancy`);
      assert.ok(Number.isFinite(profile.assumptions.departureDelayMinutes), `${profile.id} prints its delay`);
      assert.ok(
        Object.keys(profile.assumptions.speedByHighway).length > 0,
        `${profile.id} prints a speed table`,
      );
      assert.ok(
        Object.keys(profile.assumptions.capacityPerHour).length > 0,
        `${profile.id} prints a capacity table`,
      );
    }
    // Nothing may be cited that was not published: a basis naming a profile absent from
    // the list is a dead reference in a safety artifact.
    for (const pocket of built.response.pockets) {
      for (const route of pocket.routes) {
        const prose = `${route.lastSafeDeparture?.basis ?? ''} ${route.clearanceMinutes?.basis ?? ''}`;
        for (const profile of ASSUMPTION_PROFILES) {
          if (prose.includes(profile.label)) {
            assert.ok(publishedIds.has(profile.id), `${profile.id} is cited but not published`);
          }
        }
      }
    }
  }
});

test('clearance is a range across the swept assumptions, not a single number', () => {
  const cursor = 20 * 3600;
  const built = buildEgress({ atSeconds: cursor });
  const pocket = built.response.pockets[0];
  const population = ctx.settlements.find((s) => s.id === pocket.pocketId)?.population ?? null;
  assert.ok(population !== null && population > 0, 'fixture sanity: the pocket population is known');

  let checked = 0;
  for (const route of pocket.routes) {
    const range = route.clearanceMinutes;
    assert.ok(range, `${route.destination} publishes a clearance range`);

    // Recompute both ends per profile and check the DIRECTION against them, rather than
    // only that two numbers exist. Min and max are easy to swap, the swap is invisible in
    // the types, and it hands the gate an optimistic deadline.
    const perProfile = ASSUMPTION_PROFILES.map((profile) => {
      const a = profile.assumptions;
      const vehicles = (population * a.mobileFraction) / a.vehicleOccupancy;
      const bottleneck = bottleneckOf(
        {
          segmentIds: route.segmentIds,
          travelSeconds: 0,
          distanceKm: 0,
          slowestHighway: '',
          tightestEdgeId: null,
          tightestSlackSeconds: null,
        },
        ctx.graph,
        vehicles,
        a.capacityPerHour,
        600,
      );
      return { profile, minutes: bottleneck?.clearMinutes ?? Number.POSITIVE_INFINITY };
    });
    const worst = perProfile.reduce((x, y) => (y.minutes > x.minutes ? y : x));
    const best = perProfile.reduce((x, y) => (y.minutes < x.minutes ? y : x));

    assert.equal(
      range.pessimisticMinutes,
      Number(worst.minutes.toFixed(1)),
      `the pessimistic end is the largest clearance, attained by ${worst.profile.id}`,
    );
    assert.equal(
      range.optimisticMinutes,
      Number(best.minutes.toFixed(1)),
      `the optimistic end is the smallest clearance, attained by ${best.profile.id}`,
    );
    assert.ok(
      range.pessimisticMinutes > range.optimisticMinutes,
      'the swept assumptions must actually spread the clearance',
    );
    assert.ok(range.basis.includes(worst.profile.label), 'the basis names the pessimistic profile');
    assert.ok(range.basis.includes(best.profile.label), 'the basis names the optimistic profile');
    assert.match(range.basis, new RegExp(String(population)), 'the basis names the population it divided');
    checked += 1;
  }
  assert.ok(checked > 0, 'fixture sanity: the pocket publishes at least one route');
});

test('the gate reads the pessimistic end of the band and of the clearance range', () => {
  const cursor = 20 * 3600;
  const built = buildEgress({ atSeconds: cursor });
  const originSeconds = Date.parse(built.diagnostics.originIso) / 1000;
  const pocket = built.response.pockets[0];
  assert.equal(pocket.verdict, 'no_verified_action', 'fixture sanity: by 20:00Z the decision is late');

  const delay = Math.max(...ASSUMPTION_PROFILES.map((p) => p.assumptions.departureDelayMinutes));
  let checked = 0;
  for (const route of pocket.routes) {
    assert.ok(route.lastSafeDeparture && route.clearanceMinutes);
    assert.equal(route.usable, false, `${route.destination} must not read usable on a late decision`);

    // The published reason carries the arithmetic, so the exact number of minutes pins
    // WHICH clearance the gate subtracted. Reading the optimistic end would produce a
    // smaller lateness and a different string.
    const departure = Date.parse(route.lastSafeDeparture.earliest) / 1000 - originSeconds;
    const startBy = departure - route.clearanceMinutes.pessimisticMinutes * 60 - delay * 60;
    assert.equal(
      route.unusableReason,
      `the decision had to be made ${Math.round((cursor - startBy) / 60)} minutes ago to clear the bottleneck in time`,
      `${route.destination} was not gated on the pessimistic clearance`,
    );

    // And the choice is load-bearing, not cosmetic: the optimistic end would have granted
    // the coordinator real time back.
    const optimisticStartBy = departure - route.clearanceMinutes.optimisticMinutes * 60 - delay * 60;
    assert.ok(
      optimisticStartBy > startBy,
      'the optimistic clearance grants more time, so reading the wrong end changes the answer',
    );
    checked += 1;
  }
  assert.ok(checked > 0, 'fixture sanity: the pocket publishes at least one route');
});

test('the band basis names both axes distinctly when the ends come from different profiles', () => {
  // The committed fixture cannot exercise this: every published band has a null `latest`,
  // and both of its ends are attained under the cautious profile, so a basis that named one
  // profile for both ends would pass every test above. This drives the builder directly
  // with a pair the fixture does not produce.
  const basis = routeBasisFor(
    { configId: 'all-2x', profileId: 'cautious' },
    { configId: 'polar-1x', profileId: 'optimistic' },
    24,
    24,
  );

  const cautious = ASSUMPTION_PROFILES.find((p) => p.id === 'cautious')!;
  const optimistic = ASSUMPTION_PROFILES.find((p) => p.id === 'optimistic')!;
  const twoBy = SWEEP_CONFIGS.find((c) => c.id === 'all-2x')!;
  const polar = SWEEP_CONFIGS.find((c) => c.id === 'polar-1x')!;

  assert.match(basis, new RegExp(`earliest from ${twoBy.label} under ${cautious.label}`));
  assert.match(basis, new RegExp(`latest from ${polar.label} under ${optimistic.label}`));
  assert.match(basis, /across all 24 combinations/);

  // The wrong version names one profile for both ends. Assert per clause rather than by
  // counting occurrences: the pessimistic profile must sit in the pessimistic clause and
  // not in the optimistic one, which is the failure the fixture cannot produce.
  const clauses = /^earliest from (.+?); latest from (.+?);/.exec(basis);
  assert.ok(clauses, `the basis has two attributed clauses: ${basis}`);
  const [, pessimisticClause, optimisticClause] = clauses;
  assert.ok(pessimisticClause.includes(cautious.label), 'the pessimistic profile is in the pessimistic clause');
  assert.ok(
    !optimisticClause.includes(cautious.label),
    `the pessimistic profile must not be named on the optimistic end: ${optimisticClause}`,
  );
  assert.ok(optimisticClause.includes(optimistic.label), 'the optimistic profile is named on the optimistic end');
  assert.equal(
    basis.split(cautious.label).length - 1,
    1,
    'the pessimistic profile is named exactly once',
  );
});

test('a partially contributing basis reports the real denominator, not the full sweep', () => {
  const basis = routeBasisFor(
    { configId: 'all-1x', profileId: 'cautious' },
    { configId: 'all-1x', profileId: 'cautious' },
    9,
    24,
  );
  assert.match(basis, /across 9 of 24 combinations/);
  // The excluded combinations for a ROUTE band are the ones that found no route at all
  // (their value is -Infinity), not the ones that never closed the road. The segment bands
  // mean the latter, and carrying their wording here made the opposite and more reassuring
  // claim about what had been dropped.
  assert.match(basis, /15 found no route under these assumptions/);
  assert.doesNotMatch(basis, /never close this route inside the window/);
  assert.match(basis, /all contributing combinations agree/);
});

test('the extreme is selected by value, not by the profile label', () => {
  // The shipped profiles cannot produce a disagreement. Measured over every road class,
  // `cautious` is never faster than `optimistic` and never has a higher capacity, so it is
  // dominated on every axis and always IS the pessimistic end. A select-by-label
  // implementation would therefore return identical answers on every input this system can
  // generate, and every band test above would pass it. The seam is driven directly instead.
  const entry = (label: string, minutes: number) => ({ label, minutes });

  // The discriminating case: the label that promises the pessimistic end carries the
  // optimistic value. By value the pessimistic end is the other entry; by label it is this
  // one, and the two answers differ.
  const crossover = [entry('cautious assumptions', 180), entry('optimistic assumptions', 60)];
  const picked = extremesBy(crossover, (e) => e.minutes);
  assert.equal(picked.max.label, 'cautious assumptions', 'the largest value wins regardless of its name');
  assert.equal(picked.max.minutes, 180);
  assert.equal(picked.min.label, 'optimistic assumptions');
  assert.equal(picked.min.minutes, 60);

  // The same in the other direction, so an implementation that simply returns the last
  // entry as the maximum is also caught.
  const reversed = [entry('cautious assumptions', 60), entry('optimistic assumptions', 180)];
  const other = extremesBy(reversed, (e) => e.minutes);
  assert.equal(other.max.minutes, 180);
  assert.equal(other.min.minutes, 60);

  // Ties are deterministic rather than order-dependent.
  const tied = [entry('cautious assumptions', 120), entry('optimistic assumptions', 120)];
  const same = extremesBy(tied, (e) => e.minutes);
  assert.equal(same.max.minutes, 120);
  assert.equal(same.min.minutes, 120);

  assert.throws(() => extremesBy([], (e: { minutes: number }) => e.minutes), RangeError);
});

test('the published assumption tables are copies, not the objects the solver reads', () => {
  // The response is memoised and re-served, and the speed table it used to share is the
  // very table the solver scales travel times with — so an in-place edit through one
  // response would have changed the road network every later request was solved on, not
  // merely misprinted an assumption.
  const first = buildEgress({}).response;
  const solverTable = ctx.loaded.speedByHighway;

  assert.notEqual(first.assumptions.speedByHighway, solverTable, 'the published table is its own object');
  first.assumptions.speedByHighway.track = 999;
  assert.notEqual(solverTable.track, 999, 'a write through the response reached the solver');

  const second = buildEgress({}).response;
  assert.equal(second.assumptions.speedByHighway.track, solverTable.track, 'the solver is unchanged');
  for (const profile of second.profiles) {
    const source = ASSUMPTION_PROFILES.find((p) => p.id === profile.id)!;
    assert.notEqual(profile.assumptions.speedByHighway, source.assumptions.speedByHighway);
    assert.notEqual(profile.assumptions.capacityPerHour, source.assumptions.capacityPerHour);
  }
});

test('the published cut field is frozen, so a shared response cannot be edited in place', () => {
  // Hoisting the segments into the context made every response hand out the same 29,834
  // objects, which the per-request construction could not do. Freezing converts a silent
  // process-wide corruption into a TypeError at the write.
  const segments = buildEgress({}).response.segments;
  assert.ok(segments.length > 0, 'fixture sanity: the field is served');
  assert.throws(() => {
    (segments[0] as { segmentId: string }).segmentId = 'rewritten';
  }, TypeError);
  assert.throws(() => {
    (segments[0].evidenceHotspotIds as string[]).push('injected');
  }, TypeError);
});

test('the frozen field is still serialisable and still identical between responses', () => {
  // Freezing must not break anything a consumer does with the field — it is served as JSON.
  const a = buildEgress({ atSeconds: 17 * 3600 }).response.segments;
  const b = buildEgress({ atSeconds: 17 * 3600 }).response.segments;
  assert.equal(a, b, 'the same frozen array is reused rather than rebuilt');
  assert.equal(JSON.parse(JSON.stringify(a)).length, a.length, 'it survives serialisation');
});

test('the engine names exactly the settlements the fire reaches', () => {
  // This is the threat set the reach figure complements: every settlement NOT in this list is
  // counted as receiving an alert for a fire that does not threaten it.
  //
  // The version this is written against returned an EMPTY list. It indexed the node cut field
  // at `segments.length + node` when `sweepField` had already sliced the segment prefix off,
  // so the read went past the end, `Number.isFinite(undefined)` is false, and every settlement
  // filtered out. Nothing threw and nothing else in the suite noticed — because an empty
  // result is a well-formed array. It is also the most misleading possible answer: "this fire
  // threatens nobody" makes the over-alerting figure the whole population of every covered
  // village, the largest number the model can produce, arrived at by a bug rather than by the
  // fire. Only asserting the RESULT catches this; the array's length is right either way.
  //
  // The expected names are the engine's own claim, stated independently at the settlement
  // pre-filter in egress.ts: this fire spreads over 10 July, so Los Gallardos and Lubrín are
  // both reached and neither may be dropped from the threat set.
  const { threatenedSettlementIds } = buildEgress({}).diagnostics;
  assert.deepEqual(
    [...threatenedSettlementIds].sort(),
    ['bedar', 'los-gallardos', 'lubrin'],
    'the fire reaches the three western settlements, and not Turre or Mojácar',
  );

  // And it does not move with the cursor, which is why `/api/reach` takes no `?at=`. The
  // threat is a property of the fire's whole extent, not of how much of it has happened yet.
  const early = buildEgress({ atSeconds: 0 }).diagnostics.threatenedSettlementIds;
  const late = buildEgress({ atSeconds: 17 * 3600 }).diagnostics.threatenedSettlementIds;
  assert.deepEqual([...early].sort(), [...threatenedSettlementIds].sort(), 'at the window start');
  assert.deepEqual([...late].sort(), [...threatenedSettlementIds].sort(), 'and at 17:00');
});

test('the response reports what each sensor family contributed to the cut field', () => {
  // Source of expected: the committed capture, read through the mask. The counts are post
  // static-heat subtraction, so they are lower than the raw series the issue quotes (MTG-I1 2,010,
  // VIIRS 570, Sentinel-3 108, MODIS 55 -> 2,743), which is the same data minus the industrial
  // cells; the sum below is asserted against the response's own detection count rather than a
  // literal, so the two cannot drift apart.
  const built = buildEgress({ atSeconds: 61200 });
  const rows = built.response.sensorFamilies;
  const by = new Map(rows.map((r) => [r.family, r]));

  // Four instruments, not seven feeds: the three VIIRS series are one sensor on three satellites,
  // and a response listing them separately would tell a reader the capture was seen by seven.
  assert.deepEqual([...by.keys()], ['MODIS', 'MTG-I1', 'Sentinel-3', 'VIIRS']);
  assert.deepEqual(by.get('VIIRS')?.sources, ['VIIRS_NOAA20_NRT', 'VIIRS_NOAA21_NRT', 'VIIRS_SNPP_NRT']);

  // Nothing is double-counted and nothing is dropped.
  assert.equal(
    rows.reduce((sum, r) => sum + r.detections, 0),
    built.diagnostics.detections,
    'every detection in the capture belongs to exactly one family',
  );

  // The reading the field exists for: reaching a road is not the same as setting a cut time. VIIRS
  // has 483 detections whose discs reach a road and attains a cut on 2 segments — the other
  // families get there first — so `usedDetections` equal to `detections`, or `cutSegments` equal to
  // `usedDetections`, would both be the wrong version of this number.
  for (const row of rows) {
    assert.ok(row.usedDetections <= row.detections, `${row.family}: used cannot exceed the capture`);
    assert.ok(row.cutSegments >= 0);
  }
  assert.ok((by.get('VIIRS')?.usedDetections ?? 0) > 0, 'VIIRS detections do reach roads');
  assert.ok(
    (by.get('VIIRS')?.cutSegments ?? 0) < (by.get('VIIRS')?.usedDetections ?? 0),
    'but reach them less often than they set a time',
  );

  // The omission this issue is about would be visible here: a family the decision named and the
  // capture never carried appears with zeroes, not by its absence from the list.
  assert.equal(rows.some((r) => /seviri/i.test(r.family)), false, 'no family claims an instrument the capture lacks');
  assert.ok(rows.every((r) => r.detections > 0), 'and every family listed is one the capture carries');

  // Cut counts are per segment, so no family can have attained more cuts than the field holds.
  const cutSegments = built.response.segments.filter((s) => s.cutAt !== null).length;
  for (const row of rows) {
    assert.ok(row.cutSegments <= cutSegments, `${row.family}: cuts cannot exceed the cut field`);
  }
});
