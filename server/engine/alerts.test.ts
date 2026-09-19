import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildAlerts, certaintyFor, instructionFor, severityFor } from './alerts';
import { openLedger, type StoredEntry } from './ledger';
import { buildEgress, loadContext } from './egress';
import { SWEEP_CONFIGS } from './sweep';
import { ASSUMPTION_PROFILES } from './assumptions';

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

const XSD = fileURLToPath(new URL('../../data/cap/CAP-v1.2.xsd', import.meta.url));

/** 21:36 CEST on 9 July — two hours before the first deaths, road already cut. */
const CURSOR = 19 * 3600 + 36 * 60;

/**
 * 19:00 CEST on 9 July, before the pessimistic departure. At this cursor an evacuation
 * is still a verified action; at CURSOR it is not, and the message has to say so.
 */
const EARLY_CURSOR = 17 * 3600;

const hasXmllint = ((): boolean => {
  try {
    execFileSync('xmllint', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

function xsdValidate(xml: string): string | null {
  const dir = mkdtempSync(join(tmpdir(), 'cap-e2e-'));
  const file = join(dir, 'alert.xml');
  writeFileSync(file, xml);
  try {
    execFileSync('xmllint', ['--schema', XSD, '--noout', file], { stdio: 'pipe' });
    return null;
  } catch (err) {
    const e = err as { stderr?: Buffer; stdout?: Buffer };
    return String(e.stderr ?? e.stdout ?? err).slice(0, 500);
  }
}

test('the instruction follows the route, and a track is never called the primary way out', () => {
  // A route whose worst road is a track is exactly the case the spike describes: the
  // main road is not safe and the way out is a track. Naming it primary would repeat
  // the failure the product exists to prevent.
  assert.equal(instructionFor({ slowestHighway: 'track', lastSafeDeparture: { earliest: 'x' } }, 0), 'evacuate_alternate');
  assert.equal(instructionFor({ slowestHighway: 'primary', lastSafeDeparture: { earliest: 'x' } }, 0), 'evacuate_primary');
  assert.equal(instructionFor(null, 0), 'no_verified_action');
  assert.equal(
    instructionFor({ slowestHighway: 'primary', lastSafeDeparture: null }, 0),
    'no_verified_action',
    'an already-cut route is not an evacuation route',
  );
});

test('a pocket the fire never reaches is told no action, not told to evacuate', () => {
  // Without this the only reachable outputs were an evacuation or a failure, so a safe
  // pocket would have been told to leave. It is a different statement from "we could not
  // find you a route", and both are different from "leave".
  assert.equal(instructionFor(null, 0, false), 'no_action');
  assert.equal(instructionFor({ slowestHighway: 'tertiary', lastSafeDeparture: null }, 0, false), 'no_action');
  // Default stays conservative: with no information about reach, it does not claim safety.
  assert.equal(instructionFor(null, 0), 'no_verified_action');
});

test('certainty never claims more confidence than the band supports', () => {
  // Tested against the mapping directly. The previous version of this test drove the
  // pipeline and asserted inside `if (pkg.departure === null)` — and at the cursor it
  // used, no package had a null departure, so the assertion never ran and the
  // regression it named was not guarded at all.
  assert.notEqual(certaintyFor(null), 'Observed', 'no verified route is not an observation');
  assert.equal(certaintyFor(null), 'Possible');

  // A band with no upper bound is NOT the strongest thing the model can say — that was
  // this assertion's own misreading, and the published data falsifies it. `latest: null`
  // means at least one configuration never closes the route, not that none does: all four
  // routes this engine serves carry `latest: null` only because `all-100m` never closes
  // them, while the other eleven configurations give departures around 17:36. The band
  // spans [17:36, never), which is the widest band there is.
  assert.equal(
    certaintyFor({ earliest: '2026-07-09T19:00:00Z', latest: null }),
    'Possible',
    'one unbounded configuration does not make the band narrow',
  );
  // It is 'Likely' only when every configuration agrees, which the engine signals by
  // pinning the pessimistic end to the window end.
  const WINDOW_END = '2026-07-11T11:08:26.000Z';
  assert.equal(
    certaintyFor({ earliest: WINDOW_END, latest: null }, WINDOW_END),
    'Likely',
    'an unbounded band at both ends is a route no configuration closes',
  );
  assert.equal(
    certaintyFor({ earliest: '2026-07-09T19:00:00Z', latest: null }, WINDOW_END),
    'Possible',
    'an unbounded upper end with a bounded lower one is a disagreement, not a verdict',
  );
  // A narrow band is close to a point estimate; a wide one is not.
  assert.equal(certaintyFor({ earliest: '2026-07-09T19:00:00Z', latest: '2026-07-09T20:00:00Z' }), 'Likely');
  assert.equal(certaintyFor({ earliest: '2026-07-09T19:00:00Z', latest: '2026-07-10T01:00:00Z' }), 'Possible');
});

test('severity is read off the hazard, not off how hard the decision was', () => {
  assert.equal(severityFor(true), 'Extreme');
  assert.equal(severityFor(false), 'Severe');
  // Without node information the hazard is assumed real: under-reporting it is the
  // direction that gets people killed.
  const built = buildAlerts({ atSeconds: CURSOR, ledgerPath: tmpLedger() });
  for (const pkg of built.response.packages) {
    assert.ok(pkg.severity === 'Extreme' || pkg.severity === 'Severe');
  }
});

test('the basis reports how many combinations actually contributed', () => {
  // A combination under which the route is never cut yields Infinity and used to be
  // dropped without a word, so the provenance line claimed all twelve while the band was
  // built from fewer. Overstating the evidence is worse than saying nothing.
  //
  // The denominator is now configurations x assumption profiles, because the band is the
  // envelope over both. A basis still counting only the twelve mask configurations would
  // understate what the band was built from just as surely as the old one overstated it.
  const expectedTotal = SWEEP_CONFIGS.length * ASSUMPTION_PROFILES.length;
  const egress = buildEgress({ atSeconds: CURSOR });
  let seen = 0;
  for (const pocket of egress.response.pockets) {
    for (const route of pocket.routes) {
      const basis = route.lastSafeDeparture?.basis ?? '';
      assert.ok(basis.length > 0, 'a band needs its basis');
      const claimed = /across (?:all (\d+)|(\d+) of (\d+)) combinations/.exec(basis);
      assert.ok(claimed, `basis does not state a combination count: ${basis}`);
      if (claimed[2] !== undefined) {
        const contributing = Number(claimed[2]);
        const total = Number(claimed[3]);
        assert.equal(total, expectedTotal, `basis names ${total} combinations, swept ${expectedTotal}`);
        assert.ok(contributing > 0 && contributing < total, `impossible count ${contributing}/${total}`);
      } else {
        assert.equal(Number(claimed[1]), expectedTotal, `basis names ${claimed[1]} combinations`);
      }
      seen += 1;
    }
  }
  assert.ok(seen > 0, 'fixture sanity: the response publishes at least one route');
});

test('a band whose pessimistic end has passed is no longer a verified action', () => {
  // The sentence and the pocket verdict must agree. Gating the verdict on the
  // pessimistic end while the message only checked that a band existed let the engine
  // report `no_verified_action` for the pocket and tell people to drive out in the same
  // response — the encouraging reading winning in the one place it must not.
  const cursor = Date.UTC(2026, 6, 9, 21, 36);
  const route = { slowestHighway: 'tertiary', lastSafeDeparture: { earliest: '2026-07-09T19:36:57.000Z' } };
  assert.equal(instructionFor(route, cursor), 'no_verified_action');

  // And a band still in the future remains an evacuation instruction.
  const future = { slowestHighway: 'tertiary', lastSafeDeparture: { earliest: '2026-07-09T22:00:00.000Z' } };
  assert.equal(instructionFor(future, cursor), 'evacuate_primary');
});

test('the package and the pocket verdict never disagree', () => {
  const built = buildAlerts({ atSeconds: CURSOR, ledgerPath: tmpLedger() });
  const egress = buildEgress({ atSeconds: CURSOR });
  for (const pocket of egress.response.pockets) {
    const packages = built.response.packages.filter((p) => p.pocketId === pocket.pocketId);
    if (pocket.verdict === 'no_verified_action') {
      for (const pkg of packages) {
        assert.equal(
          pkg.instruction,
          'no_verified_action',
          `pocket ${pocket.pocketId} says no verified action but the message says ${pkg.instruction}`,
        );
      }
    }
  }
});

test('the pipeline emits packages for the real fire rather than rejecting everything', () => {
  // Regression. Destination names were once resolved against the road graph, so every
  // candidate was rejected as "not a name in the road data" and the endpoint returned an
  // empty list — indistinguishable from "no alert is needed", the most dangerous reading
  // the system can produce.
  const built = buildAlerts({ atSeconds: CURSOR, ledgerPath: tmpLedger() });
  assert.ok(built.response.packages.length > 0, 'the real scenario must produce a package');
  assert.equal(built.response.rejected.length, 0, 'nothing in the real scenario should be rejected');
});

test('a destination resolves as a place, and the road as a way', () => {
  const built = buildAlerts({ atSeconds: EARLY_CURSOR, ledgerPath: tmpLedger() });
  const pkg = built.response.packages[0];
  assert.ok(pkg.resolvedNames.length > 0, 'an evacuation sentence names things');
  const kinds = new Map(pkg.resolvedNames.map((n) => [n.osm?.type, n.text]));
  assert.ok(kinds.has('node'), 'the destination must resolve as a place, not a road');
  assert.ok(kinds.has('way'), 'the road must resolve as an OSM way');
  assert.ok(
    pkg.resolvedNames.every((n) => n.osm !== null),
    'no unresolved name may ship',
  );
});

test('the sentence names the road the route actually uses', () => {
  const built = buildAlerts({ atSeconds: EARLY_CURSOR, ledgerPath: tmpLedger() });
  const egress = buildEgress({ atSeconds: EARLY_CURSOR });
  const pkg = built.response.packages[0];

  const destinationName = pkg.resolvedNames.find((n) => n.osm?.type === 'node')?.text;
  const route = egress.response.pockets
    .flatMap((p) => p.routes)
    .find((r) => r.destination === destinationName);
  assert.ok(route, 'the named destination must correspond to a route');

  // The named road must be on that route, which is what makes the passability check
  // meaningful rather than circular.
  //
  // Matched by NAME, not by the OSM id resolution returned: a name like "Carretera de
  // Los Gallardos a Bédar" is carried by twenty separate OSM ways, so the id the
  // resolver happens to return first need not be the one the route uses. The check the
  // engine actually makes is whether any edge with that name is on the route, and the
  // test asserts the same thing rather than something stricter.
  const roadName = pkg.resolvedNames.find((n) => n.osm?.type === 'way')?.text;
  assert.ok(roadName, 'a road must be named');

  const graph = loadContext().graph;
  const edgesWithName = graph.edges.filter((e) => e.name === roadName);
  assert.ok(edgesWithName.length > 0, `no edge in the graph is named "${roadName}"`);

  const onRoute = edgesWithName.filter((e) => route.segmentIds.includes(e.id));
  assert.ok(
    onRoute.length > 0,
    `"${roadName}" appears on ${edgesWithName.length} edges but none of them is on the recommended route`,
  );

  // And the road named must be one the driver actually joins, not a street they cross:
  // a route that spends most of its time on a track still has to name the road out.
  assert.ok(route.slowestHighway.length > 0);
});

test('every language gets a package, and they say the same thing', () => {
  const built = buildAlerts({ atSeconds: CURSOR, ledgerPath: tmpLedger() });
  const languages = built.response.packages.map((p) => p.language).sort();
  assert.deepEqual(languages, ['en', 'es'], 'Almería is Spanish and English, never Catalan');
  const instructions = new Set(built.response.packages.map((p) => p.instruction));
  assert.equal(instructions.size, 1, 'one instruction across languages, not two different calls');
  const departures = new Set(built.response.packages.map((p) => p.departure?.earliest));
  assert.equal(departures.size, 1, 'the same departure band in every language');
});

test('the emitted CAP for the real fire validates against the schema and passes the semantic checks', { skip: !hasXmllint ? 'xmllint not installed' : false }, () => {
  const built = buildAlerts({ atSeconds: CURSOR, ledgerPath: tmpLedger() });
  assert.ok(built.documents.size > 0, 'a document must be emitted');
  for (const [pocketId, xml] of built.documents) {
    const failure = xsdValidate(xml);
    assert.equal(failure, null, `${pocketId}: xmllint rejected the document: ${failure}`);
    assert.ok(built.diagnostics.emitter.validation[pocketId]?.ok, `${pocketId}: semantic check failed`);
  }
});

test('the CAP document is one alert with one info per language', () => {
  const built = buildAlerts({ atSeconds: CURSOR, ledgerPath: tmpLedger() });
  for (const xml of built.documents.values()) {
    assert.equal((xml.match(/<alert /g) ?? []).length, 1);
    assert.equal((xml.match(/<info>/g) ?? []).length, built.response.packages.length);
    assert.equal((xml.match(/<scope>/g) ?? []).length, 1);
    assert.match(xml, /<status>Test<\/status>/, 'the demo sender must never claim to be real');
    assert.match(xml, /<scope>Public<\/scope>/);
  }
});

test('the polygon written is Bédar, in lat,lon order', () => {
  const built = buildAlerts({ atSeconds: CURSOR, ledgerPath: tmpLedger() });
  const xml = [...built.documents.values()][0];
  const poly = /<polygon>([^<]+)<\/polygon>/.exec(xml)?.[1] ?? '';
  const pairs = poly.split(' ').map((s) => s.split(',').map(Number));
  assert.ok(pairs.length >= 4, 'a closed ring needs four positions');
  // Bounds wide enough for the real hull, which runs north over the dispersed sierra
  // dwellings rather than stopping at the village edge. The point of the assertion is
  // lat/lon order — a swap puts every value in the Indian Ocean — not a fixed box.
  for (const [lat, lon] of pairs) {
    assert.ok(lat > 37.1 && lat < 37.25, `latitude ${lat} is not Bédar`);
    assert.ok(lon > -2.05 && lon < -1.9, `longitude ${lon} is not Bédar`);
  }
  assert.deepEqual(pairs[0], pairs[pairs.length - 1], 'the ring must close');
});

test('the polygon is the real building hull, not the placeholder box', () => {
  // The engine falls back to a 400 m box when the Catastro fixture is missing. That box
  // is exactly 0.008 degrees on a side with its corners on a lattice, which makes it
  // distinguishable from a hull of real building centroids — so this fails if the
  // fixture stops loading, rather than silently shipping a square over the village.
  const built = buildAlerts({ atSeconds: CURSOR, ledgerPath: tmpLedger() });
  const xml = [...built.documents.values()][0];
  const pairs = (/<polygon>([^<]+)<\/polygon>/.exec(xml)?.[1] ?? '').split(' ').map((s) => s.split(',').map(Number));
  const lats = new Set(pairs.map((p) => p[0]));
  const lons = new Set(pairs.map((p) => p[1]));
  assert.ok(lats.size > 2 && lons.size > 2, 'a hull has varied edges; a box has four corners');
  const span = Math.max(...pairs.map((p) => p[0])) - Math.min(...pairs.map((p) => p[0]));
  assert.ok(span > 0.01, `span ${span.toFixed(4)} deg is box-sized, not settlement-sized`);
});

test('a Private scope profile cannot ship without addresses, and the check says so', () => {
  const built = buildAlerts({
    atSeconds: CURSOR,
    sender: { sender: 'x@y.invalid', senderName: 'X', status: 'Test', scope: 'Private' },
    ledgerPath: tmpLedger(),
  });
  for (const [, validation] of Object.entries(built.diagnostics.emitter.validation)) {
    assert.equal(validation.ok, false);
    assert.ok(validation.problems.some((p) => /addresses/.test(p)));
  }
  // And the schema alone would have accepted it, which is why the check exists.
  const xml = [...built.documents.values()][0];
  assert.equal(xsdValidate(xml), null, 'the XSD does not enforce the addresses requirement');
});

test('the ledger records the evidence behind every recommendation', () => {
  const built = buildAlerts({ atSeconds: CURSOR, ledgerPath: tmpLedger() });
  assert.ok(built.ledger.length > 0);
  for (const entry of built.ledger) {
    assert.ok(entry.evidence.length >= 3, 'a recommendation needs its evidence');
    assert.ok(entry.evidence.some((e) => /band|basis/.test(e)), 'the band and its basis must be cited');
    assert.ok(entry.at.length > 0);
  }
});

test('emission is deterministic across calls at the same cursor', () => {
  // Two separate stores, so both calls compute rather than one reusing the other's record.
  // With a shared path this test would pass while asserting nothing about the solve: the
  // second call would return the first's stored entry and agree by construction. That is
  // the risk-map row the store introduces — a determinism check that compares a computation
  // against itself.
  const a = buildAlerts({ atSeconds: CURSOR, ledgerPath: tmpLedger() });
  const b = buildAlerts({ atSeconds: CURSOR, ledgerPath: tmpLedger() });
  assert.deepEqual(a.response.packages, b.response.packages);
  assert.deepEqual([...a.documents.entries()].sort(), [...b.documents.entries()].sort());
  assert.equal(a.diagnostics.ledger.reused, 0, 'both calls actually computed');
  assert.equal(b.diagnostics.ledger.reused, 0);
});

test('a cursor already recorded is served from the record, not recomputed', () => {
  // One shared store across two calls. The second must return what the first recorded, and
  // the counter is what distinguishes that from a recomputation that happened to agree —
  // without it the test would pass on a store that was never read.
  const path = tmpLedger();
  const first = buildAlerts({ atSeconds: CURSOR, ledgerPath: path });
  assert.ok(first.ledger.length > 0, 'fixture sanity: there are recommendations to record');
  assert.equal(first.diagnostics.ledger.appended, first.ledger.length, 'the first call records every pocket');
  assert.equal(first.diagnostics.ledger.reused, 0);
  assert.equal(first.diagnostics.ledger.unreadable, 0);
  assert.deepEqual(first.diagnostics.ledger.writeFailures, []);

  const second = buildAlerts({ atSeconds: CURSOR, ledgerPath: path });
  assert.equal(second.diagnostics.ledger.appended, 0, 'the second call records nothing new');
  assert.equal(second.diagnostics.ledger.reused, second.ledger.length, 'every pocket came from the record');
  assert.deepEqual(second.ledger, first.ledger, 'and it is the same content that was recorded');
});

test('the ledger records what the file holds, and a changed input set does not reuse it', () => {
  // The risk-map row the fingerprint exists for. Keying by cursor alone would let a store
  // written under one set of inputs answer for another, serving a recommendation the
  // current inputs do not support with nothing in the record saying so.
  const path = tmpLedger();
  const built = buildAlerts({ atSeconds: CURSOR, ledgerPath: path });
  const store = openLedger(path);

  for (const entry of built.ledger as StoredEntry[]) {
    assert.ok(store.find(entry.cursorSeconds, entry.inputFingerprint, entry.pocketId), 'recorded and findable');
    // The same cursor under different inputs is a miss, which is what makes the caller
    // compute and append instead of reinterpreting the old entry.
    assert.equal(store.find(entry.cursorSeconds, 'a-different-input-set', entry.pocketId), undefined);
    // And the same inputs for a different pocket is a separate entry, not a shared one.
    assert.equal(store.find(entry.cursorSeconds, entry.inputFingerprint, 'not-a-pocket'), undefined);
  }

  // The store holds exactly one line per pocket, and nothing was written twice.
  assert.equal(store.history().entries.length, built.ledger.length);
  assert.equal(store.history().unreadable, 0);
});

test('an early cursor, before the fire is known, does not invent a package', () => {
  // 15:00 UTC on 9 July, an hour after ignition and before the evening's detections.
  const built = buildAlerts({ atSeconds: 15 * 3600, ledgerPath: tmpLedger() });

  // An empty list would make every loop below vacuous, and the earlier version of this
  // test accepted exactly that: `for (const pkg of [])` asserts nothing, and the
  // instruction check had a fallback that passed when nothing was emitted.
  assert.ok(built.response.packages.length > 0, 'the pipeline must say something at every cursor');

  for (const pkg of built.response.packages) {
    assert.ok(pkg.text.trim().length > 0, 'a package must carry a sentence');
    assert.ok(pkg.resolvedNames.every((n) => n.osm !== null), 'and every name in it must resolve');
    assert.ok(['evacuate_primary', 'evacuate_alternate', 'no_verified_action', 'no_action'].includes(pkg.instruction));
    // Every package carries a band, or explicitly has none. Neither may be undefined.
    assert.ok(pkg.departure === null || typeof pkg.departure.earliest === 'string');
    assert.ok(pkg.certainty !== 'Observed' || pkg.departure !== null, 'an unverified route is not an observation');
  }
});

test('the ledger records the inputs its own clearance was computed from', () => {
  // It used to record the nominal mobile fraction and occupancy beside a clearance computed
  // from the cautious ones, so recomputing from the ledger's own inputs gave 181.5 or 108.9
  // against a published 185.3 — and the nominal pair reads permissive, because it implies
  // fewer vehicles. The audit artifact could not reproduce the number it was auditing. The
  // divisor was missing too, so even the corrected inputs could not get from vehicles to
  // minutes.
  const entry = buildAlerts({ atSeconds: 63_000, ledgerPath: tmpLedger() }).ledger[0];
  const recorded = Number(entry.inputs.clearanceMinutes);
  assert.ok(Number.isFinite(recorded) && recorded > 0, 'fixture sanity: a clearance was computed');

  const population = Number(entry.inputs.population);
  const vehicles =
    (population * Number(entry.inputs.mobileFraction)) / Number(entry.inputs.vehicleOccupancy);
  const capacity = Number(entry.inputs.bottleneckCapacityPerHour);
  assert.ok(Number.isFinite(capacity) && capacity > 0, 'the divisor is recorded rather than left to inference');

  const recomputed = (vehicles / capacity) * 60;
  assert.ok(
    Math.abs(recomputed - recorded) < 0.05,
    `the ledger's own inputs give ${recomputed.toFixed(1)} against a recorded ${recorded}`,
  );

  // And the values recorded are the ones the gate acted on, not the nominal centre.
  assert.equal(entry.inputs.mobileFraction, 0.7, 'the pessimistic profile, not the nominal 0.8');
  assert.equal(entry.inputs.departureDelayMinutes, 30, 'the gated delay, not the nominal 15');
  assert.equal(entry.inputs.nominalDepartureDelayMinutes, 15, 'the nominal still travels, named as such');
  assert.equal(entry.inputs.bottleneckHighway, 'track');
});
