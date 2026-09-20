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
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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

/**
 * The provenance every fixture must carry.
 *
 * Named as a constant because `loadFixture` refuses a fixture without it, so each test that wants
 * a readable fixture spreads this rather than restating nine fields — and each test that wants to
 * check a missing one deletes exactly one key from it.
 */
/** A fixture directory of its own per call, so one test's file never answers another's read. */
const fixtureDir = (): string => mkdtempSync(join(tmpdir(), 'reach-fixture-'));

/** `loadFixture` reads from disk, so a fixture to test has to be written first. */
const writeFixture = (dir: string, name: string, body: unknown): string => {
  const path = join(dir, name);
  writeFileSync(path, JSON.stringify(body));
  return path;
};

const PROVENANCE = {
  source: 'OpenCelliD',
  endpoint: 'https://opencellid.org/cell/getInArea',
  fetchedAt: '2026-09-20T10:00:00.000Z',
  region: { south: 37.12, west: -2.062, north: 37.264, east: -1.831 },
  maxAreaM2: 4_000_000,
  tilesRequested: 88,
  tilesFailed: 0,
  failures: [],
  measuredRangeCells: 1,
} satisfies Omit<ReachFixture, 'cells'>;

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
    // These four are what separate a TYPE CHECK from a coercion; the five above do not. `Number()`
    // maps `'250'` to 250 and `true` to 1 — so a version that tested the coerced value builds a
    // 250 m footprint out of a string and a 1 m one out of a boolean — and maps `null` and `''`
    // to 0, which it then refuses only by accident, via the positivity test rather than by type.
    // Measured by planting exactly that mutant: all five of the originals passed it.
    cell({ cellid: 7, range: '250' }),
    cell({ cellid: 8, range: true }),
    cell({ cellid: 9, range: null }),
    cell({ cellid: 10, range: '' }),
    cell({ cellid: 6, range: 250 }),
  ]);

  assert.equal(cells.length, 1, 'only the usable cell becomes a footprint');
  assert.equal(cells[0].rangeM, 250);
  // Named exactly, rather than counted or suffix-matched. The previous assertion here was
  // `unusable.some((u) => u.id.endsWith('-1'))`, which cell 1, cell 11 and any other id ending in
  // 1 all satisfy — so it never pinned the input its comment named.
  assert.deepEqual(
    unusable.map((u) => u.id),
    [1, 2, 3, 4, 5, 7, 8, 9, 10].map((n) => `214-7-404-${n}`),
    'every refused cell is named, in the order it was given',
  );
  for (const u of unusable) assert.ok(u.reason.length > 0, `${u.id} carries a reason`);
});

test('a null or primitive entry is refused by position, not thrown', () => {
  // `cellId` reads four properties off each entry, so a `null` in the array reached `cell.mcc` and
  // threw a bare TypeError out of the whole endpoint — reporting nothing about which entry was
  // bad, where every other malformed shape is reported per cell. The entry's index is the only
  // identifier available for something that is not an object.
  const { cells, unusable } = servedFootprints([
    cell({ cellid: 1 }),
    null as unknown as RawCell,
    'cell' as unknown as RawCell,
  ]);
  assert.equal(cells.length, 1, 'the well-formed cell still becomes a footprint');
  assert.deepEqual(unusable.map((u) => u.id), ['#1', '#2'], 'the bad entries are named by position');
});

test('a cell whose position is not a pair of numbers is refused too', () => {
  // Both halves of the guard and both failure kinds. The `lon` half and the finiteness half were
  // unpinned: removing either left every test in this file passing, because no input reached them.
  // A non-finite coordinate is the case a `typeof` check alone would let through — `typeof NaN` is
  // 'number' — and it yields a footprint at a position no settlement can ever be inside.
  const { cells, unusable } = servedFootprints([
    cell({ cellid: 1, lat: 'north' }),
    cell({ cellid: 2, lon: null }),
    cell({ cellid: 3, lat: Number.NaN }),
    cell({ cellid: 4, lat: 37.19, lon: Number.POSITIVE_INFINITY }),
    cell({ cellid: 5 }),
  ]);
  assert.equal(cells.length, 1, 'only the positioned cell survives');
  assert.deepEqual(unusable.map((u) => u.id), ['214-7-404-1', '214-7-404-2', '214-7-404-3', '214-7-404-4']);
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
  assert.equal(none.totalOverAlerted, 300, 'with nothing threatened, everyone is');
});

