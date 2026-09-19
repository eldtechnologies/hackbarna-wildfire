// Turn an egress solve into the package a coordinator could send.
//
// The geometry decides the situation; the sentence is then selected from a closed set,
// never written. Everything in this file is arithmetic, lookup and string substitution,
// which is the point: there is no generative step to hallucinate a road name.
//
// The rejection log is a feature, not an error path. A candidate that names a road OSM
// does not have, or one that is not on the recommended route, is discarded and shown —
// and that log is the artifact that answers the first question anyone asks.

import type {
  AlertPackage,
  AlertsResponse,
  CapSenderConfig,
  InstructionId,
  LedgerEntry,
  RejectedCandidate,
} from '../../shared/alerts';
import type { LatLon } from '../../shared/fires';
import { buildEgress, loadContext, type EgressOptions, type Settlement } from './egress';
import { capIdentifier, emitCap, groupByPocket, validateCapSemantics } from './cap/emit';
import { fillTemplate, languagesFor, templateFor, unresolvedPlaceholders } from './cap/templates';
import { verifySentence, type Place } from './cap/verify';
import { loadPocketGeometry } from './pockets';
import { NOMINAL_ID } from './sweep';
import { nearestNode } from './graph';
import type { RoadGraph } from './solve';

/**
 * Default sender: a fictional demo identity with status=Test, so nothing emitted here can
 * be mistaken for a real alert. Scope is Public because ES-Alert is a public cell
 * broadcast; `status` carries the "not real" flag instead.
 */
export const DEFAULT_SENDER: CapSenderConfig = {
  sender: 'demo@ojo-de-fuego.invalid',
  senderName: 'Ojo de Fuego (demo)',
  status: 'Test',
  scope: 'Public',
};

export interface BuildAlertsResult {
  response: AlertsResponse;
  /** One CAP document per pocket, keyed by pocket id. */
  documents: Map<string, string>;
  ledger: LedgerEntry[];
  diagnostics: {
    emitter: {
      identifierSeed: string;
      accepted: number;
      rejected: number;
      validation: Record<string, ReturnType<typeof validateCapSemantics>>;
    };
  };
}

/**
 * Which approved instruction fits this pocket's situation.
 *
 * The mapping is deliberately blunt. `no_verified_action` is the default whenever no
 * route survives, and it is NOT shelter-in-place: failing to find a route does not show
 * that staying is survivable, so the honest output is "the operator must decide".
 */
export function instructionFor(
  route: { slowestHighway: string; lastSafeDeparture: { earliest: string } | null } | null,
  cursorMs: number,
): InstructionId {
  if (route === null || route.lastSafeDeparture === null) return 'no_verified_action';

  // If the pessimistic end of the band has already passed, there is no longer a
  // verified action, and the sentence must say the same thing the pocket verdict does.
  // Without this the two disagree: the verdict gates on the pessimistic end while the
  // message looked only at whether a band existed, so the engine could report
  // `no_verified_action` for the pocket and simultaneously tell people to drive out.
  const pessimistic = Date.parse(route.lastSafeDeparture.earliest);
  if (Number.isFinite(pessimistic) && pessimistic < cursorMs) return 'no_verified_action';

  // A route that only exists because a track is in the graph is the case the spike
  // describes: the main road is not safe and the way out is a track. Naming that route
  // as the primary one would repeat the failure the product exists to prevent.
  if (route.slowestHighway === 'track' || route.slowestHighway === 'service') {
    return 'evacuate_alternate';
  }
  return 'evacuate_primary';
}

/** How wide the out-of-band is, and therefore how sure the message can be. */
function certaintyFor(band: { earliest: string; latest: string | null } | null): AlertPackage['certainty'] {
  if (band === null) return 'Observed';
  if (band.latest === null) return 'Possible';
  const widthHours = (Date.parse(band.latest) - Date.parse(band.earliest)) / 3_600_000;
  if (widthHours <= 2) return 'Likely';
  return 'Possible';
}

/**
 * CAP severity describes the HAZARD, not our confidence and not how hard the decision was.
 *
 * Mapping it off the instruction instead — "we could not route them, so Extreme" — reads
 * plausibly and gets the semantics wrong: it reports our own uncertainty as the fire's
 * severity, and it inflates the hazard exactly when the fire may be least threatening to
 * that particular pocket. Certainty is the field for how sure we are, and it is set from
 * the band above.
 *
 * Measured off the mask: a pocket the fire reaches within the window is Extreme, one it
 * does not is Severe. With no node field available the hazard is assumed real, because
 * under-reporting severity is the direction that gets people killed.
 */
