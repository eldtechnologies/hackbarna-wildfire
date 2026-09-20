// Reach: the served footprints, and the population alerted for a fire that misses them.
//
// Every test here is the verification command for one acceptance criterion of issue #32, named
// so its gate pattern finds it, plus one discriminating test per row of the approved risk map.
//
// The module's whole honesty problem is compressed into one number: `range` is OpenCelliD's
// 1000 m fallback for most cells in this region, so a footprint built from it is a disc drawn
// from a default. Several tests below exist only to make sure that default cannot be published
// as though it were measured.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FALLBACK_RANGE_M,
  assembleReach,
  distanceMetres,
  loadFixture,
  overAlertingBy,
  servedFootprints,
  tileAreaM2,
  tileBounds,
  type RawCell,
  type ReachFixture,
  type ReachSettlement,
} from './reach';

const cell = (over: Partial<RawCell> = {}): RawCell => ({
  lat: 37.19, lon: -1.98, range: FALLBACK_RANGE_M, mcc: 214, mnc: 7, lac: 404, cellid: 1, ...over,
});

const settlement = (over: Partial<ReachSettlement> = {}): ReachSettlement => ({
  id: 'bedar', name: 'Bédar', lat: 37.1909, lon: -1.9806, population: 953, ...over,
});

test('a cell whose range is the OpenCelliD fallback is marked as a fallback, not counted as measured', () => {
  // The risk map's first row, and the one that decides whether the published figure reads as a
  // measurement. `range: 1000` is what OpenCelliD returns when it holds no measurement for the
  // cell — 14 of 14 cells at Mojácar on the committed fetch — so a footprint built from it is a
  // uniform disc drawn from a default. The discriminating input is one cell at the fallback and
  // one that is not: a version that treats both as measured publishes a fraction of 1.
  const { cells, measuredFraction } = servedFootprints([
    cell({ cellid: 1, range: FALLBACK_RANGE_M }),
    cell({ cellid: 2, range: 5174 }),
  ]);

  assert.equal(cells.length, 2);
  assert.equal(cells[0].measured, false, 'the fallback cell is not measured');
  assert.equal(cells[1].measured, true, 'the 5174 m cell is');
  assert.equal(measuredFraction, 0.5, 'and the published fraction says one of the two');
});

test('a settlement with no coverage reports zero cells rather than being absent from the list', () => {
  // A settlement missing from the output is indistinguishable from a settlement nobody asked
  // about. Bédar has no coverage on the committed fetch, so this is the case the demo actually
  // hits: the settlement the engine exists for is the one with no towers.
  const far = cell({ lat: 37.19, lon: -1.5, range: FALLBACK_RANGE_M });
  const near = cell({ lat: 37.1909, lon: -1.98, cellid: 2, range: FALLBACK_RANGE_M });
  const set = servedFootprints([far, near]);

  const { rows } = overAlertingBy(
    set,
    [
      settlement({ id: 'covered', name: 'Covered', population: 100 }),
      settlement({ id: 'uncovered', name: 'Uncovered', lat: 36.5, lon: -5.0, population: 200 }),
    ],
    new Set<string>(),
  );

  assert.equal(rows.length, 2, 'both settlements appear');
  const uncovered = rows.find((r) => r.settlementId === 'uncovered');
  assert.ok(uncovered, 'the settlement with no coverage is present, not dropped');
  assert.equal(uncovered.coveringCells, 0, 'and says so with a zero');
  assert.equal(uncovered.overAlerted, 0, 'and contributes nothing to the figure');
});

test('the enumeration tiles a region within the API request limit and reports how many requests it took', () => {
  // The API refuses any box over 4,000,000 m². The tiling is square in METRES, not in degrees:
  // a degree of longitude is shorter than a degree of latitude at this latitude, so a square in
  // degrees is a rectangle on the ground and breaches the limit on its long axis — which is the
  // wrong version this asserts against.
  const region = { south: 37.12, west: -2.062, north: 37.264, east: -1.831 };
  const tiles = tileBounds(region);

  assert.ok(tiles.length > 1, 'the region needs more than one request');
  for (const t of tiles) {
    assert.ok(
      tileAreaM2(t) <= 4_000_000,
      `every tile is within the limit: ${tileAreaM2(t).toFixed(0)} m²`,
    );
  }

  // The tiles cover the region without gaps: every corner of every tile lies inside, and the
  // union reaches all four edges.
  const south = Math.min(...tiles.map((t) => t.south));
  const north = Math.max(...tiles.map((t) => t.north));
  const west = Math.min(...tiles.map((t) => t.west));
  const east = Math.max(...tiles.map((t) => t.east));
  assert.ok(Math.abs(south - region.south) < 1e-9, 'tiles start at the southern edge');
  assert.ok(Math.abs(north - region.north) < 1e-9, 'and reach the northern one');
  assert.ok(Math.abs(west - region.west) < 1e-9, 'and the western one');
  assert.ok(Math.abs(east - region.east) < 1e-9, 'and the eastern one');

  // The COUNT is the discriminating property, and it is the criterion's own wording — "says how
  // many requests it took". Every assertion above also passes for a grid FINER than the limit
  // requires: finer tiles still cover the region and are still each under 4,000,000 m². The
  // version this is written against divided longitude by the metres-per-degree-LATITUDE
  // constant, so each tile was 0.8× as wide on the ground as it was tall — perfectly legal, and
  // it cost 104 requests to cover this region where 88 are enough. The API is metered and
  // rate-limited, so requests are the cost being minimised, and only the count reveals it.
  const midLat = (region.south + region.north) / 2;
  const sideM = Math.sqrt(4_000_000);
  const leastLat = Math.ceil((region.north - region.south) / (sideM / 110_977));
  const leastLon = Math.ceil(
    (region.east - region.west) / (sideM / (111_320 * Math.cos((midLat * Math.PI) / 180))),
  );
  assert.equal(
    tiles.length,
    leastLat * leastLon,
    'the tiling asks for the fewest requests that cover the region at the largest legal tile',
  );
});

