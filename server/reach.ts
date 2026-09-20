// Reach: which population a cell broadcast would actually reach, and how much of that
// population is being alerted about a fire that does not threaten it.
//
// ES-Alert broadcasts by cell. So the unit an alert reaches is a cell's served footprint,
// not the danger zone the alert is about — and those are different shapes. A tower on the
// far side of a ridge covers a village the fire will never reach, and everybody in that
// village gets the message. That number is what this module produces, and it is the one
// number the engine beside it cannot: egress answers "can this village leave", not "who
// else is being woken up".
//
// WHAT THIS IS NOT. A cell here is a disc of its `range`, not a radio propagation model:
// no terrain, no antenna pattern, no signal strength. And `range` is, on the committed
// fixture, mostly OpenCelliD's 1000 m fallback rather than a measurement: 393 of its 625
// cells (63%) sit at exactly the fallback, against 232 carrying something else across 227
// distinct values. Every entry point therefore reports the measured fraction alongside the
// figure, and a footprint built from the fallback says so on its face. The number is an
// order-of-magnitude figure whose dominant input is a default, and publishing it without
// that is the failure mode this module is written against.
//
// The survey box bounds the CELLS' OWN POSITIONS, not the area they cover — the API filters by
// where a tower is, so a long-range tower just outside the box that reaches a settlement inside
// was never asked about, and its absence would publish as "no coverage". The margin is thin
// against the survey's own data: Lubrín's centre is 1,764 m inside the western edge, while the
// fixture holds cells with ranges over 20 km. `surveyScope` states this on the response for the
// reader who is about to read a coverage column as a fact.
//
// That margin is measured from the settlement coordinates in `data/pockets/settlements.json`, and
// `reach.test.ts` asserts every settlement lies inside the region so the two cannot drift apart.
// An earlier revision of this comment said 745 m — a number produced by hand-typing five
// settlement coordinates into a throwaway probe instead of reading them from the fixture, four of
// which were wrong. Worth knowing if a similar figure appears anywhere else.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { LatLon } from '../shared/fires';

const HERE = dirname(fileURLToPath(import.meta.url));

/** The committed OpenCelliD fetch, written by `scripts/fetch-reach.mjs`. */
export const REACH_FIXTURE_PATH = resolve(HERE, '../data/reach/cells.json');

/**
 * OpenCelliD's fallback served radius, in metres.
 *
 * A cell whose `range` is exactly this is usually one OpenCelliD holds no measurement for.
 * It is not a certainty — a cell could genuinely serve 1000 m — which is why the flag this
 * produces is reported as a flag rather than used to discard anything.
 */
export const FALLBACK_RANGE_M = 1000;

/** A cell as OpenCelliD returns it, before validation. */
export interface RawCell {
  lat?: unknown;
  lon?: unknown;
  range?: unknown;
  mcc?: unknown;
  mnc?: unknown;
  cellid?: unknown;
  lac?: unknown;
}

/** A cell that can be used: a position and a usable radius. */
export interface Cell extends LatLon {
  id: string;
  /** The served footprint radius in metres. Always positive and finite. */
  rangeM: number;
  /** False when `rangeM` is OpenCelliD's fallback rather than a measurement. */
  measured: boolean;
}

/**
 * What became of a set of raw cells.
 *
 * `unusable` is reported rather than dropped silently. A cell with no range, or a range of
 * zero, cannot become a footprint: zero would count nobody and an absent value read as
 * infinity would count everybody, and both are wrong in a way that looks like data.
 */
export interface FootprintSet {
  cells: Cell[];
  /** Cells that could not produce a footprint, with the reason. */
  unusable: Array<{ id: string; reason: string }>;
  /** The proportion of usable cells carrying a measured range, or null when there are none. */
  measuredFraction: number | null;
}

/** A cell id that is stable across fetches: the network coordinates OpenCelliD keys by. */
export function cellId(raw: RawCell): string {
  return [raw.mcc, raw.mnc, raw.lac, raw.cellid].map((v) => String(v ?? '?')).join('-');
}

