// Normalized infrastructure and threat schema, shared by server and client.

import type { LatLon } from './fires';

export type InfrastructureCategory = 'hospital' | 'school' | 'town' | 'power-line';

export interface InfrastructureAsset {
  id: string;
  name: string;
  category: InfrastructureCategory;
  position: LatLon;
  municipality: string | null;
  county: string | null;
  voltageKv: number | null; // power lines only
  operator: string | null; // power lines only
}

// Bundled infrastructure served by /api/infrastructure. Power lines are
// included as assets whose position is the midpoint of their path, so the
// client renders them as one marker per line plus the raw path for drawing.
export interface InfrastructureStatus {
  state: 'available' | 'partial' | 'unavailable';
  loadedFiles: string[];
  failedFiles: string[];
  rejectedFeatures: number;
}

export interface InfrastructureResponse {
  status: InfrastructureStatus;
  assets: InfrastructureAsset[];
  powerLinePaths: Record<string, LatLon[]>; // assetId -> path
}

export type ThreatRing = 'inside' | 'ring-5km' | 'ring-10km' | 'ring-20km';

export interface ThreatenedAsset {
  assetId: string;
  name: string;
  category: InfrastructureCategory;
  ring: ThreatRing; // smallest ring containing the asset
  distanceKm: number; // 0 when inside the perimeter, rounded to 0.1
  inSpreadCorridor: boolean;
}

export interface ThreatsResponse {
  infrastructureStatus: InfrastructureStatus;
  infrastructureCoverage: InfrastructureCoverage | null;
  fireId: string;
  hasPerimeter: boolean; // false: rings surround a synthetic 50 m detection-centroid disc
  rings: { ring: ThreatRing; radiusKm: number | null }[]; // display order
  threatened: ThreatenedAsset[]; // sorted: innermost ring first, then distance
  corridorCount: number; // assets flagged inSpreadCorridor
  computedAt: string;
}

// Shared vocabulary so ring severity and category labels live in one place.

export const RING_RADII_KM: { ring: ThreatRing; radiusKm: number }[] = [
  { ring: 'ring-5km', radiusKm: 5 },
  { ring: 'ring-10km', radiusKm: 10 },
  { ring: 'ring-20km', radiusKm: 20 },
];

export const RING_SEVERITY: Record<ThreatRing, number> = {
  inside: 0,
  'ring-5km': 1,
  'ring-10km': 2,
  'ring-20km': 3,
};

export const CATEGORY_LABEL: Record<InfrastructureCategory, string> = {
  hospital: 'hospital',
  town: 'town',
  school: 'school',
  'power-line': 'power line',
};

// Where the bundled infrastructure data exists. Fires outside this area get
// no threat hits because there is no data there, not because the area is
// safe; the situation agent uses this to qualify an empty threat list.
export interface InfrastructureCoverage {
  label: string;
  bbox: [number, number, number, number]; // [west, south, east, north] degrees
  note?: string; // source/date limitations carried into reports
}
