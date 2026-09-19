// Pocket geometry, from the Catastro footprints.
//
// The fixture keeps coordinates in EPSG:25830, which is what Catastro speaks, and the
// conversion happens here rather than at fetch time. Converting on the way in would bake
// a projection error into committed data with nothing to check it against; here it is
// covered by a round-trip test.
//
// Coordinates are not the only thing the fixture carries. A pocket needs an outline for
// the CAP `area` element, and the honest outline is the extent of its buildings — the
// 400 m box the engine used before the footprints landed was a placeholder that would
// have drawn a square over whatever happened to be nearby.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { LatLon } from '../../shared/fires';

const HERE = dirname(fileURLToPath(import.meta.url));
export const BUILDINGS_PATH = resolve(HERE, '../../data/pockets/buildings.json');

const A = 6378137.0;
const F = 1 / 298.257223563;
const E2 = F * (2 - F);
/** ETRS89 / UTM zone 30N: central meridian 3 degrees WEST, so Spanish longitudes sit east of it. */
const LON0 = -3.0;
const K0 = 0.9996;

export function latLonToUtm30n(lat: number, lon: number): { e: number; n: number } {
  const rad = Math.PI / 180;
  const p = lat * rad;
  const l = (lon - LON0) * rad;
  const ep2 = E2 / (1 - E2);
  const n = A / Math.sqrt(1 - E2 * Math.sin(p) ** 2);
  const t = Math.tan(p) ** 2;
  const c = ep2 * Math.cos(p) ** 2;
  const aa = Math.cos(p) * l;
  const m =
    A * ((1 - E2 / 4 - (3 * E2 ** 2) / 64) * p
      - ((3 * E2) / 8 + (3 * E2 ** 2) / 32) * Math.sin(2 * p)
      + ((15 * E2 ** 2) / 256) * Math.sin(4 * p));
  const e = K0 * n * (aa + ((1 - t + c) * aa ** 3) / 6 + ((5 - 18 * t + t * t) * aa ** 5) / 120) + 500000;
  const nn = K0 * (m + n * Math.tan(p) * ((aa * aa) / 2
    + ((5 - t + 9 * c + 4 * c * c) * aa ** 4) / 24
    + ((61 - 58 * t + t * t) * aa ** 6) / 720));
  return { e, n: nn };
}

/** Inverse of the above. Northern hemisphere, so the false northing is zero. */
export function utm30nToLatLon(e: number, n: number): LatLon {
  const ep2 = E2 / (1 - E2);
  const e1 = (1 - Math.sqrt(1 - E2)) / (1 + Math.sqrt(1 - E2));
  const m = n / K0;
  const mu = m / (A * (1 - E2 / 4 - (3 * E2 ** 2) / 64 - (5 * E2 ** 3) / 256));
  const phi1 =
    mu
    + ((3 * e1) / 2 - (27 * e1 ** 3) / 32) * Math.sin(2 * mu)
    + ((21 * e1 ** 2) / 16 - (55 * e1 ** 4) / 32) * Math.sin(4 * mu)
    + ((151 * e1 ** 3) / 96) * Math.sin(6 * mu);
  const sinPhi = Math.sin(phi1);
  const cosPhi = Math.cos(phi1);
  const c1 = ep2 * cosPhi ** 2;
  const t1 = Math.tan(phi1) ** 2;
  const n1 = A / Math.sqrt(1 - E2 * sinPhi ** 2);
  const r1 = (A * (1 - E2)) / (1 - E2 * sinPhi ** 2) ** 1.5;
  const d = (e - 500000) / (n1 * K0);
  const lat =
    phi1
    - ((n1 * Math.tan(phi1)) / r1)
      * (d ** 2 / 2
        - ((5 + 3 * t1 + 10 * c1 - 4 * c1 ** 2 - 9 * ep2) * d ** 4) / 24
        + ((61 + 90 * t1 + 298 * c1 + 45 * t1 ** 2 - 252 * ep2 - 3 * c1 ** 2) * d ** 6) / 720);
  const lon =
    LON0 * (Math.PI / 180)
    + (d
      - ((1 + 2 * t1 + c1) * d ** 3) / 6
      + ((5 - 2 * c1 + 28 * t1 - 3 * c1 ** 2 + 8 * ep2 + 24 * t1 ** 2) * d ** 5) / 120)
      / cosPhi;
  return { lat: (lat * 180) / Math.PI, lon: (lon * 180) / Math.PI };
}

export interface BuildingFixture {
  source: string;
  fetched: string;
  settlements: Array<{
    id: string;
    name: string;
    population: number | null;
    buildings: number;
    /** Hull of the building centroids, EPSG:25830 [easting, northing]. */
    hullUtm30n: Array<[number, number]>;
    centreUtm30n: [number, number];
    footprints: Array<Array<[number, number]>>;
  }>;
}

export interface PocketGeometry {
  id: string;
  name: string;
  buildings: number;
  population: number | null;
  centroid: LatLon;
  /** Closed ring in WGS84, ready for the CAP `area` element. */
  outline: LatLon[];
}

let cache: Map<string, PocketGeometry> | null = null;

export function loadPocketGeometry(path: string = BUILDINGS_PATH): Map<string, PocketGeometry> {
  if (cache !== null && path === BUILDINGS_PATH) return cache;
  let raw: BuildingFixture;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8')) as BuildingFixture;
  } catch {
    // No footprints yet. The caller falls back to a placeholder outline, and says so.
    return new Map();
  }
  const out = new Map<string, PocketGeometry>();
  for (const s of raw.settlements ?? []) {
    const outline = (s.hullUtm30n ?? []).map(([e, n]) => utm30nToLatLon(e, n));
    if (outline.length < 3) continue;
    // Close the ring: CAP wants the first position repeated at the end, and a hull
    // routine returns it open.
    const first = outline[0];
    const last = outline[outline.length - 1];
    if (first.lat !== last.lat || first.lon !== last.lon) outline.push({ ...first });
    const centroid = utm30nToLatLon(s.centreUtm30n[0], s.centreUtm30n[1]);
    out.set(s.id, {
      id: s.id,
      name: s.name,
      buildings: s.buildings,
      population: s.population,
      centroid,
      outline,
    });
  }
  if (path === BUILDINGS_PATH) cache = out;
  return out;
}