/**
 * Turn raw cells into footprints, refusing the ones that cannot be one.
 *
 * The refusal is the point. `range` absent, zero, negative or non-numeric would otherwise
 * become a disc of radius `NaN` — which cuts nothing and counts nobody — or, read through a
 * `?? Infinity`, a disc that covers the whole region and counts everybody. Both are the same
 * class of mistake this repository has made before with a fallback standing in for data.
 */
export function servedFootprints(raw: RawCell[]): FootprintSet {
  const cells: Cell[] = [];
  const unusable: Array<{ id: string; reason: string }> = [];

  for (const [index, cell] of raw.entries()) {
    // Before `cellId`, which reads four properties off it. A `null` or a primitive in the array
    // reached `cell.mcc` and threw a bare `TypeError` out of the whole endpoint, with nothing to
    // say which entry was bad — where every other malformed shape is reported per cell. The
    // entry's position is the only identifier available for something that is not an object.
    if (cell === null || typeof cell !== 'object') {
      unusable.push({ id: `#${index}`, reason: `entry is not a cell object: ${String(cell)}` });
      continue;
    }
    // A cell carrying none of the four network coordinates yields `?-?-?-?`, the same id for every
    // such entry — so two different refusals could be published under one identifier, which is the
    // "an absent value read as an identifier" problem the index above exists to avoid. Appending
    // the entry's position disambiguates them.
    const raw = cellId(cell);
    const id = raw === '?-?-?-?' ? `${raw}#${index}` : raw;
    // `typeof` first, for the same reason as `range` below: `Number(null)` is 0 and `Number('')` is
    // 0, so an absent coordinate would be accepted as the Greenwich meridian and the equator rather
    // than refused. Written for `range` and not here first, which let `lon: null` through.
    if (typeof cell.lat !== 'number' || typeof cell.lon !== 'number') {
      unusable.push({ id, reason: `position is not a pair of numbers: ${String(cell.lat)}, ${String(cell.lon)}` });
      continue;
    }
    const lat = cell.lat;
    const lon = cell.lon;
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      unusable.push({ id, reason: `position is not finite: ${String(lat)}, ${String(lon)}` });
      continue;
    }
    // `typeof` first, because `Number(null)` is 0 and `Number('')` is 0 — both would read as a
    // deliberate zero radius rather than as an absent value.
    if (typeof cell.range !== 'number' || !Number.isFinite(cell.range) || cell.range <= 0) {
      unusable.push({ id, reason: `range is not a positive number: ${String(cell.range)}` });
      continue;
    }
    cells.push({ id, lat, lon, rangeM: cell.range, measured: cell.range !== FALLBACK_RANGE_M });
  }

  const measured = cells.filter((c) => c.measured).length;
  return { cells, unusable, measuredFraction: cells.length === 0 ? null : measured / cells.length };
}

/** Metres per degree, on each axis, at a latitude. */
const M_PER_DEG_LAT = 110_977;
const metresPerDegLon = (lat: number): number => Math.max(1, 111_320 * Math.cos((lat * Math.PI) / 180));