test('an unknown population is carried as null, never folded into a zero', () => {
  // `Settlement.population` is `number | null` so that null means unknown and zero means nobody
  // lives there. `?? 0` collapsed the two, and a covered village of unknown size then reported
  // `population: 0, overAlerted: 0` — indistinguishable from an empty one, silently absent from
  // the total, and wrong in the reassuring direction. The egress engine renders the same value as
  // "unknown clearance is not zero clearance"; this module was the one place in the repo that
  // collapsed it.
  const set = servedFootprints([cell({ lat: 37.1909, lon: -1.9806, range: 5000 })]);
  const { rows, totalOverAlerted, unknownPopulation } = overAlertingBy(
    set,
    [
      settlement({ id: 'known', population: 300 }),
      settlement({ id: 'unknown', population: null, lat: 37.1909, lon: -1.9807 }),
    ],
    new Set<string>(),
  );

  const unknown = rows.find((r) => r.settlementId === 'unknown');
  assert.equal(unknown?.population, null, 'the null population is carried through, not defaulted');
  assert.equal(unknown?.overAlerted, null, 'and the contribution is unknown, not zero');
  assert.equal(totalOverAlerted, 300, 'so the total counts only what it can');
  assert.deepEqual(unknownPopulation, ['unknown'], 'and names what it could not count, so 300 cannot read as complete');
});

test('a settlement with no usable position is reported, not counted as uncovered', () => {
  // The same `typeof`-first rule the cells get: `Number(null)` is 0, so a missing coordinate would
  // be read as the point (0, 0), and the village would then be tested against footprints 3,000 km
  // away and report `coveringCells: 0` — which this module publishes as the fact "no cell covers
  // this village". An absent value must not become a finding.
  const set = servedFootprints([cell({ lat: 37.1909, lon: -1.9806, range: 5000 })]);
  const { rows, unusableSettlements, totalOverAlerted } = overAlertingBy(
    set,
    [
      settlement({ id: 'placed', population: 100 }),
      settlement({ id: 'null-lat', population: 200, lat: null as unknown as number, lon: -1.98 }),
      // The `lon` half and the finiteness half of the guard, which no input reached before this:
      // removing either left the whole suite green.
      settlement({ id: 'null-lon', population: 200, lat: 37.19, lon: null as unknown as number }),
      settlement({ id: 'nan-lat', population: 200, lat: Number.NaN, lon: -1.98 }),
    ],
    new Set<string>(),
  );

  assert.deepEqual(
    unusableSettlements.map((u) => u.id),
    ['null-lat', 'null-lon', 'nan-lat'],
    'every unplaceable settlement is reported, on either axis',
  );
  for (const u of unusableSettlements) assert.ok(u.reason.length > 0, `${u.id} carries a reason`);
  for (const id of ['null-lat', 'null-lon', 'nan-lat']) {
    const row = rows.find((r) => r.settlementId === id);
    assert.equal(row?.overAlerted, null, `${id}: not zero, and not a made-up covering count`);
    assert.equal(row?.coveringCells, 0, `${id}: and not reported as uncovered either`);
  }
  assert.equal(totalOverAlerted, 100, 'the total counts only the settlement it could place');
});

