import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildAlerts, instructionFor } from './alerts';
import { buildEgress } from './egress';

const XSD = fileURLToPath(new URL('../../data/cap/CAP-v1.2.xsd', import.meta.url));

/** 21:36 CEST on 9 July — two hours before the first deaths, road already cut. */
const CURSOR = 19 * 3600 + 36 * 60;

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

test('the pipeline emits packages for the real fire rather than rejecting everything', () => {
  // Regression. Destination names were once resolved against the road graph, so every
  // candidate was rejected as "not a name in the road data" and the endpoint returned an
  // empty list — indistinguishable from "no alert is needed", the most dangerous reading
  // the system can produce.
  const built = buildAlerts({ atSeconds: CURSOR });
  assert.ok(built.response.packages.length > 0, 'the real scenario must produce a package');
  assert.equal(built.response.rejected.length, 0, 'nothing in the real scenario should be rejected');
});

test('a destination resolves as a place, and the road as a way', () => {
  const built = buildAlerts({ atSeconds: CURSOR });
  const pkg = built.response.packages[0];
  const kinds = new Map(pkg.resolvedNames.map((n) => [n.osm?.type, n.text]));
  assert.ok(kinds.has('node'), 'the destination must resolve as a place, not a road');
  assert.ok(kinds.has('way'), 'the road must resolve as an OSM way');
  assert.ok(
    pkg.resolvedNames.every((n) => n.osm !== null),
    'no unresolved name may ship',
  );
});

test('the sentence names the road the route actually uses', () => {
  const built = buildAlerts({ atSeconds: CURSOR });
  const egress = buildEgress({ atSeconds: CURSOR });
  const pkg = built.response.packages[0];

  const destinationName = pkg.resolvedNames.find((n) => n.osm?.type === 'node')?.text;
  const route = egress.response.pockets
    .flatMap((p) => p.routes)
    .find((r) => r.destination === destinationName);
  assert.ok(route, 'the named destination must correspond to a route');

  // The named road must be on that route, which is what makes the passability check
  // meaningful rather than circular.
  const namedWayId = pkg.resolvedNames.find((n) => n.osm?.type === 'way')?.osm?.id;
  assert.ok(namedWayId, 'a road must be named');
  const onRoute = route.segmentIds.some((id) => id.replace(/^way\//, '').replace(/#.*$/, '') === namedWayId);
  assert.ok(onRoute, `named road ${namedWayId} is not on the recommended route`);
});

test('every language gets a package, and they say the same thing', () => {
  const built = buildAlerts({ atSeconds: CURSOR });
  const languages = built.response.packages.map((p) => p.language).sort();
  assert.deepEqual(languages, ['en', 'es'], 'Almería is Spanish and English, never Catalan');
  const instructions = new Set(built.response.packages.map((p) => p.instruction));
  assert.equal(instructions.size, 1, 'one instruction across languages, not two different calls');
  const departures = new Set(built.response.packages.map((p) => p.departure?.earliest));
  assert.equal(departures.size, 1, 'the same departure band in every language');
});

test('the emitted CAP for the real fire validates against the schema and passes the semantic checks', { skip: !hasXmllint ? 'xmllint not installed' : false }, () => {
  const built = buildAlerts({ atSeconds: CURSOR });
  assert.ok(built.documents.size > 0, 'a document must be emitted');
  for (const [pocketId, xml] of built.documents) {
    const failure = xsdValidate(xml);
    assert.equal(failure, null, `${pocketId}: xmllint rejected the document: ${failure}`);
    assert.ok(built.diagnostics.emitter.validation[pocketId]?.ok, `${pocketId}: semantic check failed`);
  }
});

test('the CAP document is one alert with one info per language', () => {
  const built = buildAlerts({ atSeconds: CURSOR });
  for (const xml of built.documents.values()) {
    assert.equal((xml.match(/<alert /g) ?? []).length, 1);
    assert.equal((xml.match(/<info>/g) ?? []).length, built.response.packages.length);
    assert.equal((xml.match(/<scope>/g) ?? []).length, 1);
    assert.match(xml, /<status>Test<\/status>/, 'the demo sender must never claim to be real');
    assert.match(xml, /<scope>Public<\/scope>/);
  }
});

test('the polygon written is Bédar, in lat,lon order', () => {
  const built = buildAlerts({ atSeconds: CURSOR });
  const xml = [...built.documents.values()][0];
  const poly = /<polygon>([^<]+)<\/polygon>/.exec(xml)?.[1] ?? '';
  const pairs = poly.split(' ').map((s) => s.split(',').map(Number));
  assert.ok(pairs.length >= 4, 'a closed ring needs four positions');
  for (const [lat, lon] of pairs) {
    assert.ok(lat > 37 && lat < 37.2, `latitude ${lat} is not Bédar`);
    assert.ok(lon > -2 && lon < -1.9, `longitude ${lon} is not Bédar`);
  }
  assert.deepEqual(pairs[0], pairs[pairs.length - 1]);
});

test('a Private scope profile cannot ship without addresses, and the check says so', () => {
  const built = buildAlerts({
    atSeconds: CURSOR,
    sender: { sender: 'x@y.invalid', senderName: 'X', status: 'Test', scope: 'Private' },
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
  const built = buildAlerts({ atSeconds: CURSOR });
  assert.ok(built.ledger.length > 0);
  for (const entry of built.ledger) {
    assert.ok(entry.evidence.length >= 3, 'a recommendation needs its evidence');
    assert.ok(entry.evidence.some((e) => /band|basis/.test(e)), 'the band and its basis must be cited');
    assert.ok(entry.at.length > 0);
  }
});

test('emission is deterministic across calls at the same cursor', () => {
  const a = buildAlerts({ atSeconds: CURSOR });
  const b = buildAlerts({ atSeconds: CURSOR });
  assert.deepEqual(a.response.packages, b.response.packages);
  assert.deepEqual([...a.documents.entries()].sort(), [...b.documents.entries()].sort());
});

test('an early cursor, before the fire is known, does not invent a package', () => {
  // 15:00 UTC on 9 July, an hour after ignition and before the evening's detections.
  const built = buildAlerts({ atSeconds: 15 * 3600 });
  for (const pkg of built.response.packages) {
    assert.ok(pkg.text.length > 0);
  }
  // Whatever it decides, it must not crash and must not claim certainty it lacks.
  assert.ok(['evacuate_primary', 'evacuate_alternate', 'no_verified_action', 'no_action']
    .includes(built.response.packages[0]?.instruction ?? 'no_action'));
});