test('the proportion of cells carrying a measured range is published beside the figure', () => {
  // The number's dominant input is a default, so publishing the figure without the fraction
  // invites it to be read as a measurement. The discriminating input is a set where the two
  // differ: three fallback cells and one measured gives 0.25, not 1 and not absent.
  const set = servedFootprints([
    cell({ cellid: 1, range: 1000 }),
    cell({ cellid: 2, range: 1000 }),
    cell({ cellid: 3, range: 1000 }),
    cell({ cellid: 4, range: 3188 }),
  ]);
  const result = overAlertingBy(set, [settlement()], new Set<string>());

  assert.equal(result.measuredFraction, 0.25, 'one cell in four carries a measured range');
  assert.equal(result.cells, 4, 'and the cell count travels with it');

  // An empty set has no fraction rather than a fraction of zero, which would read as "none are
  // measured" when the truth is "there are none".
  assert.equal(servedFootprints([]).measuredFraction, null, 'no cells is null, not zero');
});

test('a degenerate range does not become a zero-radius or infinite-radius footprint', () => {
  // Absent, zero, negative and non-numeric all fail the same way if they are not refused: a disc
  // of radius NaN or 0 counts nobody, and a value read through `?? Infinity` counts everybody.
  // The wrong version is silent in both directions, which is why the refusal is asserted rather
  // than the absence of a crash.
  const { cells, unusable } = servedFootprints([
    cell({ cellid: 1, range: undefined }),
    cell({ cellid: 2, range: 0 }),
    cell({ cellid: 3, range: -5 }),
    cell({ cellid: 4, range: 'big' }),
    cell({ cellid: 5, range: Number.NaN }),
    // The two below are what separate a TYPE CHECK from a coercion, and the five above do not.
    // `Number('250')` is 250 and `Number(true)` is 1, so a version that tested the coerced value
    // would accept both — building a 250 m footprint out of a string and a 1 m one out of a
    // boolean. Whereas `Number(undefined)`, `Number('big')` and `Number(NaN)` are all NaN, and
    // `Number(0)`/`Number(-5)` fail the positivity test either way: measured by planting the
    // coercion mutant, all five passed it.
    cell({ cellid: 7, range: '250' }),
    cell({ cellid: 8, range: true }),
    cell({ cellid: 6, range: 250 }),
  ]);

  assert.equal(cells.length, 1, 'only the usable cell becomes a footprint');
  assert.equal(cells[0].rangeM, 250);
  assert.equal(unusable.length, 7, 'and every refused cell is reported with a reason');
  for (const u of unusable) assert.ok(u.reason.length > 0, `${u.id} carries a reason`);
  // `Number(null)` is 0, so an absent range must be caught by type rather than by coercion.
  assert.ok(unusable.some((u) => u.id.endsWith('-1')), 'the absent range is among them');
});

test('a cell whose position is not a pair of numbers is refused too', () => {
  const { cells, unusable } = servedFootprints([
    cell({ cellid: 1, lat: 'north' }),
    cell({ cellid: 2, lon: null }),
    cell({ cellid: 3 }),
  ]);
  assert.equal(cells.length, 1, 'only the positioned cell survives');
  assert.equal(unusable.length, 2);
});

test('a threatened settlement contributes nothing to the over-alerting figure', () => {
  // The figure is population alerted for a fire that does NOT threaten them. A threatened
  // settlement receiving an alert is the product working, and counting it would make the number
  // rise as the fire got worse — the most misleading possible direction.
  const near = cell({ lat: 37.1909, lon: -1.9806, range: 5000, cellid: 9 });
  const set = servedFootprints([near]);
  const people = [settlement({ id: 'a', population: 100 }), settlement({ id: 'b', population: 200, lat: 37.1909, lon: -1.9807 })];

  const threatened = overAlertingBy(set, people, new Set(['a']));
  assert.equal(threatened.rows.find((r) => r.settlementId === 'a')?.overAlerted, 0, 'a threatened settlement is not over-alerted');
  assert.equal(threatened.rows.find((r) => r.settlementId === 'b')?.overAlerted, 200, 'an unthreatened one is');

  const none = overAlertingBy(set, people, new Set());
  assert.equal(none.rows.reduce((sum, r) => sum + r.overAlerted, 0), 300, 'with nothing threatened, everyone is');
});

