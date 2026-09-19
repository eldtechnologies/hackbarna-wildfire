// The verification gate: every name in a sentence must resolve, and every road named
// must actually be on the route being recommended.
//
// This is the anti-hallucination story, and it is deterministic — no model is involved,
// so there is nothing to hallucinate. Two checks, both against the committed road graph:
//
//   * `unresolved_name` — the name does not exist in OSM at all
//   * `not_passable`    — the road exists but is not on the recommended route, so naming
//                         it would send someone down a road the model did not choose
//
// A failed candidate is rejected and shown, never dropped quietly. The rejection log is
// the artifact that answers "isn't the LLM going to invent a road?" before anyone asks.

import type { RejectedCandidate, ResolvedName } from '../../../shared/alerts';
import type { RoadGraph } from '../solve';

export interface NameCandidate {
  /** Exactly as it appears in the sentence. */
  text: string;
}

export interface VerificationInput {
  text: string;
  /** Names the sentence contains, in order. */
  names: NameCandidate[];
  /** Segments on the recommended route. A road name must appear here to be passable. */
  routeSegmentIds: string[];
}

export interface OsmMatch {
  type: 'way' | 'node';
  id: string;
  name: string;
}

/** A named place a sentence may refer to, resolved outside the road graph. */
export interface Place {
  id: string;
  name: string;
  lat: number;
  lon: number;
}

/**
 * Look a name up.
 *
 * Two namespaces, because a sentence names two kinds of thing. A *road* must resolve in
 * the road graph and be checked as passable. A *destination* is a settlement, which is
 * not a road at all — resolving it against the graph rejected every candidate until this
 * was split out, and the failure was silent: an empty package list looks exactly like
 * "no alert is needed", which is the most dangerous reading available.
 *
 * Places are checked first so a settlement that shares a name with a road resolves to
 * the settlement, which is what the sentence means.
 */
export function resolveName(name: string, graph: RoadGraph, places: Place[] = []): OsmMatch | null {
  const needle = name.trim().toLowerCase();
  if (needle.length === 0) return null;

  for (const place of places) {
    if (place.name.trim().toLowerCase() === needle) {
      return { type: 'node', id: place.id, name: place.name };
    }
  }

  for (const edge of graph.edges) {
    if (edge.name !== null && edge.name.trim().toLowerCase() === needle) {
      // Edge ids are `way/<osm id>` possibly with a run suffix and `#rev`; the OSM way
      // id is the part that identifies the road.
      const osmId = edge.id.replace(/^way\//, '').replace(/#.*$/, '');
      return { type: 'way', id: osmId, name: edge.name };
    }
  }
  return null;
}

export interface VerificationOutcome {
  resolved: ResolvedName[];
  rejection: { reason: RejectedCandidate['reason']; detail: string } | null;
}

/**
 * Check every name in a sentence, and that any road it names is on the route.
 *
 * Returns the first failure rather than a list, because a sentence with two broken names
 * is one rejected candidate, not two.
 */
export function verifySentence(
  input: VerificationInput,
  graph: RoadGraph,
  places: Place[] = [],
): VerificationOutcome {
  const resolved: ResolvedName[] = [];
  const routeSet = new Set(input.routeSegmentIds);

  for (const candidate of input.names) {
    const osm = resolveName(candidate.text, graph, places);
    resolved.push({ text: candidate.text, osm });
    if (osm === null) {
      return {
        resolved,
        rejection: {
          reason: 'unresolved_name',
          detail: `"${candidate.text}" resolves to neither a settlement nor a named road; the sentence would point at a place that does not exist`,
        },
      };
    }
  }

  // Passability applies to ROADS only. A destination is somewhere to arrive, not
  // something to drive along, so asking whether it is "on the route" is a category error.
  if (input.routeSegmentIds.length > 0) {
    for (const candidate of input.names) {
      const match = resolveName(candidate.text, graph, places);
      if (match === null || match.type !== 'way') continue;
      const onRoute = graph.edges.some(
        (e) => e.name !== null
          && e.name.trim().toLowerCase() === candidate.text.trim().toLowerCase()
          && routeSet.has(e.id),
      );
      if (!onRoute) {
        return {
          resolved,
          rejection: {
            reason: 'not_passable',
            detail: `"${candidate.text}" exists but is not on the recommended route, so naming it would send people down a road the model did not choose`,
          },
        };
      }
    }
  }

  return { resolved, rejection: null };
}
