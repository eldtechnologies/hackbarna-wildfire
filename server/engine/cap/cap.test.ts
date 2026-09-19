import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { clean, escapeXml, formatPolygon, stripForbiddenChars } from './xml';
import { TEMPLATES, fillTemplate, languagesFor, templateFor, unresolvedPlaceholders } from './templates';
import { capIdentifier, emitCap, groupByPocket, validateCapSemantics } from './emit';
import { resolveName, verifySentence } from './verify';
import type { AlertPackage, CapSenderConfig } from '../../../shared/alerts';
import type { LatLon } from '../../../shared/fires';
import type { RoadGraph } from '../solve';

const XSD = fileURLToPath(new URL('../../../data/cap/CAP-v1.2.xsd', import.meta.url));

const SENDER: CapSenderConfig = {
  sender: 'demo@ojo-de-fuego.invalid',
  senderName: 'Ojo de Fuego (demo)',
  status: 'Test',
  scope: 'Public',
};

const BEDAR_RING: LatLon[] = [
  { lat: 37.1862, lon: -1.9801 },
  { lat: 37.1881, lon: -1.9772 },
  { lat: 37.1904, lon: -1.9788 },
  { lat: 37.1899, lon: -1.9813 },
  { lat: 37.1862, lon: -1.9801 },
];

function pkg(over: Partial<AlertPackage> = {}): AlertPackage {
  return {
    id: 'p1', pocketId: 'bedar', pocketName: 'Bédar', at: '2026-07-09T17:38:21.000Z',
    instruction: 'evacuate_primary', language: 'es',
    text: 'Salga de Bédar ahora por Carretera de Bédar hacia Lubrín. No use otras vías.',
    resolvedNames: [],
    urgency: 'Immediate', severity: 'Severe', certainty: 'Likely',
    area: BEDAR_RING, departure: null,
    ...over,
  };
}

function emit(packages: AlertPackage[], over: Partial<Parameters<typeof emitCap>[0]> = {}): string {
  return emitCap({
    identifier: 'ojo-de-fuego:bedar:20260709T173821Z:evacuate_primary',
    sender: SENDER,
    sentMs: Date.UTC(2026, 6, 9, 17, 38, 21),
    source: 'ojo-de-fuego replay los-gallardos-2026-07-09',
    packages,
    area: BEDAR_RING,
    eventName: 'Incendio forestal / Wildfire',
    ...over,
  });
}