function severityFor(fireReaches: boolean): AlertPackage['severity'] {
  return fireReaches ? 'Extreme' : 'Severe';
}

export interface AlertsOptions extends EgressOptions {
  sender?: CapSenderConfig;
  /** Pockets to emit for. Defaults to the egress pockets. */
  pocketIds?: string[];
}

export function buildAlerts(options: AlertsOptions = {}): BuildAlertsResult {
  const built = buildEgress(options);
  const sender = options.sender ?? DEFAULT_SENDER;
  const atMs = Date.parse(built.response.at);
  const clock = built.response.assumptions;

  // The name checks run against the same road data the route was built from, not a
  // re-read of it, so a name and its geometry cannot come from different versions.
  const context = loadContext(options.graphPath);
  const graph = context.graph;
  // Settlements are the places a sentence may name as a destination. They resolve
  // outside the road graph because a village is not a road.
  const places: Place[] = context.settlements.map((s) => ({
    id: s.id, name: s.name, lat: s.lat, lon: s.lon,
  }));
  const nodeCut = context.sweep.nodeCutByConfig.get(NOMINAL_ID);

  const packages: AlertPackage[] = [];
  const rejected: RejectedCandidate[] = [];
  const ledger: LedgerEntry[] = [];
  const byPocket = new Map<string, Settlement>();

  for (const pocketEgress of built.response.pockets) {
    const settlement = settlementFor(pocketEgress.pocketId, options.graphPath);
    if (!settlement) continue;
    byPocket.set(pocketEgress.pocketId, settlement);

    // The route the message is about: the one with the latest pessimistic departure.
    const usable = pocketEgress.routes
      .filter((r) => r.lastSafeDeparture !== null)
      .sort((a, b) => Date.parse(b.lastSafeDeparture!.earliest) - Date.parse(a.lastSafeDeparture!.earliest));
    const chosen = usable[0] ?? null;
    const instruction = instructionFor(chosen, atMs);
    const template = templateFor(instruction);

    const values = {
      pocket: settlement.name,
      road: roadNameOf(chosen, graph),
      destination: chosen?.destination ?? '',
    };

    // Severity is read off the mask, once per pocket: does the fire reach this village
    // within the modelled window at all?
    const pocketNode = nearestNode(graph, { lat: settlement.lat, lon: settlement.lon });
    const fireReaches =
      pocketNode === null || nodeCut === undefined ? true : Number.isFinite(nodeCut[pocketNode]);

    for (const language of languagesFor(settlement)) {
      const text = fillTemplate(template, language, values);

      // A sentence that still holds a placeholder has a missing value, which is a bug in
      // the caller rather than bad data; rejecting it keeps the invariant that what
      // ships is always a complete, approved sentence.
      const leftover = unresolvedPlaceholders(text);
      if (leftover.length > 0) {
        rejected.push({
          at: built.response.at, pocketId: settlement.id, instruction, language, text,
          reason: 'no_evidence',
          detail: `template left ${leftover.join(', ')} unfilled`,
        });
        continue;
      }

      const names = template.namesRoad
        ? [{ text: values.road }, { text: values.destination }].filter((n) => n.text.length > 0)
        : [];
      const outcome = verifySentence(
        { text, names, routeSegmentIds: chosen?.segmentIds ?? [] },
        graph,
        places,
      );
      if (outcome.rejection) {
        rejected.push({
          at: built.response.at, pocketId: settlement.id, instruction, language, text,
          reason: outcome.rejection.reason, detail: outcome.rejection.detail,
        });
        continue;
      }

      packages.push({
        id: capIdentifier(settlement.id, built.response.at, instruction),
        pocketId: settlement.id,
        pocketName: settlement.name,
        at: built.response.at,
        instruction,
        language,
        text,
        resolvedNames: outcome.resolved,
        urgency: template.urgency,
        severity: severityFor(fireReaches),
        certainty: certaintyFor(chosen?.lastSafeDeparture ?? null),
        area: settlementArea(settlement),
        departure: chosen?.lastSafeDeparture ?? null,
      });
    }

    ledger.push({
      id: `ledger-${settlement.id}-${built.response.at}`,
      at: built.response.at,
      recordedAt: new Date().toISOString(),
      pocketId: settlement.id,
      recommendation: instruction,
      evidence: [
        chosen
          ? `recommended ${chosen.destination}: ${chosen.distanceKm} km, ${chosen.travelMinutes} min, worst road ${chosen.slowestHighway}`
          : 'no route survived the sweep',
        `departure band ${chosen?.lastSafeDeparture ? `${chosen.lastSafeDeparture.earliest} .. ${chosen.lastSafeDeparture.latest ?? 'never closes'}` : 'none'}`,
        chosen?.lastSafeDeparture ? `basis: ${chosen.lastSafeDeparture.basis}` : 'basis: n/a',
        `detections ${built.diagnostics.detections}; persistent-heat polygons ${built.diagnostics.staticHeat.polygons}, detections removed ${built.diagnostics.staticHeat.removed}`,
      ],
      inputs: {
        mobileFraction: clock.mobileFraction,
        vehicleOccupancy: clock.vehicleOccupancy,
        departureDelayMinutes: clock.departureDelayMinutes,
        population: settlement.population ?? 'unknown',
        clearanceMinutes: chosen?.clearanceMinutes ?? 'unknown',
      },
      rejected: [],
    });
  }

  // Rejections are per pocket, so they are attached to the ledger entry that produced them.
  for (const entry of ledger) {
    entry.rejected = rejected.filter((r) => r.pocketId === entry.pocketId);
  }

  // CAP is one <alert> per pocket, one <info> per language; a multi-pocket send is
  // several documents, because <alert> is the document root.
  const documents = new Map<string, string>();
  const validation: Record<string, ReturnType<typeof validateCapSemantics>> = {};
  for (const [pocketId, pocketPackages] of groupByPocket(packages)) {
    const settlement = byPocket.get(pocketId);
    if (!settlement) continue;
    const first = pocketPackages[0];
    const input = {
      identifier: capIdentifier(pocketId, first.at, first.instruction),
      sender,
      sentMs: atMs,
      source: `ojo-de-fuego replay ${built.diagnostics.scenario}`,
      packages: pocketPackages,
      area: settlementArea(settlement),
      eventName: 'Incendio forestal / Wildfire',
    };
    const xml = emitCap(input);
    documents.set(pocketId, xml);
    validation[pocketId] = validateCapSemantics(input, xml);
  }

  return {
    response: {
      provenance: built.response.provenance,
      at: built.response.at,
      cap: sender,
      packages,
      rejected,
    },
    documents,
    ledger,
    diagnostics: {
      emitter: {
        identifierSeed: built.response.fireId ?? 'unknown',
        accepted: packages.length,
        rejected: rejected.length,
        validation,
      },
    },
  };
}