test('a settlement is counted wholly or not at all, by its centre', () => {
  // The risk map's third row asks about a settlement PARTLY inside a footprint. This model has
  // no such case — a settlement is a point, its coordinate, which is how the egress engine snaps
  // a pocket to the road graph — so the row's discriminating input is unreachable as written.
  // What can be pinned instead is the choice it rests on: the centre decides, and the whole
  // population follows it.
  //
  // Both directions cost something, and the module states both: a village whose centre sits just
  // inside a 1 km disc contributes every resident, including the ones the broadcast would never
  // reach, and a village just outside contributes none of them. The first inflates the headline
  // figure. Asserted rather than left implicit so that moving to an areal model is a decision
  // someone makes rather than a drift nobody notices.
  const c = { lat: 37.19, lon: -1.98 };
  const set = servedFootprints([cell({ lat: c.lat, lon: c.lon, range: 1000 })]);

  const { rows } = overAlertingBy(
    set,
    [
      settlement({ id: 'in', name: 'In', lat: c.lat + 900 / 110_977, lon: c.lon, population: 500 }),
      settlement({ id: 'out', name: 'Out', lat: c.lat + 1100 / 110_977, lon: c.lon, population: 700 }),
    ],
    new Set<string>(),
  );

  assert.equal(rows.find((r) => r.settlementId === 'in')?.overAlerted, 500,
    'centre 900 m away, inside a 1 km disc: the whole population, not a fraction of it');
  assert.equal(rows.find((r) => r.settlementId === 'out')?.overAlerted, 0,
    'centre 1.1 km away: none of it, however much of the village reaches in');
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

  const dir = fixtureDir();
  const write = (name: string, body: unknown): string => writeFixture(dir, name, body);

  assert.throws(
    () => loadFixture(write('no-cells.json', { ...PROVENANCE, tilesFailed: 3 })),
    /no cells array/,
    'a fixture without cells is refused even though its other fields parse',
  );

  // An EMPTY array is refused too — the case the guard above was written for and did not cover.
  // A survey of 88 tiles over a populated region that found no towers has failed; served, it
  // publishes `cells: 0` and `totalOverAlerted: 0`, read as "nobody is woken up for nothing".
  // An earlier revision accepted this and a test asserted the acceptance, both wrongly.
  assert.throws(
    () => loadFixture(write('empty.json', { ...PROVENANCE, cells: [] })),
    /no cells/,
    'an empty survey is refused rather than served as a region with no coverage',
  );

  // Provenance is refused rather than defaulted, because each field is a claim the response
  // publishes. `tilesFailed: 0` is the strongest of them — that every tile completed — and a
  // missing region would be published beside the figure as `{0,0,0,0}`.
  for (const field of ['source', 'endpoint', 'fetchedAt', 'maxAreaM2', 'tilesRequested', 'tilesFailed', 'measuredRangeCells', 'region', 'failures'] as const) {
    const partial: Record<string, unknown> = { ...PROVENANCE, cells: [cell()] };
    delete partial[field];
    assert.throws(
      () => loadFixture(write(`no-${field}.json`, partial)),
      /no usable|no failures array/,
      `a fixture missing \`${field}\` is refused rather than given a default`,
    );
  }
});