/** Great-circle distance in metres. Haversine, because a disc has to be round on a sphere. */
export function distanceMetres(a: LatLon, b: LatLon): number {
  const R = 6_371_008.8;
  const toRad = (d: number): number => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** The settlements this module reasons about. A subset of the engine's, by shape. */
export interface ReachSettlement {
  id: string;
  name: string;
  lat: number;
  lon: number;
  population: number | null;
}

export interface ReachRow {
  settlementId: string;
  name: string;
  /**
   * Straight from the source, which carries null for unknown. Never collapsed to zero.
   *
   * `Settlement.population` is `number | null` for the reason `data/pockets/settlements.json`
   * states: null means unknown and zero means nobody lives there. Coercing it here made a village
   * of unknown size report `population: 0, overAlerted: 0` — indistinguishable from an empty one,
   * and silently absent from the total.
   */
  population: number | null;
  /** How many cells' footprints contain the settlement's point. */
  coveringCells: number;
  /** Of those, how many carry a measured range rather than the fallback. */
  coveringCellsMeasured: number;
  /**
   * True when the fire reaches this settlement, so an alert for it is not over-alerting.
   */
  threatened: boolean;
  /**
   * The population receiving an alert for a fire that does not threaten them. Zero for a
   * threatened settlement, which is the case the product exists for, and zero for one no cell
   * covers, since nobody can be broadcast to.
   *
   * NULL when the settlement is over-alerted but the size of the error is unknown — its
   * population is null, or its position is not a pair of numbers and it cannot be placed inside
   * or outside a footprint at all. Null is the honest answer there and zero is not: zero is a
   * fact about the world, and this is an absence of one.
   */
  overAlerted: number | null;
}

export interface ReachResult {
  rows: ReachRow[];
  /** The proportion of usable cells carrying a measured range. */
  measuredFraction: number | null;
  /** Cells that could not become a footprint. */
  unusable: Array<{ id: string; reason: string }>;
  /** The region's cell count, and how the figure below is not a measurement. */
  cells: number;
  /**
   * Settlements that could not be evaluated, with the reason — mirroring `unusable` for cells.
   *
   * A settlement the input gives no usable position for is not a settlement with no coverage.
   * Reading it as one is the same inversion this module refuses for a cell with no range: an
   * absent value becoming a fact.
   */
  unusableSettlements: Array<{ id: string; reason: string }>;
  /** The sum over rows whose contribution is known. A floor, not a complete sum. */
  totalOverAlerted: number;
  /**
   * Settlements excluded from `totalOverAlerted` because their size is unknown.
   *
   * Published so the total cannot be read as complete. Without it a village of unknown
   * population contributes nothing and the total looks finished.
   */
  unknownPopulation: string[];
}

/**
 * The population a broadcast would reach for a fire that does not threaten them.
 *
 * A settlement is a POINT here — its coordinate, which is how the egress engine snaps a
 * pocket to the road graph. So "inside a footprint" is a point-in-disc test and a settlement
 * is covered wholly or not at all; there is no part-of-a-village case. What that means in
 * practice: a village whose houses straddle a footprint boundary is counted by whether its
 * centre is inside, and a large village just outside a 1 km disc contributes nothing. Stated
 * because the alternative reading — counting a village because a footprint clips its edge —
 * would raise the number with no more evidence behind it.
 *
 * The choice cuts BOTH ways, and neither direction is a bound. A village whose centre is just
 * inside a disc contributes its whole population, including the residents the broadcast would
 * never reach — that over-counts. One whose centre is just outside contributes nobody, including
 * the residents the broadcast would reach — that under-counts. An areal settlement model is what
 * would tighten it, and the data for that is not in this repository.
 *
 * The fallback radius does not make it an upper bound either, which is worth stating because it
 * is the intuitive reading. On the committed fixture 231 of the 232 non-fallback ranges are
 * ABOVE 1,000 m — median 2,845, maximum 20,506 — so substituting the fallback for a cell that
 * carries a measurement SHRINKS its footprint rather than growing it. The number is an
 * order-of-magnitude estimate with error in both directions, which is why `measuredFraction` and
 * the survey scope are published beside it rather than the figure standing alone.
 */
export function overAlertingBy(
  set: FootprintSet,
  settlements: ReachSettlement[],
  threatened: ReadonlySet<string>,
): ReachResult {
  const rows: ReachRow[] = [];
  const unusableSettlements: Array<{ id: string; reason: string }> = [];
  // Collected here rather than derived from `rows` afterwards. Filtering rows on
  // `population === null && overAlerted === null` also matches an UNPLACEABLE settlement, which
  // `unusableSettlements` already names and which no footprint covers — so the same id would
  // appear in both lists, and a consumer reading this one as documented ("covered, unthreatened")
  // would be told a village it cannot place has coverage. That is the absent-becomes-a-fact
  // inversion this field exists to prevent, occurring in the field itself.
  const unknownPopulation: string[] = [];

  for (const s of settlements) {
    // `typeof`-first, the rule this function already applies to the position and the cells get,
    // applied to the population for the same reason. The `=== null` check the null-carrying fix
    // added covers only an explicit null, and each of the other shapes is a different wrong answer:
    //   - an ABSENT key is `undefined`, which `?? 0` drops from the total while the `=== null`
    //     filter does not name it, and `JSON.stringify` then omits the field from the row — a
    //     village vanishing from the response entirely;
    //   - a quoted `"3110"` is valid JSON and concatenates, publishing `totalOverAlerted: "03110"`
    //     where the contract says a number;
    //   - `NaN` makes the total `NaN`, which serialises as `null` while rendering exactly like the
    //     honest unknown, so the signal added to distinguish "unknown" from "zero" cannot tell it
    //     from "corrupt";
    //   - a negative count subtracts from a figure about people.
    const population =
      typeof s.population === 'number' && Number.isFinite(s.population) && s.population >= 0
        ? s.population
        : null;

    // And the same rule for the position: `Number(null)` is 0, so a missing coordinate would
    // otherwise be read as the point (0, 0), and every settlement would then be tested against
    // footprints 3,000 km away and report `coveringCells: 0` — which this module publishes as the
    // fact "no cell covers this village".
    if (
      typeof s.lat !== 'number' || typeof s.lon !== 'number' ||
      !Number.isFinite(s.lat) || !Number.isFinite(s.lon)
    ) {
      unusableSettlements.push({
        id: s.id,
        reason: `position is not a pair of finite numbers: ${String(s.lat)}, ${String(s.lon)}`,
      });
      rows.push({
        settlementId: s.id,
        name: s.name,
        population,
        coveringCells: 0,
        coveringCellsMeasured: 0,
        threatened: threatened.has(s.id),
        // Unknown, not zero. We could not place the village inside or outside any footprint, so we
        // have no answer about whether it is over-alerted — whereas zero is an answer.
        overAlerted: null,
      });
      continue;
    }

    const covering = set.cells.filter((c) => distanceMetres(s, c) <= c.rangeM);
    const isThreatened = threatened.has(s.id);
    // Covered and unthreatened, but nobody recorded how many people live here: a genuine
    // over-alert of unknown size, and the only case this list is for.
    if (population === null && !isThreatened && covering.length > 0) unknownPopulation.push(s.id);
    rows.push({
      settlementId: s.id,
      name: s.name,
      population,
      coveringCells: covering.length,
      coveringCellsMeasured: covering.filter((c) => c.measured).length,
      threatened: isThreatened,
      // Zero for a settlement the fire reaches: that alert is the product working, and counting it
      // would make the figure rise as the fire got worse. Zero also when NO cell covers it — nobody
      // can broadcast to it, so nobody receives an alert for it, however unthreatened it is. Without
      // that second condition every uncovered village adds its whole population to a number about
      // people being alerted, which is the opposite of what it measures. An uncovered settlement is
      // reported by `coveringCells: 0`, not by inflating this.
      //
      // Null when the village IS over-alerted but nobody knows how many people live in it. It is
      // covered and unthreatened, so an alert for it is an over-alert; the size of that error is
      // simply not recorded, and a zero here would report it as no error at all.
      overAlerted: isThreatened || covering.length === 0 ? 0 : population,
    });
  }

  return {
    rows,
    measuredFraction: set.measuredFraction,
    unusable: set.unusable,
    cells: set.cells.length,
    unusableSettlements,
    // Rows with a null contribution are exactly the ones the total cannot include, and each is
    // named by one of these two lists — `unusableSettlements` for a row that could not be placed,
    // `unknownPopulation` for one placed but of unknown size. Between them the shortfall is
    // accounted for; a row held by neither would be a settlement that vanished silently.
    totalOverAlerted: rows.reduce((sum, row) => sum + (row.overAlerted ?? 0), 0),
    unknownPopulation,
  };
}

/**
 * The bounding boxes covering a region, each within a per-request area limit.
 *
 * OpenCelliD refuses any box over 4,000,000 m², so a region the size of the demo's cannot be
 * asked for in one call. The tiling is here, next to the model, rather than only in the fetch
 * script, so the arithmetic that decides a box is a legal size is testable without a network
 * call — and so the count of requests is a number the script can report rather than discover.
 */
export function tileBounds(
  bounds: { south: number; west: number; north: number; east: number },
  maxAreaM2 = 4_000_000,
): Array<{ south: number; west: number; north: number; east: number }> {
  const midLat = (bounds.south + bounds.north) / 2;
  // A side that satisfies side² <= maxArea on the ground. Kept square in metres, not in
  // degrees: a degree of longitude is shorter than a degree of latitude here, so a square in
  // degrees is a rectangle in metres and would breach the limit on the long axis.
  const sideM = Math.sqrt(maxAreaM2);
  const dLat = sideM / M_PER_DEG_LAT;
  const dLon = sideM / metresPerDegLon(midLat);
  if (dLat <= 0 || dLon <= 0) return [];

  const tiles: Array<{ south: number; west: number; north: number; east: number }> = [];
  const stepsLat = Math.max(1, Math.ceil((bounds.north - bounds.south) / dLat));
  const stepsLon = Math.max(1, Math.ceil((bounds.east - bounds.west) / dLon));
  for (let i = 0; i < stepsLat; i++) {
    for (let j = 0; j < stepsLon; j++) {
      tiles.push({
        south: bounds.south + (i * (bounds.north - bounds.south)) / stepsLat,
        north: bounds.south + ((i + 1) * (bounds.north - bounds.south)) / stepsLat,
        west: bounds.west + (j * (bounds.east - bounds.west)) / stepsLon,
        east: bounds.west + ((j + 1) * (bounds.east - bounds.west)) / stepsLon,
      });
    }
  }
  return tiles;
}

/** The ground area of a box in m², by the same approximation the tiling uses. */
export function tileAreaM2(tile: { south: number; west: number; north: number; east: number }): number {
  const midLat = (tile.south + tile.north) / 2;
  return (tile.north - tile.south) * M_PER_DEG_LAT * (tile.east - tile.west) * metresPerDegLon(midLat);
}

/** The committed fetch, as `scripts/fetch-reach.mjs` writes it. */
export interface ReachFixture {
  source: string;
  endpoint: string;
  fetchedAt: string;
  region: { south: number; west: number; north: number; east: number };
  maxAreaM2: number;
  /** How many boxes the enumeration asked for, and how many it could not complete. */
  tilesRequested: number;
  tilesFailed: number;
  /** The boxes that failed, with the API's reason, so "empty" and "unasked" stay apart. */
  failures: Array<{ bbox: string; reason: string }>;
  cells: RawCell[];
  /** The script's own measured count. Reported for cross-checking, never used as the figure. */
  measuredRangeCells: number;
}

/**
 * Read the committed fetch, refusing anything that is not one.
 *
 * The refusal is the point, and it is the same failure this module is written against one level
 * down. A missing, malformed or EMPTY fixture yields no cells, and no cells yields no coverage,
 * and no coverage yields an over-alerting figure of zero — the safest possible number, produced
 * by having no data at all. That is the empty-mask-reads-as-all-clear inversion, arriving through
 * the file system instead of through the mask.
 *
 * Every one of those cases throws. The empty one did not, in the first version of this function,
 * which refused the malformed shapes and substituted defaults for the rest — including a
 * `tilesFailed: 0` asserting that every tile completed.
 */
export function loadFixture(path: string = REACH_FIXTURE_PATH): ReachFixture {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    throw new Error(
      `no OpenCelliD fetch at ${path} — run "node scripts/fetch-reach.mjs" with OPENCELLID_TOKEN set, ` +
        'rather than serving an empty region as though nothing were covered',
    );
  }
  let parsed: Partial<ReachFixture>;
  try {
    parsed = JSON.parse(raw) as Partial<ReachFixture>;
  } catch {
    // A bare SyntaxError here named no file and no field, and the route logs the failure against
    // the generic 'reach unavailable' — so a truncated fixture, which is what a crash mid-write
    // leaves behind, cost the operator the one thing they needed: which file to look at.
    throw new Error(`${path} is not readable JSON; refusing to guess what a truncated fixture meant`);
  }
  if (!Array.isArray(parsed.cells)) {
    throw new Error(`${path} carries no cells array; refusing to read it as an empty region`);
  }
  // An EMPTY array is refused too, and this is the case the guard above was written for and did
  // not cover. A survey of 88 tiles over a populated region that returned no towers is a failed
  // survey, not a region without towers — and served, it publishes `cells: 0`, every settlement
  // at `coveringCells: 0` and `totalOverAlerted: 0`, which reads as "nobody is being woken up for
  // nothing". That is the empty-mask-reads-as-all-clear inversion arriving through the file
  // system, and `egress.ts` refuses its equivalent outright ("refusing to compute a cut field
  // from an empty mask"). An earlier revision of this function accepted it, and a test asserted
  // that acceptance; both were wrong.
  if (parsed.cells.length === 0) {
    throw new Error(
      `${path} carries no cells; a survey over this region that found none has failed, and ` +
        'serving it would publish an over-alerting figure of zero',
    );
  }

  // Provenance is refused rather than defaulted, for the same reason the cells array is: every
  // field below is a claim the response publishes, and a substituted default turns "we do not
  // know" into a specific fact. `tilesFailed: 0` is the strongest claim the response makes — that
  // every tile completed — and a region of `{0,0,0,0}` publishes null island beside a coverage
  // figure. A fixture that cannot state its own provenance cannot support a claim about coverage.
  const str = (field: 'source' | 'endpoint' | 'fetchedAt'): string => {
    const value = parsed[field];
    // A whitespace-only string is an absence wearing a string type, and the rule this refuses on
    // is that an absence must not be published as a fact. `value === ''` alone let `"   "` through
    // as the fixture's provenance.
    if (typeof value !== 'string' || value.trim() === '') {
      throw new Error(`${path} has no usable \`${field}\`; refusing to publish a default in its place`);
    }
    return value.trim();
  };
  // Type and finiteness are not enough for a COUNT. `-1` and `1.5` are both finite numbers and
  // neither is a number of tiles; both loaded clean and were published on the response as counts.
  const count = (field: 'tilesRequested' | 'tilesFailed' | 'measuredRangeCells'): number => {
    const value = parsed[field];
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
      throw new Error(`${path} has no usable \`${field}\`; refusing to publish a default in its place`);
    }
    return value;
  };
  // And an AREA has to be positive: `maxAreaM2: 0` is a limit no tile could ever satisfy, carried
  // into `surveyScope` as the box's own description.
  const positive = (field: 'maxAreaM2'): number => {
    const value = parsed[field];
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
      throw new Error(`${path} has no usable \`${field}\`; refusing to publish a default in its place`);
    }
    return value;
  };
  // `region: null` is checked before the fields are read. Testing only `=== undefined` let it
  // through to `region.south`, which threw a bare TypeError naming no field and no path — the same
  // diagnosability gap the per-entry cell refusals were added to close.
  const rawRegion = parsed.region as unknown;
  if (rawRegion === null || rawRegion === undefined || typeof rawRegion !== 'object') {
    throw new Error(`${path} has no usable region; refusing to publish coverage against an unknown survey box`);
  }
  const region = rawRegion as ReachFixture['region'];
  if (
    !Number.isFinite(region.south) || !Number.isFinite(region.west) ||
    !Number.isFinite(region.north) || !Number.isFinite(region.east)
  ) {
    throw new Error(`${path} has no usable region; refusing to publish coverage against an unknown survey box`);
  }
  if (!Array.isArray(parsed.failures)) {
    throw new Error(`${path} has no failures array; refusing to read missing tile failures as none`);
  }

  return {
    source: str('source'),
    endpoint: str('endpoint'),
    fetchedAt: str('fetchedAt'),
    region,
    maxAreaM2: positive('maxAreaM2'),
    tilesRequested: count('tilesRequested'),
    tilesFailed: count('tilesFailed'),
    failures: parsed.failures,
    cells: parsed.cells,
    measuredRangeCells: count('measuredRangeCells'),
  };
}

