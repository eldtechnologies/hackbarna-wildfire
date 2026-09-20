// Situation agent schema, shared by server and client. The server assembles
// a SituationPacket from computed geometry (perimeter, spread, threats) and
// the narrator (LLM or template) only phrases it: every number the client
// renders comes from these fields, never from the model.

import type { InfrastructureCategory, InfrastructureCoverage, ThreatRing } from './threats';

export interface SituationThreat {
  assetId: string;
  name: string;
  category: InfrastructureCategory;
  ring: ThreatRing;
  distanceKm: number;
  inSpreadCorridor: boolean;
}

export interface EvacuationRecommendation {
  assetId: string;
  name: string;
  category: InfrastructureCategory;
  ring: ThreatRing;
  distanceKm: number;
  inSpreadCorridor: boolean;
  reason: string; // computed justification, template-phrased (the LLM only writes the summary)
  priority: 1 | 2 | 3; // 1 = act first (inside perimeter / corridor), 3 = monitor
}

export interface SituationPacket {
  fireId: string;
  fireName: string | null;
  // Data source that fed the packet, so the demo is honest about replay.
  dataProvenance: 'live' | 'replay';
  perimeterAreaKm2: number | null; // null when the fire has no observed perimeter
  perimeterObservedAt: string | null;
  spreadHorizonHours: number; // 0 when there is no projection
  // Direction derived from perimeter-centroid drift toward the furthest
  // projection. The schema has no wind field, so this is the spread heading,
  // not a measured wind. Degrees clockwise from north.
  spreadBearingDeg: number | null;
  spreadCompass: string | null; // 'NE', 'SSW' style 16-point label for spreadBearingDeg
  totalFrpMw: number;
  hotspotCount: number;
  firstDetectedAt: string;
  lastDetectedAt: string;
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
