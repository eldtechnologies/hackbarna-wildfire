// Alert contracts: the package a coordinator would send, the rejections behind it,
// and the ledger that records both. Draft for the H0-4 freeze — see docs/work-plan.md.
//
// The instruction is *selected* from a closed set, never written. `InstructionId` is
// closed for that reason: it is the set of pre-approved phrasings, and a candidate
// that cannot be tied to a real OSM feature is rejected rather than shipped.

import type { LatLon } from './fires';
import type { TimeBand } from './egress';

/** The approved instruction set. A sentence is chosen from these, never generated. */
export type InstructionId =
  | 'evacuate_primary'
  | 'evacuate_alternate'
  | 'no_verified_action'
  | 'no_action';

export type LanguageCode = 'es' | 'en' | 'ca';

/** A name in the message text, and what it resolved to. */
export interface ResolvedName {
  /** The name exactly as it appears in the sentence. */
  text: string;
  /** Null when the name did not resolve — which is why the candidate is rejected. */
  osm: { type: 'way' | 'node'; id: string; name: string } | null;
}

/** CAP 1.2 emission settings. Defaults are a fictional sender with status=Test. */
export interface CapSenderConfig {
  /** Configurable so a real 112 centre could set its own; we default to a demo value. */
  sender: string;
  senderName: string;
  status: 'Actual' | 'Exercise' | 'System' | 'Test' | 'Draft';
  scope: 'Public' | 'Restricted' | 'Private';
}

export interface AlertPackage {
  id: string;
  pocketId: string;
  pocketName: string;
  /** The cursor this package was built for. */
  at: string;
  instruction: InstructionId;
  language: LanguageCode;
  /** Exactly the sentence that would be sent. */
  text: string;
  /** Every road and place name in `text`, and what it resolved to. */
  resolvedNames: ResolvedName[];
  /** CAP fields, all closed enums. */
  urgency: 'Immediate' | 'Expected' | 'Future' | 'Past' | 'Unknown';
  severity: 'Extreme' | 'Severe' | 'Moderate' | 'Minor' | 'Unknown';
  certainty: 'Observed' | 'Likely' | 'Possible' | 'Unlikely' | 'Unknown';
  /** Pocket polygon, as a closed ring. */
  area: LatLon[];
  /** The departure band this package was built from. Null when no action is advised. */
  departure: TimeBand | null;
}

/** A candidate sentence that failed verification. Shown, never hidden. */
export interface RejectedCandidate {
  at: string;
  pocketId: string;
  instruction: InstructionId;
  language: LanguageCode;
  text: string;
  reason: 'unresolved_name' | 'not_passable' | 'no_evidence';
  detail: string;
}

/** One recommendation, its evidence, and when it was made. */
export interface LedgerEntry {
  id: string;
  /** Cursor time the recommendation applies to. */
  at: string;
  /** Wall-clock time it was computed. */
  recordedAt: string;
  pocketId: string;
  recommendation: InstructionId;
  /** Human-readable evidence lines, citing detections and cut times. */
  evidence: string[];
  inputs: Record<string, string | number>;
  rejected: RejectedCandidate[];
}

export interface AlertsResponse {
  provenance: 'live' | 'replay';
  at: string;
  cap: CapSenderConfig;
  packages: AlertPackage[];
  rejected: RejectedCandidate[];
}
