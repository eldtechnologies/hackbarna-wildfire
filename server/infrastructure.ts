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

function toAsset(f: RawPointFeature): InfrastructureAsset | null {
  const [lon, lat] = f.geometry.coordinates;
  if (!f.properties?.id || !f.properties.name || !Number.isFinite(lat) || !Number.isFinite(lon)) {
    return null;
  }
  return {
    id: f.properties.id,
    name: f.properties.name,
    category: f.properties.category as InfrastructureAsset['category'],
    position: { lat, lon },
    municipality: f.properties.municipality ?? null,
    county: f.properties.county ?? null,
    voltageKv: null,
    operator: null,
  };
}

function lineToAsset(f: RawLineFeature): { asset: InfrastructureAsset; path: LatLon[] } | null {
  const coords = f.geometry.coordinates;
  if (!f.properties?.id || coords.length < 2) return null;
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
  const powerLinePaths: Record<string, LatLon[]> = {};

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
