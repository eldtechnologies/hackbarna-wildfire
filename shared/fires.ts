// Normalized internal schema, shared by server and client. Every provider
// (live Deepfire, replay snapshot) returns data in this shape so the frontend
// never sees raw API formats.

export interface LatLon {
  lat: number;
  lon: number;
}

export interface Hotspot {
  id: string;
  position: LatLon;
  frpMw: number; // fire radiative power, drives marker size and color
  confidence: number; // 0..1
  detectedAt: string; // ISO timestamp
  clusterId: string | null;
}

export interface FireCluster {
  id: string;
  name: string | null;
  centroid: LatLon;
  hotspotIds: string[];
  bbox: [number, number, number, number]; // [west, south, east, north]
  totalFrpMw: number;
  firstDetectedAt: string;
  lastDetectedAt: string;
}

export interface FirePerimeter {
  clusterId: string;
  polygon: LatLon[]; // closed ring, first point repeated at the end
  areaKm2: number;
  observedAt: string;
}

export interface SpreadStep {
  clusterId: string;
  at: string; // ISO timestamp this projection refers to
  horizonHours: number; // hours after the perimeter observation
  polygon: LatLon[];
}

// Timeline metadata for a multi-frame recording. Frames are ISO timestamps
// (the recording's t field) in ascending order. The spread scrubber plays
// back the event as an accelerated timeline: event seconds 0..duration map
// onto frames via /api/fires?at=<seconds>.
export interface ReplayTimeline {
  scenario: string;
  start: string; // ISO timestamp of frame 0
  end: string; // ISO timestamp of the last frame
  durationSeconds: number;
  frames: string[]; // frame timestamps, ascending
}

export interface FiresResponse {
  provenance: 'live' | 'replay';
  fetchedAt: string;
  scenario: string | null; // snapshot id when replaying, null when live
  timeline?: ReplayTimeline; // only set when replaying a multi-frame recording
  hotspots: Hotspot[];
  clusters: FireCluster[];
  perimeters: FirePerimeter[];
  spread: SpreadStep[];
}

export interface FireDataProvider {
  readonly mode: 'live' | 'replay';
  // atSeconds: position in a recorded event timeline. Ignored by live
  // providers, used by recordings to pick the frame at or before that time.
  getFires(atSeconds?: number): Promise<FiresResponse>;
}