/**
 * What the region bounds, in words.
 *
 * The survey box filters the CELLS' OWN COORDINATES — `getInArea` returns a cell whose position
 * lies inside the box — so it is not a promise about the area those cells cover. A tower outside
 * the box with a range long enough to reach a settlement inside it was never asked about, and
 * that settlement then reports fewer covering cells than it has. The committed fixture holds
 * ranges over 20 km against a bound that leaves Lubrín 745 m of margin, so this is not
 * hypothetical.
 *
 * Derived from the region rather than stored, so it cannot fall out of step with the box it
 * describes.
 */
export function surveyScope(region: ReachFixture['region']): string {
  const fmt = (v: number): string => v.toFixed(3);
  return (
    `Cells whose own coordinates lie within ${fmt(region.south)},${fmt(region.west)} to ` +
    `${fmt(region.north)},${fmt(region.east)}. A tower outside this box whose range reaches a ` +
    'settlement inside it was not requested, so a low covering-cell count means "few towers ' +
    'surveyed here", not "few towers serve here".'
  );
}

/** The whole reach answer: the figure, its rows, and what it rests on. */
export interface ReachResponse {
  /** Where the cells came from, and when. A figure about coverage is only readable with both. */
  source: string;
  fetchedAt: string;
  region: { south: number; west: number; north: number; east: number };
  /**
   * How many boxes the fetch asked for and how many it could not complete.
   *
   * Published because a failed tile and a tile with no towers in it are the same observation
   * from outside: both contribute no cells. Without these two numbers a reader cannot tell
   * "there is no coverage in that box" from "we did not manage to ask about that box".
   */
  tilesRequested: number;
  tilesFailed: number;
  failures: Array<{ bbox: string; reason: string }>;
  /**
   * What the survey box bounds, in words — the cells' own positions, not the area they cover.
   *
   * Published beside the coverage columns because a reader is about to take them as facts about
   * which villages have towers, and for the villages nearest the edge that is not what they are.
   */
  surveyScope: string;
  /** Usable cells, and those that could not become a footprint. */
  cells: number;
  unusable: Array<{ id: string; reason: string }>;
  /** The proportion of usable cells carrying a measured range rather than the fallback. */
  measuredFraction: number | null;
  /** Settlements the fire reaches, which is why they are excluded from the figure below. */
  threatenedSettlementIds: string[];
  /** Settlements whose position could not be read, so they were not evaluated at all. */
  unusableSettlements: Array<{ id: string; reason: string }>;
  /**
   * The sum over rows whose contribution is known.
   *
   * A FLOOR, not a complete sum: `unknownPopulation` names the covered, unthreatened settlements
   * whose size is not recorded and which therefore contribute nothing to it.
   */
  totalOverAlerted: number;
  /** Covered, unthreatened settlements of unknown size, excluded from the total above. */
  unknownPopulation: string[];
  rows: ReachRow[];
}

