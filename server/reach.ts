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
// cells (63%) sit at exactly the fallback, against 232 carrying something else across 228
// distinct values. Every entry point therefore reports the measured fraction alongside the
// figure, and a footprint built from the fallback says so on its face. The number is an
// order-of-magnitude figure whose dominant input is a default, and publishing it without
// that is the failure mode this module is written against.

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

  for (const cell of raw) {
    const id = cellId(cell);
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
  /** The population the settlement contributes, or 0 when unknown. */
  population: number;
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
   * threatened settlement, which is the case the product exists for.
   */
  overAlerted: number;
}

export interface ReachResult {
  rows: ReachRow[];
  /** The proportion of usable cells carrying a measured range. */
  measuredFraction: number | null;
  /** Cells that could not become a footprint. */
  unusable: Array<{ id: string; reason: string }>;
  /** The region's cell count, and how the figure below is not a measurement. */
  cells: number;
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
 */
export function overAlertingBy(
  set: FootprintSet,
  settlements: ReachSettlement[],
  threatened: ReadonlySet<string>,
): ReachResult {
  const rows: ReachRow[] = settlements.map((s) => {
    const covering = set.cells.filter((c) => distanceMetres(s, c) <= c.rangeM);
    const isThreatened = threatened.has(s.id);
    const population = s.population ?? 0;
    return {
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
      overAlerted: isThreatened || covering.length === 0 ? 0 : population,
    };
  });

  return {
    rows,
    measuredFraction: set.measuredFraction,
    unusable: set.unusable,
    cells: set.cells.length,
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
 * The refusal is the point, and it is the same failure this module is written against one
 * level down. A missing or malformed fixture yields no cells, and no cells yields no
 * coverage, and no coverage yields an over-alerting figure of zero — the safest possible
 * number, produced by having no data at all. That is the empty-mask-reads-as-all-clear
 * inversion, arriving through the file system instead of through the mask.
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
  const parsed = JSON.parse(raw) as Partial<ReachFixture>;
  if (!Array.isArray(parsed.cells)) {
    throw new Error(`${path} carries no cells array; refusing to read it as an empty region`);
  }
  return {
    source: typeof parsed.source === 'string' ? parsed.source : 'OpenCelliD',
    endpoint: typeof parsed.endpoint === 'string' ? parsed.endpoint : '',
    fetchedAt: typeof parsed.fetchedAt === 'string' ? parsed.fetchedAt : '',
    region: parsed.region ?? { south: 0, west: 0, north: 0, east: 0 },
    maxAreaM2: typeof parsed.maxAreaM2 === 'number' ? parsed.maxAreaM2 : 0,
    tilesRequested: typeof parsed.tilesRequested === 'number' ? parsed.tilesRequested : 0,
    tilesFailed: typeof parsed.tilesFailed === 'number' ? parsed.tilesFailed : 0,
    failures: Array.isArray(parsed.failures) ? parsed.failures : [],
    cells: parsed.cells,
    measuredRangeCells: typeof parsed.measuredRangeCells === 'number' ? parsed.measuredRangeCells : 0,
  };
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
  /** Usable cells, and those that could not become a footprint. */
  cells: number;
  unusable: Array<{ id: string; reason: string }>;
  /** The proportion of usable cells carrying a measured range rather than the fallback. */
  measuredFraction: number | null;
  /** Settlements the fire reaches, which is why they are excluded from the figure below. */
  threatenedSettlementIds: string[];
  /** The sum over `rows`. Zero for every threatened settlement, by construction. */
  totalOverAlerted: number;
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
  const set = servedFootprints(fixture.cells);
  const result = overAlertingBy(set, settlements, threatened);
  return {
    source: fixture.source,
    fetchedAt: fixture.fetchedAt,
    region: fixture.region,
    tilesRequested: fixture.tilesRequested,
    tilesFailed: fixture.tilesFailed,
    failures: fixture.failures,
    cells: result.cells,
    unusable: result.unusable,
    measuredFraction: result.measuredFraction,
    threatenedSettlementIds: [...threatened],
    totalOverAlerted: result.rows.reduce((sum, row) => sum + row.overAlerted, 0),
    rows: result.rows,
  };
}