test('a footprint covers a settlement by distance, not by a bounding box', () => {
  // Haversine against the cell's own radius. A bounding-box test would cover a settlement that
  // is 1 km north and 1 km east — 1.41 km away — of a 1 km cell, and the wrong version differs
  // on exactly that input.
  const c = { lat: 37.19, lon: -1.98 };
  const dueEast = { lat: 37.19, lon: -1.98 + 1000 / (111_320 * Math.cos((37.19 * Math.PI) / 180)) };
  const diagonal = { lat: 37.19 + 1000 / 110_977, lon: -1.98 + 1000 / (111_320 * Math.cos((37.19 * Math.PI) / 180)) };

  assert.ok(distanceMetres(c, dueEast) <= 1000, 'due east at 1 km is inside');
  assert.ok(distanceMetres(c, diagonal) > 1000, 'and the corner of that box is not');
});

test('a missing or cell-less fixture is refused rather than served as an empty region', () => {
  // The same inversion as the mask's empty case, arriving through the file system instead of
  // through the mask: no cells yields no coverage, no coverage yields an over-alerting figure
  // of zero, and zero is the safest possible number. A route that served it would report
  // "nobody is being woken up for nothing" because it had no data at all.
  assert.throws(
    () => loadFixture(join(tmpdir(), 'reach-fixture-that-does-not-exist.json')),
    /no OpenCelliD fetch/,
    'an absent fixture names the script that writes it rather than reading as empty',
  );

  const dir = mkdtempSync(join(tmpdir(), 'reach-fixture-'));
  const noCells = join(dir, 'no-cells.json');
  writeFileSync(noCells, JSON.stringify({ source: 'OpenCelliD', tilesFailed: 3, failures: [] }));
  assert.throws(
    () => loadFixture(noCells),
    /no cells array/,
    'and a fixture without cells is refused even though its other fields parse',
  );

  // An empty array IS a valid fixture and must not be refused: it is a region that was asked
  // about and holds no towers, which is a different statement from a region nobody asked about.
  const empty = join(dir, 'empty.json');
  writeFileSync(empty, JSON.stringify({ source: 'OpenCelliD', cells: [], tilesRequested: 88, tilesFailed: 0 }));
  assert.equal(loadFixture(empty).cells.length, 0, 'a real empty fetch reads as empty');
});

test('the assembled figure sums the rows and carries what it rests on', () => {
  // Discriminating input: two covered settlements, one threatened. The right answer is the
  // other one's population and not the sum of both — the wrong version ignores the threat set
  // and publishes 300, which is the number that makes the feature argue for itself.
  const fixture: ReachFixture = {
    source: 'OpenCelliD',
    endpoint: 'https://opencellid.org/cell/getInArea',
    fetchedAt: '2026-09-20T10:00:00.000Z',
    region: { south: 37.12, west: -2.062, north: 37.264, east: -1.831 },
    maxAreaM2: 4_000_000,
    tilesRequested: 88,
    tilesFailed: 2,
    failures: [{ bbox: '37.12,-2.06,37.15,-2.03', reason: 'HTTP 429' }],
    measuredRangeCells: 1,
    cells: [
      { mcc: 214, mnc: 7, lac: 404, cellid: 1, lat: 37.1909, lon: -1.9806, range: 5174 },
      { mcc: 214, mnc: 7, lac: 404, cellid: 2, lat: 37.1909, lon: -1.9807, range: FALLBACK_RANGE_M },
    ],
  };
  const settlements: ReachSettlement[] = [
    { id: 'near', name: 'Near', lat: 37.1909, lon: -1.9806, population: 100 },
    { id: 'far', name: 'Far', lat: 37.1909, lon: -1.9807, population: 200 },
  ];

  const response = assembleReach(fixture, settlements, new Set(['near']));

  assert.equal(response.totalOverAlerted, 200, 'only the unthreatened settlement is counted');
  assert.deepEqual(response.threatenedSettlementIds, ['near']);
  assert.equal(response.measuredFraction, 0.5, 'one of the two cells is measured');

  // The provenance travels with the figure, because the figure is unreadable without it: two
  // tiles failed, so coverage inside those boxes is unknown rather than absent.
  assert.equal(response.tilesFailed, 2);
  assert.equal(response.tilesRequested, 88);
  assert.deepEqual(response.failures, fixture.failures, 'the failed boxes are named, not just counted');
  assert.equal(response.fetchedAt, '2026-09-20T10:00:00.000Z', 'and the vintage of the fetch');
  assert.equal(response.cells, 2);
});
