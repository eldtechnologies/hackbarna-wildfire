// Loads the bundled infrastructure GeoJSON (data/infrastructure/, generated
// by scripts/fetch-infrastructure.mjs) and normalizes it into the shared
// schema. Read once at startup; the files are committed so this never needs
// network access.

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type {
  InfrastructureAsset,
  InfrastructureResponse,
} from '../shared/threats';
import type { LatLon } from '../shared/fires';

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

let cache: InfrastructureResponse | null = null;

export async function getInfrastructure(): Promise<InfrastructureResponse> {
  if (cache) return cache;

  const files: Record<string, 'point' | 'line'> = {
    'hospitals.geojson': 'point',
    'schools.geojson': 'point',
    'towns.geojson': 'point',
    'power-lines.geojson': 'line',
  };

  const assets: InfrastructureAsset[] = [];
  // A null-prototype object, because the key is an asset id from the fixture: assigning through
  // `__proto__` on a plain literal invokes the inherited accessor, so the entry is never stored as
  // data and every later `powerLinePaths[id]` reads the prototype instead of the path.
  const powerLinePaths: Record<string, LatLon[]> = Object.create(null) as Record<string, LatLon[]>;

  for (const [file, kind] of Object.entries(files)) {
    let parsed: { features?: unknown[] };
    try {
      parsed = JSON.parse(await readFile(path.join(INFRA_DIR, file), 'utf8'));
    } catch (err) {
      console.warn(`[infrastructure] ${file} missing or unreadable, skipping:`, err instanceof Error ? err.message : err);
      continue;
    }
    for (const f of parsed.features ?? []) {
      if (kind === 'point') {
        const asset = toAsset(f as RawPointFeature);
        if (asset) assets.push(asset);
      } else {
        const res = lineToAsset(f as RawLineFeature);
        if (res) {
          assets.push(res.asset);
          powerLinePaths[res.asset.id] = res.path;
        }
      }
    }
  }

  cache = { assets, powerLinePaths };
  return cache;
}
