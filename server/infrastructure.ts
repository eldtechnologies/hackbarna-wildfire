// Loads the bundled infrastructure GeoJSON (data/infrastructure/, generated
// by scripts/fetch-infrastructure.mjs) and normalizes it into the shared
// schema. Read once at startup; the files are committed so this never needs
// network access.

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type {
  InfrastructureAsset,
  InfrastructureCoverage,
  InfrastructureResponse,
} from '../shared/threats';
import type { LatLon } from '../shared/fires';

// Where the bundled infrastructure data actually exists. The extent is the
// observed bbox of the committed point assets (Catalonia administrative
// datasets, per scripts/fetch-infrastructure.mjs); it is not a guarantee of
// complete coverage inside the rectangle. Consumers qualify an empty threat
// list with this so "no assets" is not read as "safe".
export const INFRASTRUCTURE_COVERAGE: InfrastructureCoverage = {
  label: 'Catalonia (bundled data extent)',
  bbox: [0.25, 40.54, 3.28, 42.84], // [west, south, east, north] degrees
};

const ALMERIA_COVERAGE: InfrastructureCoverage = {
  label: 'Eastern Almería (OpenStreetMap)',
  bbox: [-2.45, 36.8, -1.55, 37.65],
  note: 'OSM snapshot 2026-09-18; not a historical inventory. Mapped assets may be incomplete.',
};

export function coverageAt(p: LatLon): InfrastructureCoverage | null {
  return [INFRASTRUCTURE_COVERAGE, ALMERIA_COVERAGE].find(coverage => {
    const [west, south, east, north] = coverage.bbox;
    return p.lat >= south && p.lat <= north && p.lon >= west && p.lon <= east;
  }) ?? null;
}

const INFRA_DIR = path.resolve(process.cwd(), 'data/infrastructure');

interface RawPointFeature {
  properties: {
    id?: string;
    name?: string;
    category?: string;
    municipality?: string | null;
    county?: string | null;
  };
  geometry: { type: 'Point'; coordinates: [number, number] };
}

interface RawLineFeature {
  properties: {
    id?: string;
    name?: string | null;
    category?: string;
    voltageKv?: number;
    operator?: string | null;
  };
  geometry: { type: 'LineString'; coordinates: [number, number][] };
}

export function toAsset(f: RawPointFeature): InfrastructureAsset | null {
  const coords = f?.geometry?.coordinates;
  const category = f?.properties?.category;
  if (f?.geometry?.type !== 'Point' || !Array.isArray(coords)
    || (category !== 'hospital' && category !== 'school' && category !== 'town')) return null;
  const [lon, lat] = coords;
  if (!f.properties?.id || !f.properties.name || !Number.isFinite(lat) || !Number.isFinite(lon)) {
    return null;
  }
  return {
    id: f.properties.id,
    name: f.properties.name,
    category,
    position: { lat, lon },
    municipality: f.properties.municipality ?? null,
    county: f.properties.county ?? null,
    voltageKv: null,
    operator: null,
  };
}

export function lineToAsset(f: RawLineFeature): { asset: InfrastructureAsset; path: LatLon[] } | null {
  const coords = f?.geometry?.coordinates;
  if (f?.geometry?.type !== 'LineString' || !Array.isArray(coords) || !f.properties?.id
    || coords.length < 2 || !coords.every(p => Array.isArray(p) && p.length >= 2 && p.slice(0,2).every(Number.isFinite))) return null;
  const path = coords.map(([lon, lat]) => ({ lat, lon }));
  const mid = path[Math.floor(path.length / 2)];
  return {
    asset: {
      id: f.properties.id,
      name: f.properties.name ?? `Power line ${f.properties.voltageKv ?? ''} kV`.trim(),
      category: 'power-line',
      position: mid,
      municipality: null,
      county: null,
      voltageKv: f.properties.voltageKv ?? null,
      operator: f.properties.operator ?? null,
    },
    path,
  };
}

let cache: Promise<InfrastructureResponse> | null = null;

export async function getInfrastructure(): Promise<InfrastructureResponse> {
  return cache ??= loadInfrastructure(INFRA_DIR);
}

export async function loadInfrastructure(directory: string): Promise<InfrastructureResponse> {
  const files: Record<string, 'point' | 'line'> = {
    'hospitals.geojson': 'point',
    'schools.geojson': 'point',
    'towns.geojson': 'point',
    'power-lines.geojson': 'line',
  };

  const loadedFiles: string[] = [], failedFiles: string[] = [];
  let rejectedFeatures=0;
  const assets: InfrastructureAsset[] = [];
  // A null-prototype object, because the key is an asset id from the fixture: assigning through
  // `__proto__` on a plain literal invokes the inherited accessor, so the entry is never stored as
  // data and every later `powerLinePaths[id]` reads the prototype instead of the path.
  const powerLinePaths: Record<string, LatLon[]> = Object.create(null) as Record<string, LatLon[]>;

  for (const [file, kind] of Object.entries(files)) {
    let parsed: { features?: unknown[] };
    try {
      parsed = JSON.parse(await readFile(path.join(directory, file), 'utf8'));
      if (!parsed || !Array.isArray(parsed.features)) throw new Error('missing features array');
      loadedFiles.push(file);
    } catch (err) {
      console.warn(`[infrastructure] ${file} missing or unreadable, skipping:`, err instanceof Error ? err.message : err);
      failedFiles.push(file);
      continue;
    }
    for (const f of parsed.features ?? []) {
      if (kind === 'point') {
        const asset = toAsset(f as RawPointFeature);
        if (asset) assets.push(asset);
        else rejectedFeatures++;
      } else {
        const res = lineToAsset(f as RawLineFeature);
        if (res) {
          assets.push(res.asset);
          powerLinePaths[res.asset.id] = res.path;
        } else rejectedFeatures++;
      }
    }
  }

  return { assets, powerLinePaths, status: {
    state: loadedFiles.length===0 ? 'unavailable' : failedFiles.length || rejectedFeatures ? 'partial' : 'available',
    loadedFiles, failedFiles, rejectedFeatures,
  }};
}