test('the assembled figure sums the rows and carries what it rests on', () => {
  // Discriminating input: two covered settlements, one threatened. The right answer is the
  // other one's population and not the sum of both — the wrong version ignores the threat set
  // and publishes 300, which is the number that makes the feature argue for itself.
  const fixture: ReachFixture = {
    ...PROVENANCE,
    tilesFailed: 2,
    failures: [{ bbox: '37.12,-2.06,37.15,-2.03', reason: 'HTTP 429' }],
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

test('a threat id that names no settlement is refused, not read as nothing threatened', () => {
  // The engine's settlement ids and this module's come from different places. A case difference or
  // a trailing space makes every id match nothing, so no settlement is threatened, every covered
  // village counts its whole population, and the total silently becomes the largest number the
  // model can produce — with every field on the response still well-formed. Same shape as the
  // node-index bug one layer down: an empty match that reads as a finding instead of an error.
  const fixture: ReachFixture = { ...PROVENANCE, cells: [cell()] };
  const settlements = [settlement({ id: 'bedar' })];

  assert.throws(
    () => assembleReach(fixture, settlements, new Set(['bedar '])),
    /absent from the settlement list/,
    'a trailing space does not pass as "this fire threatens nobody"',
  );
  assert.throws(
    () => assembleReach(fixture, settlements, new Set(['LOS-GALLARDOS'])),
    /absent from the settlement list/,
    'and neither does a case difference',
  );

  // An EMPTY threat set is not refused. A fire that reaches no settlement is a real thing, and the
  // response states it by publishing an empty list rather than by inflating the figure silently.
  assert.deepEqual(
    assembleReach(fixture, settlements, new Set()).threatenedSettlementIds,
    [],
    'an empty threat set is served, and visible',
  );
});

test('the committed fixture and the tiling agree on the region and the request count', () => {
  // The tiling arithmetic is duplicated: `scripts/fetch-reach.mjs` is .mjs, so it carries its own
  // copy rather than importing the TypeScript module.
  //
  // EXACTLY WHAT THIS CROSSES, because it is less than it looks. The committed fixture's
  // `tilesRequested` is the SCRIPT's frozen output, so comparing it against this module's tiling
  // does cross the two implementations as of the last fetch — a fixture regenerated by a diverged
  // script, or a fixture region edited by hand, fails here. What it does NOT do is execute the
  // script: a change to the script's own `tileBounds` in isolation passes every test in this file
  // and surfaces only at the next regeneration. The script is .mjs and calls `main()` on import,
  // so it cannot simply be imported; a `--print-tiles` dry run spawned from here is what would
  // close that, and it is not done.
  const fixture = loadFixture();

  assert.equal(
    tileBounds(fixture.region, fixture.maxAreaM2).length,
    fixture.tilesRequested,
    "the committed request count is the one this module's tiling produces for the committed region",
  );

  // Every committed cell lies inside the box that was surveyed — the property the script's
  // `getInArea` filter is supposed to guarantee, and which nothing previously checked.
  for (const c of fixture.cells) {
    const lat = c.lat as number;
    const lon = c.lon as number;
    assert.ok(
      lat >= fixture.region.south && lat <= fixture.region.north &&
        lon >= fixture.region.west && lon <= fixture.region.east,
      `cell at ${lat},${lon} lies outside the surveyed region`,
    );
  }

  // Every settlement the engine reasons about lies inside the box too. This is what grounds the
  // margin claim in the module header: that figure is measured from these coordinates, and if a
  // settlement ever moved outside the survey the header would be describing a different box.
  // `import.meta.dirname`, not `__dirname`: this project is ESM, where `__dirname` is undefined.
  const settlements = JSON.parse(
    readFileSync(join(import.meta.dirname, '../data/pockets/settlements.json'), 'utf8'),
  ) as { settlements: Array<{ id: string; lat: number; lon: number }> };
  assert.ok(settlements.settlements.length > 0, 'the settlement fixture is not empty');
  for (const s of settlements.settlements) {
    assert.ok(
      s.lat >= fixture.region.south && s.lat <= fixture.region.north &&
        s.lon >= fixture.region.west && s.lon <= fixture.region.east,
      `${s.id} at ${s.lat},${s.lon} lies outside the surveyed region`,
    );
  }

  // And the survey scope names the box it actually bounds, so the response's own description
  // cannot drift from the fixture it describes.
  const scope = assembleReach(fixture, [settlement()], new Set()).surveyScope;
  assert.ok(scope.includes(fixture.region.south.toFixed(3)), 'the scope names the southern edge');
  assert.ok(scope.includes(fixture.region.east.toFixed(3)), 'and the eastern one');
});

test('a fixture whose cells are all unusable is refused, not served as zero coverage', () => {
  // The refusal in `loadFixture` tests the length of the INPUT array, and every one of these has a
  // non-empty one. Published, each gives `cells: 0`, `measuredFraction: null` and
  // `totalOverAlerted: 0` — the safest number the model can produce, produced by having no usable
  // data, which is what this module exists to prevent. Reachable without editing a file at all: a
  // survey whose cells carry no position looks exactly like this, and the fetch script called it a
  // success until it was taught to count USABLE cells rather than cells.
  const cases: RawCell[][] = [
    [{ mcc: 214, mnc: 7, lac: 1, cellid: 1 }],
    [{ mcc: 214, mnc: 7, lac: 1, cellid: 1, lat: 37, lon: -2 }],
    [{ mcc: 214, mnc: 7, lac: 1, cellid: 1, lat: 37, lon: -2, range: 0 }],
    [{ lat: null, lon: null, range: FALLBACK_RANGE_M }],
  ];
  for (const cells of cases) {
    assert.throws(
      () => assembleReach({ ...PROVENANCE, cells }, [settlement()], new Set()),
      /could become a footprint/,
      `must not publish an over-alerting figure of zero for: ${JSON.stringify(cells)}`,
    );
  }

  // A mixed fixture still works, and reports the entries it could not use.
  const mixed = assembleReach(
    { ...PROVENANCE, cells: [cell(), null as unknown as RawCell] },
    [settlement()],
    new Set(),
  );
  assert.equal(mixed.cells, 1, 'the usable cell survives');
  assert.equal(mixed.unusable.length, 1, 'and the bad entry is reported rather than dropped');
});

test('an empty settlement list and a duplicated village are both refused', () => {
  const fixture: ReachFixture = { ...PROVENANCE, cells: [cell()] };

  // `rows: []` with `totalOverAlerted: 0` is the same empty-reads-as-all-clear shape one fixture
  // over, and nothing up the chain checks it: `loadContext` casts `settlements.json` unvalidated.
  assert.throws(
    () => assembleReach(fixture, [], new Set()),
    /no settlements to evaluate/,
    'an empty settlement list is refused rather than served as an empty, well-formed answer',
  );

  // A village listed twice is counted twice, putting the total above the region's population —
  // wrong in the direction that flatters the feature.
  assert.throws(
    () => assembleReach(fixture, [settlement(), settlement()], new Set()),
    /appears more than once/,
    'a duplicated settlement is refused rather than double-counted',
  );
});

test('an unplaceable settlement is named once, and not as having coverage', () => {
  // `unknownPopulation` is documented as "covered, unthreatened, of unknown size". Deriving it
  // from the row shape also matched a settlement that could not be PLACED — named by
  // `unusableSettlements` and covered by nothing — so one id appeared in both lists and a reader
  // was told a village with no usable position has coverage. The absent-becomes-a-fact inversion,
  // occurring in the field that exists to prevent it.
  const set = servedFootprints([cell({ lat: 37.1909, lon: -1.9806, range: 5000 })]);
  const { unknownPopulation, unusableSettlements } = overAlertingBy(
    set,
    [
      settlement({ id: 'placed-unknown', population: null, lat: 37.1909, lon: -1.9806 }),
      settlement({ id: 'unplaceable', population: null, lat: Number.NaN, lon: -1.98 }),
    ],
    new Set<string>(),
  );

  assert.deepEqual(unknownPopulation, ['placed-unknown'], 'only the placed village is of unknown size');
  assert.deepEqual(unusableSettlements.map((u) => u.id), ['unplaceable'], 'and the other is named where it belongs');
  for (const id of unusableSettlements.map((u) => u.id)) {
    assert.ok(!unknownPopulation.includes(id), `${id} is not in both lists`);
  }
});

test('a population key that is absent is unknown, not invisible', () => {
  // An explicit `null` was covered by the null-carrying fix; an ABSENT key was not. It became
  // `undefined`, which `?? 0` dropped from the total while the `=== null` filter did not name it,
  // and `JSON.stringify` then omitted both fields from the row — a village vanishing from the
  // response entirely, which is the worst of the three (absent, zero, unknown) it could have said.
  const set = servedFootprints([cell({ lat: 37.1909, lon: -1.9806, range: 5000 })]);
  const absent = { id: 'absent', name: 'Absent', lat: 37.1909, lon: -1.9806 } as unknown as ReachSettlement;

  const { rows, totalOverAlerted, unknownPopulation } = overAlertingBy(
    set,
    [settlement({ id: 'known', population: 300 }), absent],
    new Set<string>(),
  );

  assert.equal(rows.find((r) => r.settlementId === 'absent')?.population, null, 'absent becomes null, never undefined');
  assert.deepEqual(unknownPopulation, ['absent'], 'and it is named, so the total cannot read as complete');
  assert.equal(totalOverAlerted, 300, 'which counts only what it can');

  // The other shapes of "not a population" get the same treatment: a quoted number concatenates,
  // a NaN serialises as null while looking exactly like the honest unknown, and a negative count
  // subtracts from a figure about people.
  for (const bad of ['3110', Number.NaN, -1, Number.POSITIVE_INFINITY] as unknown[]) {
    const { rows: r } = overAlertingBy(
      set,
      [settlement({ id: 'bad', population: bad as number })],
      new Set<string>(),
    );
    assert.equal(r[0].population, null, `a population of ${String(bad)} is unknown, not published`);
  }
});

test('provenance with the wrong DOMAIN is refused, not only the wrong type', () => {
  // Type and finiteness are not enough for a count: `-1` and `1.5` are both finite and neither is
  // a number of tiles. Both loaded clean and were published on the response as tile counts. And a
  // whitespace-only string is an absence wearing a string type.
  const dir = fixtureDir();
  const cases: Array<[string, Record<string, unknown>]> = [
    ['a negative tile count', { tilesFailed: -1 }],
    ['a fractional tile count', { tilesRequested: 1.5 }],
    ['a zero-area survey box', { maxAreaM2: 0 }],
    ['a whitespace-only source', { source: '   ' }],
    ['a whitespace-only vintage', { fetchedAt: '   ' }],
  ];
  for (const [label, over] of cases) {
    assert.throws(
      () => loadFixture(writeFixture(dir, `${label.replace(/\W+/g, '-')}.json`, { ...PROVENANCE, ...over, cells: [cell()] })),
      /no usable/,
      `${label} is refused rather than published as the fixture's own provenance`,
    );
  }
});
