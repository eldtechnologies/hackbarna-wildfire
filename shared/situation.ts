// Situation agent schema, shared by server and client. The server assembles
// a SituationPacket from computed geometry (perimeter, spread, threats) and
// the model only orders server-rendered facts: every number the client
// renders comes from these fields, never from the model.

import type { InfrastructureCategory, InfrastructureCoverage, InfrastructureStatus, ThreatRing } from './threats';

export interface SituationThreat {
  assetId: string;
  name: string;
  category: InfrastructureCategory;
  ring: ThreatRing;
  distanceKm: number;
  inSpreadCorridor: boolean;
}

export interface EvacuationRecommendation extends SituationThreat {
  reason: string; // computed justification, template-phrased (the LLM only orders summary facts)
  priority: 1 | 2 | 3; // relative screening rank, not an evacuation instruction
}

export interface SituationPacket {
  infrastructureStatus: InfrastructureStatus;
  evidenceAsOf: string | null;
  availabilityPolicy: string | null;
  fireId: string;
  fireName: string | null;
  // Data source that fed the packet, so the demo is honest about replay.
  dataProvenance: 'live' | 'replay';
  hasPerimeter: boolean; // false means screening uses a 50 m detection-centroid disc
  perimeterAreaKm2: number | null; // null when the fire has no observed perimeter
  perimeterObservedAt: string | null;
  spreadHorizonHours: number; // 0 when there is no projection
  // Direction derived from perimeter-centroid drift toward the furthest
  // projection. The schema has no wind field, so this is the spread heading,
  // not a measured wind. Degrees clockwise from north.
  spreadBearingDeg: number | null;
  spreadCompass: string | null; // 'NE', 'SSW' style 16-point label for spreadBearingDeg
  totalFrpMw: number | null; // null when no hotspot carries a measured FRP
  hotspotCount: number;
  firstDetectedAt: string | null;
  lastDetectedAt: string | null;
  threats: SituationThreat[];
  corridorCount: number;
  // Whether the fire sits inside the region the bundled infrastructure data
  // covers. When false, an empty threat list means no data there, not that
  // nothing is at risk; both narrators and the panel qualify on this.
  infrastructureCoverage: InfrastructureCoverage | null;
  computedAt: string;
}

export type SituationNarrator = 'llm' | 'template';

export interface SituationResponse {
  fireId: string;
  summary: string; // plain-language situation summary
  recommendations: EvacuationRecommendation[]; // sorted, most urgent first
  narrator: SituationNarrator;
  packet: SituationPacket; // the authoritative figures the prose narrates
}
