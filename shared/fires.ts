// Normalized internal schema, shared by server and client. Every provider
// (live Deepfire, replay snapshot) returns data in this shape so the frontend
// never sees raw API formats.
//
// ONE RULE, applied everywhere below: a quantity the source did not supply is
// null. Nothing is synthesised into a plausible number. A null FRP is "not
// measured"; a 0 is "measured zero". The same holds for area, confidence and
// timestamps. A consumer that needs a number must decide what a missing one
// means for its own feature; the schema refuses to decide for it.

export interface LatLon {
  lat: number;
  lon: number;
}

export interface Hotspot {
  id: string;
  position: LatLon;
  frpMw: number | null; // MW; null when the sensor reported none
  confidence: number | null; // 0..1; null when the word was missing or unrecognised
  detectedAt: string | null; // ISO timestamp; null when the source omitted it
  satellite: string | null; // source satellite, e.g. 'MTG_I1'; null when omitted
  clusterId: string | null;
}

export interface FireCluster {
  id: string;
  name: string | null;
  centroid: LatLon;
  hotspotIds: string[];
  bbox: [number, number, number, number]; // [west, south, east, north]
  totalFrpMw: number | null; // null when no member has a measured FRP
  firstDetectedAt: string | null;
  lastDetectedAt: string | null;
}

export interface FirePerimeter {
  clusterId: string | null; // null when the source omitted cluster_id
  polygon: LatLon[]; // closed ring: >=4 positions, first point repeated at the end
  areaKm2: number | null; // null when the source reported no area
  observedAt: string | null;
  // A MultiPolygon perimeter is emitted as one record per part. `areaKm2` is the
  // parent feature's total and is repeated on every part, so a consumer that sums
  // area must count each (clusterId, partCount) feature once, not each record.
  partIndex: number;
  partCount: number;
}

export interface SpreadStep {
  clusterId: string;
  at: string; // ISO timestamp this projection refers to
  horizonHours: number; // hours after the perimeter observation
  polygon: LatLon[];
}

// Timeline metadata for recordings or historical captures. Frames are ISO
// timestamps of captured frames or evidence availability. The scrubber plays
// back the event as an accelerated timeline: event seconds 0..duration map
// onto frames via /api/fires?at=<seconds>.
export interface ReplayTimeline {
  scenario: string;
  start: string; // ISO timestamp of frame 0
  end: string; // ISO timestamp of the last frame
  durationSeconds: number;
  frames: string[]; // frame timestamps, ascending
}

export type FireSource = 'live' | 'replay' | 'drill' | 'configured';
export type FireDataKind = 'observations' | 'exercise';

export interface FiresResponse {
  source?: FireSource;
  requestedSource?: FireSource;
  dataKind?: FireDataKind;
  fallbackReason?: 'live_unavailable';
  provenance: 'live' | 'replay';
  fetchedAt: string;
  scenario: string | null; // snapshot id when replaying, null when live
  /** Evidence issue time; fetchedAt remains the HTTP fetch time. */
  asOf?: string;
  availability?: {
    policy: string;
    deliveryTimes: 'assumed_unless_recorded';
    clusterAssociation: 'retrospective';
    perimeterAvailability: 'computed_at_lower_bound';
  };
  timeline?: ReplayTimeline;
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