/**
 * The road named in the sentence: the named road carrying the most of the route.
 *
 * Taken from the route the model actually selected, so the name and the geometry cannot
 * disagree — which is what makes the passability check meaningful rather than circular.
 *
 * Longest rather than first, because the first named edge out of a village is a street:
 * taking it produced "leave via Calle Llanos", which is true and useless to someone
 * standing in Bédar. The road they will recognise is the one they spend the journey on.
 */
function roadNameOf(route: { segmentIds: string[] } | null, graph: RoadGraph): string {
  if (route === null) return '';
  const byId = new Map(graph.edges.map((e) => [e.id, e]));
  const byName = new Map<string, number>();
  for (const id of route.segmentIds) {
    const edge = byId.get(id);
    if (!edge?.name) continue;
    // Travel time rather than geometry length: it is already computed, and it weights
    // the slow mountain road the same way the drive does.
    byName.set(edge.name, (byName.get(edge.name) ?? 0) + edge.travelSeconds);
  }
  let best = '';
  let bestSeconds = -1;
  for (const [name, seconds] of byName) {
    if (seconds > bestSeconds) {
      bestSeconds = seconds;
      best = name;
    }
  }
  return best;
}

/**
 * The pocket outline.
 *
 * The hull of the settlement's buildings when the Catastro fixture is present, which is
 * what defines where the pocket actually is. Failing that, a 400 m box about the village
 * point — a placeholder that will draw a square over whatever happens to be nearby, and
 * which is reported as a placeholder rather than passed off as the pocket's extent.
 */
function settlementArea(settlement: Settlement): LatLon[] {
  const geometry = loadPocketGeometry().get(settlement.id);
  if (geometry && geometry.outline.length >= 4) return geometry.outline;
  const d = 0.004;
  return [
    { lat: settlement.lat - d, lon: settlement.lon - d },
    { lat: settlement.lat - d, lon: settlement.lon + d },
    { lat: settlement.lat + d, lon: settlement.lon + d },
    { lat: settlement.lat + d, lon: settlement.lon - d },
    { lat: settlement.lat - d, lon: settlement.lon - d },
  ];
}

function settlementFor(pocketId: string, graphPath?: string): Settlement | undefined {
  return loadContext(graphPath).settlements.find((s) => s.id === pocketId);
}