const hasXmllint = ((): boolean => {
  try {
    execFileSync('xmllint', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

function validateAgainstXsd(xml: string): { ok: boolean; message: string } {
  const dir = mkdtempSync(join(tmpdir(), 'cap-'));
  const file = join(dir, 'alert.xml');
  writeFileSync(file, xml);
  try {
    execFileSync('xmllint', ['--schema', XSD, '--noout', file], { stdio: 'pipe' });
    return { ok: true, message: 'validates' };
  } catch (err) {
    const e = err as { stderr?: Buffer; stdout?: Buffer };
    return { ok: false, message: String(e.stderr ?? e.stdout ?? err).slice(0, 400) };
  }
}

test('the emitted document validates against the official CAP 1.2 schema', { skip: !hasXmllint ? 'xmllint not installed' : false }, () => {
  const xml = emit([pkg({ language: 'es' }), pkg({ language: 'en' })]);
  const result = validateAgainstXsd(xml);
  assert.ok(result.ok, `xmllint rejected the document: ${result.message}`);
  assert.ok(validateCapSemantics({
    identifier: 'x', sender: SENDER, sentMs: 0, source: 's',
    packages: [pkg({ language: 'es' }), pkg({ language: 'en' })],
    area: BEDAR_RING, eventName: 'e',
  }, xml).ok);
});

test('a Z timestamp is rejected by the schema, which is why toISOString is never used', { skip: !hasXmllint ? 'xmllint not installed' : false }, () => {
  // This is the trap: the obvious implementation produces exactly this, and it fails.
  const xml = emit([pkg()]).replace(/<sent>[^<]*<\/sent>/, '<sent>2026-07-09T17:38:21Z</sent>');
  assert.ok(!validateAgainstXsd(xml).ok, 'the schema must reject a Z-suffixed timestamp');
});

test('the schema does NOT catch a lon/lat-swapped polygon, so the semantic check must', { skip: !hasXmllint ? 'xmllint not installed' : false }, () => {
  const swapped = BEDAR_RING.map((p) => ({ lat: p.lon, lon: p.lat }));
  const xml = emit([pkg()], { area: swapped });
  assert.ok(validateAgainstXsd(xml).ok, 'the XSD types polygon as xs:string and validates anything');
  const semantics = validateCapSemantics({
    identifier: 'x', sender: SENDER, sentMs: 0, source: 's',
    packages: [pkg()], area: swapped, eventName: 'e',
  }, xml);
  assert.equal(semantics.ok, false, 'the semantic check is what catches the swap');
  assert.ok(semantics.problems.some((p) => /swapped/.test(p)));
});

test('the polygon is written lat,lon with a closed ring', () => {
  const poly = formatPolygon(BEDAR_RING);
  const pairs = poly.split(' ').map((s) => s.split(',').map(Number));
  assert.equal(pairs.length, 5);
  for (const [lat, lon] of pairs) {
    assert.ok(lat > 36 && lat < 38, `latitude ${lat} is not near Bédar — lon/lat swapped?`);
    assert.ok(lon > -3 && lon < -1, `longitude ${lon} is not near Bédar`);
  }
  assert.deepEqual(pairs[0], pairs[pairs.length - 1], 'the ring must close');
});

test('non-finite and out-of-range coordinates are dropped rather than written', () => {
  const bad = [...BEDAR_RING.slice(0, 3), { lat: NaN, lon: -1.98 }, { lat: 200, lon: -1.98 }, BEDAR_RING[0]];
  const pairs = formatPolygon(bad).split(' ');
  assert.equal(pairs.length, 4, 'only the four usable positions survive');
  assert.ok(!formatPolygon(bad).includes('NaN'));
});

test('hostile names cannot escape the document', () => {
  const hostile = '<script>alert("x")</script> & ]]> \u0000\u0007 "quoted"';
  const escaped = clean(hostile);
  assert.ok(!escaped.includes('<'), 'no raw angle bracket survives');
  assert.ok(!escaped.includes(']]>'), 'no CDATA terminator survives');
  assert.ok(!/[\u0000-\u0008]/.test(escaped), 'no C0 control survives');
  assert.ok(escaped.includes('&amp;'), 'the ampersand is escaped');
  // The ampersand must be escaped first or the other escapes get double-escaped.
  assert.ok(!escaped.includes('&amp;lt;'), 'no double escaping');
});

test('stripForbiddenChars leaves the characters XML allows', () => {
  assert.equal(stripForbiddenChars('a\tb\nc\rd'), 'a\tb\nc\rd');
  assert.equal(stripForbiddenChars('a\u0000b'), 'ab');
});

test('escapeXml is idempotent-safe on already-escaped text', () => {
  assert.equal(escapeXml('a&b'), 'a&amp;b');
  assert.equal(escapeXml('a&amp;b'), 'a&amp;amp;b', 'double escaping is visible, not silent');
});

test('the CAP timestamp is not the ISO one', () => {
  const xml = emit([pkg()]);
  const sent = /<sent>([^<]+)<\/sent>/.exec(xml)?.[1] ?? '';
  assert.match(sent, /^\d\d\d\d-\d\d-\d\dT\d\d:\d\d:\d\d[-,+]\d\d:\d\d$/);
  assert.equal(sent, '2026-07-09T19:38:21+02:00');
});

test('element order matches the schema sequence', () => {
  const xml = emit([pkg()]);
  const order = ['identifier', 'sender', 'sent', 'status', 'msgType', 'source', 'scope', 'info'];
  let cursor = -1;
  for (const tag of order) {
    const at = xml.indexOf(`<${tag}`);
    assert.ok(at > cursor, `<${tag}> is out of sequence`);
    cursor = at;
  }
  const infoOrder = ['language', 'category', 'event', 'responseType', 'urgency', 'severity',
    'certainty', 'eventCode', 'effective', 'onset', 'expires', 'senderName', 'headline',
    'description', 'instruction', 'area'];
  let infoCursor = -1;
  for (const tag of infoOrder) {
    const at = xml.indexOf(`<${tag}`);
    assert.ok(at > infoCursor, `<${tag}> is out of sequence inside <info>`);
    infoCursor = at;
  }
  // language is FIRST inside info; putting it after category is the classic rejection.
  const infoStart = xml.indexOf('<info>');
  assert.ok(xml.indexOf('<language>') < xml.indexOf('<category>'));
  assert.ok(xml.indexOf('<language>') > infoStart);
  // areaDesc comes before polygon inside area. Presence is asserted first:
  // indexOf returns -1 for an absent element, and -1 < n passes, so the ordering
  // check alone would succeed on a document with no areaDesc at all.
  assert.ok(xml.includes('<areaDesc>'), 'the area needs a description');
  assert.ok(xml.includes('<polygon>'), 'the area needs a polygon');
  assert.ok(xml.indexOf('<areaDesc>') < xml.indexOf('<polygon>'));
});

test('one info per language, sorted, and one alert per pocket', () => {
  const packages = [pkg({ language: 'en' }), pkg({ language: 'es' })];
  const xml = emit(packages);
  assert.equal((xml.match(/<info>/g) ?? []).length, 2);
  assert.equal((xml.match(/<alert /g) ?? []).length, 1);
  assert.ok(xml.indexOf('<language>en</language>') < xml.indexOf('<language>es</language>'), 'sorted');
  assert.equal((xml.match(/<identifier>/g) ?? []).length, 1, 'identifier appears once, not per info');
});

test('every template fills completely and leaves no placeholder', () => {
  const values = { pocket: 'Bédar', road: 'Carretera de Bédar', destination: 'Lubrín' };
  for (const template of TEMPLATES) {
    for (const language of ['es', 'en', 'ca'] as const) {
      const text = fillTemplate(template, language, values);
      assert.deepEqual(unresolvedPlaceholders(text), [], `${template.instruction}/${language} left a placeholder`);
      if (template.namesRoad) {
        assert.ok(text.includes('Bédar') && text.includes('Lubrín'), `${template.instruction}/${language} lost a name`);
      }
    }
  }
});

test('a missing value leaves the placeholder visible rather than silently deleting it', () => {
  const text = fillTemplate(templateFor('evacuate_primary'), 'es', { pocket: 'Bédar' });
  assert.deepEqual(unresolvedPlaceholders(text).sort(), ['destination', 'road']);
});

test('languages are per settlement, and Catalan is never assumed for Almería', () => {
  assert.deepEqual(languagesFor({ languages: ['es', 'en'] }), ['es', 'en']);
  assert.deepEqual(languagesFor({ languages: ['es', 'ca'] }), ['es', 'ca']);
  assert.deepEqual(languagesFor({}), ['es', 'en'], 'the default is Spanish and English');
  assert.deepEqual(languagesFor({ languages: ['fr', 'de'] }), ['es'], 'unknown codes fall back, never through');
  assert.ok(!languagesFor({ languages: ['es', 'en'] }).includes('ca'));
});

test('groupByPocket keeps languages of one pocket together', () => {
  const grouped = groupByPocket([
    pkg({ pocketId: 'bedar', language: 'es' }),
    pkg({ pocketId: 'bedar', language: 'en' }),
    pkg({ pocketId: 'turre', language: 'es' }),
  ]);
  assert.equal(grouped.size, 2);
  assert.equal(grouped.get('bedar')!.length, 2);
  assert.equal(grouped.get('turre')!.length, 1);
});

test('a Private scope without addresses is caught by the semantic check', () => {
  const xml = emit([pkg()], { sender: { ...SENDER, scope: 'Private' } });
  const semantics = validateCapSemantics({
    identifier: 'x', sender: { ...SENDER, scope: 'Private' }, sentMs: 0, source: 's',
    packages: [pkg()], area: BEDAR_RING, eventName: 'e',
  }, xml);
  assert.equal(semantics.ok, false);
  assert.ok(semantics.problems.some((p) => /addresses/.test(p)));
});

test('the identifier is deterministic, so a replay is reproducible', () => {
  const a = capIdentifier('bedar', '2026-07-09T17:38:21.000Z', 'evacuate_primary');
  const b = capIdentifier('bedar', '2026-07-09T17:38:21.000Z', 'evacuate_primary');
  assert.equal(a, b);
  assert.notEqual(a, capIdentifier('bedar', '2026-07-09T17:38:22.000Z', 'evacuate_primary'));
});

// ---- the verification gate ----

const graph: RoadGraph = {
  nodes: [
    { lat: 37.19, lon: -1.98 }, { lat: 37.20, lon: -1.97 }, { lat: 37.21, lon: -1.96 },
  ],
  edges: [
    { id: 'way/183157467#0', from: 0, to: 1, geometry: [], highway: 'tertiary', name: 'Carretera de Bédar', travelSeconds: 60 },
    { id: 'way/999#0', from: 1, to: 2, geometry: [], highway: 'track', name: 'Camino Viejo', travelSeconds: 60 },
  ],
  outgoing: [[0], [1], []],
  incoming: [[], [0], [1]],
};

test('a name OSM does not carry is rejected, not written', () => {
  const out = verifySentence({ text: 'x', names: [{ text: 'Carretera Inventada' }], routeSegmentIds: ['way/183157467#0'] }, graph);
  assert.equal(out.rejection?.reason, 'unresolved_name');
});

test('a real road that is not on the route is rejected as not passable', () => {
  // 'Camino Viejo' exists but is not on the recommended route.
  const out = verifySentence({ text: 'x', names: [{ text: 'Camino Viejo' }], routeSegmentIds: ['way/183157467#0'] }, graph);
  assert.equal(out.rejection?.reason, 'not_passable');
});

test('a real road on the route verifies', () => {
  const out = verifySentence({ text: 'x', names: [{ text: 'Carretera de Bédar' }], routeSegmentIds: ['way/183157467#0'] }, graph);
  assert.equal(out.rejection, null);
  assert.equal(out.resolved[0].osm?.id, '183157467');
});

test('matching is case- and whitespace-insensitive', () => {
  assert.equal(resolveName('  carretera de bédar ', graph)?.id, '183157467');
});

test('an empty name resolves to nothing rather than matching the first edge', () => {
  assert.equal(resolveName('', graph), null);
  assert.equal(resolveName('   ', graph), null);
});