/**
 * Assemble the response from the fixture, the settlements and the fire's reach.
 *
 * `threatened` is passed in rather than derived here: which settlements a fire reaches is the
 * egress engine's answer, and re-deriving it from the fire's geometry in this module would put
 * two definitions of "reaches" in the repository.
 */
export function assembleReach(
  fixture: ReachFixture,
  settlements: ReachSettlement[],
  threatened: ReadonlySet<string>,
): ReachResponse {
  // The threat ids must name settlements this module has. When they do not — a case difference, a
  // trailing space, a renamed pocket — nothing is marked threatened, every covered village counts
  // its whole population, and the total silently becomes the largest number the model can produce
  // while every field still looks well-formed. That is the same failure as the node-index bug one
  // layer down: an empty match reading as a finding rather than as an error.
  //
  // An EMPTY threat set is not refused. A fire that reaches no settlement is a real thing, and
  // `threatenedSettlementIds: []` on the response is how a reader sees it.
  //
  // An empty SETTLEMENT list is refused, and it is a different case: `rows: []` with
  // `totalOverAlerted: 0` is the empty-reads-as-all-clear shape one fixture over, and nothing up
  // the chain checks it — `loadContext` casts the parsed `settlements.json` without looking.
  if (settlements.length === 0) {
    throw new Error(
      'no settlements to evaluate; refusing to publish an over-alerting figure of zero for a ' +
        'response with no villages in it',
    );
  }
  // A village listed twice is counted twice, and the total then exceeds the sum of the region's
  // population — a number that is wrong in the direction that flatters the feature.
  const duplicate = settlements.map((s) => s.id).find((id, i, all) => all.indexOf(id) !== i);
  if (duplicate !== undefined) {
    throw new RangeError(
      `settlement "${duplicate}" appears more than once; refusing to count it twice in the total`,
    );
  }
  const known = new Set(settlements.map((s) => s.id));
  const unmatched = [...threatened].filter((id) => !known.has(id));
  if (unmatched.length > 0) {
    throw new RangeError(
      `the threat set names ${unmatched.length} settlement(s) absent from the settlement list ` +
        `(${unmatched.join(', ')}); refusing to report that nothing is threatened`,
    );
  }

  const set = servedFootprints(fixture.cells);
  // A fixture whose entries are all UNUSABLE is an empty survey wearing a non-empty array, and it
  // is the case the refusal in `loadFixture` does not reach: that one tests the length of the
  // input, and `cells: [null]`, `[{}]`, or cells carrying no range all pass it. Published, they
  // give `cells: 0`, `measuredFraction: null` and `totalOverAlerted: 0` — the safest number the
  // model can produce, from having no usable data. Reachable without editing a file: a survey
  // whose cells lack a position yields exactly this, and the fetch script would call it a success.
  //
  // The refusal lives here rather than in `servedFootprints`, which stays a pure function: an
  // empty set from an empty input is a correct return value, and it is the PUBLICATION of it as a
  // coverage claim that has to fail. `egress.ts` refuses its equivalent the same way.
  if (set.cells.length === 0) {
    throw new Error(
      `none of the ${fixture.cells.length} cells in the fixture could become a footprint; ` +
        'refusing to publish an over-alerting figure of zero for a survey with no usable cells',
    );
  }
  // The total is taken from the result rather than re-summed here. A second summation is a second
  // definition of it, and the one that would drift is the one nobody reads.
  const result = overAlertingBy(set, settlements, threatened);
  return {
    source: fixture.source,
    fetchedAt: fixture.fetchedAt,
    region: fixture.region,
    surveyScope: surveyScope(fixture.region),
    tilesRequested: fixture.tilesRequested,
    tilesFailed: fixture.tilesFailed,
    failures: fixture.failures,
    cells: result.cells,
    unusable: result.unusable,
    measuredFraction: result.measuredFraction,
    threatenedSettlementIds: [...threatened],
    unusableSettlements: result.unusableSettlements,
    totalOverAlerted: result.totalOverAlerted,
    unknownPopulation: result.unknownPopulation,
    rows: result.rows,
  };
}
