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
  population: number | null; // towns only, display only (not simulated)
  voltageKv: number | null; // power lines only
  operator: string | null; // power lines only
}

// Bundled infrastructure served by /api/infrastructure. Power lines are
// included as assets whose position is the midpoint of their path, so the
// client renders them as one marker per line plus the raw path for drawing.
export interface InfrastructureResponse {
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
  fireId: string;
  hasPerimeter: boolean;
  rings: { ring: ThreatRing; radiusKm: number | null }[]; // display order
  threatened: ThreatenedAsset[]; // sorted: innermost ring first, then distance
  corridorCount: number; // assets flagged inSpreadCorridor
  computedAt: string;
}
