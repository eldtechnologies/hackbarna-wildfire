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
import { ASSUMPTION_PROFILES } from './assumptions';
import { LEDGER_PATH } from '../config';
import { findEntry, fingerprintInputs, ledgerName, openLedger, type LedgerStore, type StoredEntry } from './ledger';
import { PESSIMISTIC_DELAY_MINUTES, buildEgress, loadContext, type EgressOptions, type Settlement } from './egress';
import { capIdentifier, emitCap, groupByPocket, validateCapSemantics } from './cap/emit';
import { fillTemplate, languagesFor, templateFor, unresolvedPlaceholders } from './cap/templates';
import { verifySentence, type Place } from './cap/verify';
import { loadPocketGeometry } from './pockets';
import { NOMINAL_ID } from './sweep';
import { nearestNode } from './graph';
import { edgesById, type RoadGraph } from './solve';

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
    /**
     * What the durable ledger did with this request. Published because the two failure
     * modes that matter are both invisible from the response otherwise: an entry that could
     * not be written (the record silently lost a decision), and lines that could not be read
     * (the history is shorter than it looks).
     */
    ledger: {
      /** The store's name, without its directory. See `ledgerName`. */
      store: string;
      /** Entries this request wrote. Not attempts — a failed write is not counted here. */
      appended: number;
      reused: number;
      unreadable: number;
      /** Pockets whose recommendation this request computed but could not record. */
      writeFailures: string[];
      /** Pockets with nothing to record: their only candidate was rejected before composition. */
      skipped: string[];
      /** True once the store has reached its cap and stopped accepting entries. */
      full: boolean;
      /** Why the store could not be read, or null. The response still serves when this is set. */
      unavailable: string | null;
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
  route: { slowestHighway: string; lastSafeDeparture: { earliest: string } | null; usable?: boolean } | null,
  cursorMs: number,
  fireReachesPocket = true,
): InstructionId {
  // A pocket the fire never reaches within the modelled window needs no action, and
  // saying so is a different statement from "we could not find you a route". Without
  // this the only outputs were an evacuation or a failure, so a safe pocket would have
  // been told to evacuate or told nothing useful.
  if (!fireReachesPocket) return 'no_action';

  // The route's own gate decides, not a re-derivation here. Any second opinion is a
  // chance for the message and the verdict to disagree.
  if (route === null || route.lastSafeDeparture === null) return 'no_verified_action';
  if (route.usable === false) return 'no_verified_action';

  // Kept as a backstop for callers that pass a hand-built route without the flag: if the
  // pessimistic end has passed, there is no verified action.
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

/**
 * CAP certainty is our confidence in what the message says, so it tracks the width of
 * the departure band.
 *
 * The null case used to return 'Observed' — CAP's most confident value — for the
 * situation where no route could be verified at all, which is the least confident thing
 * the engine ever says. The band's absence is a failure to establish a route, not an
 * observation of one, and the mask it is derived from is itself an inference from
 * satellite detections rather than a measurement of the fire's edge.
 */
export function certaintyFor(
  band: { earliest: string; latest: string | null } | null,
  windowEndIso?: string,
): AlertPackage['certainty'] {
  if (band === null) return 'Possible';
  if (band.latest === null) {
    // A null upper end means AT LEAST ONE configuration never closes the route, not that
    // none does. Reading it as "never cut" put the strongest value on the widest possible
    // band: all four published routes carry `latest: null` only because `all-100m` — the
    // most fragile configuration, single flat 100 m buffer — never closes them, while the
    // other eleven give departures around 17:36. The band spans [17:36, never).
    //
    // It is only unanimous when the pessimistic end is itself unbounded, which is what
    // `buildEgress` pins to the window end when no configuration closes the route. Then
    // every assumption agrees and 'Likely' is earned. Otherwise the band is unbounded and
    // the function's own width rule already says what an unbounded width is.
    const unanimous = windowEndIso !== undefined && band.earliest === windowEndIso;
    return unanimous ? 'Likely' : 'Possible';
  }
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
export function severityFor(fireReaches: boolean): AlertPackage['severity'] {
  return fireReaches ? 'Extreme' : 'Severe';
}

export interface AlertsOptions extends EgressOptions {
  /** Where the durable ledger lives. Defaults to the configured path. */
  ledgerPath?: string;
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

  // The ledger's key: which cursor, and which inputs produced the answer for it. A cursor
  // alone is not enough — the same instant means something different under a different
  // capture or different assumption values, and serving the old entry would be a stale
  // recommendation presented as the recorded one.
  const originSeconds = Date.parse(built.diagnostics.originIso) / 1000;
  const cursorSeconds = Math.round(atMs / 1000 - originSeconds);
  const inputFingerprint = fingerprintInputs({
    origin: built.diagnostics.originIso,
    windowEnd: built.diagnostics.windowEnd,
    detections: built.diagnostics.detections,
    scenario: built.diagnostics.scenario,
    // Every source the answer is computed from, by content rather than by path or by count. A
    // path survives the re-import that changes the file and a count survives a re-export that
    // changes the geometry, so neither identifies the input it is standing in for.
    graph: context.graphHash,
    capture: context.captureHash,
    heatFixture: context.heatFixtureHash,
    profiles: built.response.profiles.map((profile) => [profile.id, profile.assumptions]),
    // Name and coordinates, not just the id. The coordinates pick the pocket's node in the graph
    // and every destination node, and the name is the village the sentence says — so a corrected
    // settlement fixture changes the answer while leaving an id-keyed tuple exactly where it was.
    pockets: context.settlements.map((s) => [s.id, s.name, s.lat, s.lon, s.population, s.buildings]),
  });
  const ledgerPath = options.ledgerPath ?? LEDGER_PATH;
  // A store that cannot be read must not take these routes down with it. The write path was built
  // on that contract — the request still serves, and the failure is reported rather than thrown —
  // and the read side owes the same: the response goes out without its history and says so, rather
  // than answering 502 on the two endpoints that exist to tell people to leave. Measured before
  // this: a store at mode 000, and a symlinked path, each turned `/api/alerts` and `/api/cap/:id`
  // into a generic 502 with the actual reason only in the server log.
  //
  // `server/index.ts` opens the store at startup as well, so a misconfigured `LEDGER_PATH` refuses
  // the boot with the path named. This catches a store that becomes unusable while the server runs.
  let ledgerStore: LedgerStore | null = null;
  let history: { entries: StoredEntry[]; unreadable: number } = { entries: [], unreadable: 0 };
  let ledgerUnavailable: string | null = null;
  try {
    ledgerStore = openLedger(ledgerPath);
    // Read once for the whole request. The lookup runs per settlement, and going back to the store
    // for each would re-read and re-parse the file once per village. `unreadable` is taken here
    // too: this request's own appends write well-formed lines, so it cannot have changed by the
    // time the diagnostics are assembled.
    history = ledgerStore.history();
  } catch (err) {
    ledgerUnavailable = err instanceof Error ? err.message : String(err);
    console.error(`[api] the recommendation ledger is unusable; serving without its history: ${ledgerUnavailable}`);
  }
  // Settlements are the places a sentence may name as a destination. They resolve
  // outside the road graph because a village is not a road.
  const places: Place[] = context.settlements.map((s) => ({
    id: s.id, name: s.name, lat: s.lat, lon: s.lon,
  }));
  const nodeCut = context.sweep.nodeCutByConfig.get(NOMINAL_ID);

  const packages: AlertPackage[] = [];
  const rejected: RejectedCandidate[] = [];
  const ledger: LedgerEntry[] = [];
  let appended = 0;
  let reused = 0;
  const writeFailures: string[] = [];
  /**
   * Pockets this request had nothing to record for, because its only candidate was rejected
   * before a sentence could be composed.
   *
   * Its own list rather than a `writeFailures` entry, because the two are different facts and a
   * reader acts on them differently: a failed write is a fault, and no candidate surviving
   * verification is the pipeline working. It also has to be visible at all — the rejected candidate
   * `continue`s past the ledger block, so without this the pocket appears in `response.pockets`
   * and nowhere in the ledger's diagnostics, and `appended + reused` cannot be reconciled against
   * the pockets the response was computed for.
   */
  const skipped: string[] = [];
  let ledgerFull = false;
  const byPocket = new Map<string, Settlement>();

  for (const pocketEgress of built.response.pockets) {
    const settlement = settlementFor(pocketEgress.pocketId, options.graphPath);
    if (!settlement) continue;
    byPocket.set(pocketEgress.pocketId, settlement);

    // The route the message is about: among those the pocket verdict accepts, the one
    // with the latest pessimistic departure.
    //
    // Filtering on the engine's own `usable` flag rather than re-deriving it here. The
    // two used to be computed separately and disagreed: the verdict withdraws a route
    // when its band, minus clearance and delay, has passed, while this file only checked
    // the band — so for a window as long as the clearance there could be a CAP sentence
    // telling people to leave for a pocket the same response marked `no_verified_action`.
    // A pocket the engine has no observation for has no route to recommend, whatever its
    // bands say. Before anything had arrived the bands were unbounded and every route
    // passed the gate, so this used to compose an evacuation sentence naming a real road,
    // out of no data at all. The verdict is the engine's statement about that, and it is
    // read here rather than re-derived.
    const usableRoutes = (pocketEgress.verdict === 'not_yet_observed' ? [] : pocketEgress.routes)
      .filter((r) => r.usable)
      .sort((a, b) => Date.parse(b.lastSafeDeparture!.earliest) - Date.parse(a.lastSafeDeparture!.earliest));
    const chosen = usableRoutes[0] ?? null;

    // Read off the mask, once per pocket: does the fire reach this village within the
    // modelled window at all? It drives both the instruction and the severity.
    const pocketNode = nearestNode(graph, { lat: settlement.lat, lon: settlement.lon });
    const fireReaches =
      pocketNode === null || nodeCut === undefined ? true : Number.isFinite(nodeCut[pocketNode]);

    // `fireReaches` is a whole-window fact about the fire, not about what was known at
    // the cursor. So a pocket the fire never reaches would otherwise be told "no action is
    // required" at a cursor where nothing has been reported at all — the same all-clear
    // from absent data that the verdict exists to prevent, arriving through a second
    // branch. Where nothing has been observed, nothing can be declared safe.
    const instruction =
      pocketEgress.verdict === 'not_yet_observed'
        ? 'no_verified_action'
        : instructionFor(chosen, atMs, fireReaches);
    const template = templateFor(instruction);

    const values = {
      pocket: settlement.name,
      road: roadNameOf(chosen, graph),
      destination: chosen?.destination ?? '',
    };

    // A template that names a road needs one. Substituting an empty string produces a
    // grammatical sentence with a hole in it — "Leave Bédar now via  towards Lubrín" —
    // and every existing check passes it, because the placeholder was filled. Presence
    // of the value, not just absence of the placeholder, is what has to be verified.
    if (template.namesRoad && values.road.trim().length === 0) {
      rejected.push({
        at: built.response.at,
        pocketId: settlement.id,
        instruction,
        language: languagesFor(settlement)[0],
        text: '(not composed)',
        reason: 'unresolved_name',
        detail: 'the recommended route carries no named road, so the sentence would name nothing',
      });
      // This `continue` leaves the pocket loop, not the language loop below, so the ledger block
      // is skipped: no entry is written for this pocket. Marked, so the omission is legible.
      skipped.push(settlement.id);
      continue;
    }

    for (const language of languagesFor(settlement)) {
      const text = fillTemplate(template, language, values);

      // A sentence that still holds a placeholder has a missing value, which is a bug in
      // the caller rather than bad data; rejecting it keeps the invariant that what
      // ships is always a complete, approved sentence.
      const leftover = unresolvedPlaceholders(text);
      if (leftover.length > 0) {
        rejected.push({
          at: built.response.at, pocketId: settlement.id, instruction, language, text,
          // A missing value is a bug in this file, not a finding about the fire. Reporting
          // it as `no_evidence` told a reviewer the data did not support the sentence,
          // which sends them to the wrong place entirely.
          reason: 'incomplete_template',
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
        certainty: certaintyFor(chosen?.lastSafeDeparture ?? null, built.diagnostics.windowEnd),
        area: settlementArea(settlement),
        departure: chosen?.lastSafeDeparture ?? null,
      });
    }

    // The profile whose values produced the clearance the gate acted on. Resolved by id
    // from the range rather than inferred from the label, so the ledger records the
    // attaining profile's numbers even if the profiles are later renamed or reordered.
    const clearanceProfile = chosen?.clearanceMinutes
      ? ASSUMPTION_PROFILES.find((p) => p.id === chosen.clearanceMinutes!.pessimisticProfileId)
      : undefined;
    // The throughput the clearance divided by. Without it the ledger recorded the vehicles
    // and the minutes but not the divisor, so a reader still could not get from one to the
    // other. Named by the road class the bottleneck is on, because that is the term that
    // moved: a track clears 180 vehicles an hour under the cautious assumptions and 360
    // under the optimistic ones.
    const bottleneckHighway =
      chosen?.bottleneckSegmentId !== null && chosen?.bottleneckSegmentId !== undefined
        ? edgesById(graph).get(chosen.bottleneckSegmentId)?.highway
        : undefined;
    const bottleneckCapacityPerHour =
      bottleneckHighway !== undefined && clearanceProfile !== undefined
        ? clearanceProfile.assumptions.capacityPerHour[bottleneckHighway]
        : undefined;

    const fresh: StoredEntry = {
      id: `ledger-${settlement.id}-${built.response.at}`,
      at: built.response.at,
      recordedAt: new Date().toISOString(),
      pocketId: settlement.id,
      recommendation: instruction,
      // The evidence has to describe the recommendation that was actually made. It was
      // keyed off whether a route existed rather than off the instruction, so a ledger
      // entry reading `no_verified_action` could carry the line "recommended Los
      // Gallardos: 17.5 km, 55 min" — the auditable artifact disagreeing with itself,
      // and in the encouraging direction.
      evidence: [
        instruction === 'no_action'
          ? 'the fire does not reach this pocket within the modelled window'
          : pocketEgress.verdict === 'not_yet_observed'
            ? // Distinguishing this from the line below matters: "no route survived the
              // sweep" asserts a search that came up empty, and auditing it against a
              // response that lists four routes would read as the ledger contradicting
              // itself. Nothing was searched, because nothing had been reported.
              'no detection had arrived at this cursor, so no route could be assessed'
            : chosen === null
              ? 'no route survived the sweep from this pocket'
            : instruction === 'no_verified_action'
              ? `a route exists to ${chosen.destination} (${chosen.distanceKm} km, ${chosen.travelMinutes} min, worst road ${chosen.slowestHighway}) but its pessimistic departure has passed`
              : `recommended ${chosen.destination}: ${chosen.distanceKm} km, ${chosen.travelMinutes} min, worst road ${chosen.slowestHighway}`,
        `departure band ${chosen?.lastSafeDeparture ? `${chosen.lastSafeDeparture.earliest} .. ${chosen.lastSafeDeparture.latest ?? 'never closes inside the window'}` : 'none'}`,
        chosen?.lastSafeDeparture ? `basis: ${chosen.lastSafeDeparture.basis}` : 'basis: n/a',
        // The range, with its own basis, rather than a single figure. The ledger is the
        // artifact a reviewer reads to find out why a recommendation was made, so it has
        // to carry the spread the recommendation was made across — and the basis names the
        // values behind each end, which is the part a bare pair of numbers does not say.
        chosen?.clearanceMinutes != null
          ? `clearance at the tightest point: ${chosen.clearanceMinutes.basis}`
          : 'clearance: not computed',
        `detections ${built.diagnostics.detections}; persistent-heat polygons ${built.diagnostics.staticHeat.polygons}, detections removed ${built.diagnostics.staticHeat.removed}`,
      ],
      inputs: {
        // The values the clearance beside them was actually computed from — the profile
        // that attained the pessimistic end, not the nominal centre. Recording the nominal
        // 0.8 and 1.4 next to a 185.3-minute clearance gave a ledger from which the figure
        // could not be recovered: recomputing from its own inputs returned 181.5 or 108.9,
        // and the nominal pair reads permissive because it implies fewer vehicles. This is
        // the same defect that was fixed for the delay and missed for these two.
        mobileFraction: clearanceProfile?.assumptions.mobileFraction ?? clock.mobileFraction,
        vehicleOccupancy: clearanceProfile?.assumptions.vehicleOccupancy ?? clock.vehicleOccupancy,
        // The delay the GATE subtracted, under the name the gate used. Recording the
        // nominal here while the gate subtracted the pessimistic one left the ledger unable
        // to reproduce its own decision: at cursor 19h it recorded 15 minutes while the
        // route's own reason said the decision was 300 minutes late, and recomputing from
        // the ledger's inputs gave 285. The nominal still travels, under a name that says
        // which one it is.
        departureDelayMinutes: PESSIMISTIC_DELAY_MINUTES,
        nominalDepartureDelayMinutes: clock.departureDelayMinutes,
        population: settlement.population ?? 'unknown',
        // The pessimistic figure is the one the gate acted on, so it is the one recorded
        // under the plain name; the range travels with it rather than replacing it.
        clearanceMinutes: chosen?.clearanceMinutes?.pessimisticMinutes ?? 'unknown',
        // The divisor, so the figure above can be recomputed from this record alone.
        bottleneckCapacityPerHour: bottleneckCapacityPerHour ?? 'unknown',
        bottleneckHighway: bottleneckHighway ?? 'unknown',
        clearanceRangeMinutes: chosen?.clearanceMinutes
          ? `${chosen.clearanceMinutes.optimisticMinutes}..${chosen.clearanceMinutes.pessimisticMinutes}`
          : 'unknown',
      },
      // Attached here, before the append rather than in a pass over the fresh entries after it.
      // `append` serializes the entry when it is called, so a later pass mutates objects that
      // were already written — every persisted line carried `rejected: []`, and the rejection
      // log survived only inside the process that computed it, disappearing at exactly the
      // restart the store exists to survive. The route memo hid it: within one process a reused
      // entry came off the mutated in-memory object and looked intact.
      //
      // Complete at this point: rejections are pushed while this pocket's packages are built,
      // above, and no later pocket can add one carrying this pocket's id.
      rejected: rejected.filter((r) => r.pocketId === settlement.id),
      cursorSeconds,
      inputFingerprint,
    };

    // Asking for a cursor already recorded, under the same inputs, serves the recorded
    // entry rather than a fresh computation. Deterministic as the solve is, the recorded
    // one is what the system actually advised, and that is what an audit artifact has to
    // return — a recomputation would quietly replace history with a current answer.
    const recorded = findEntry(history.entries, cursorSeconds, inputFingerprint, settlement.id);
    if (recorded !== undefined) {
      ledger.push(recorded);
      reused += 1;
      continue;
    }
    if (ledgerStore === null) {
      // No store at all. Counted per pocket rather than left implicit, so the diagnostics name
      // what was lost and not merely that the store was missing — `unavailable` carries the why.
      writeFailures.push(settlement.id);
    } else {
      const written = ledgerStore.append(fresh);
      if (written.ok) {
        appended += 1;
      } else if (written.reason === 'full') {
        // A full store is the record working as designed and saying so; a failed write is a
        // fault. Reporting them as one number would let a reader dismiss a lost record as a
        // cap having been reached.
        ledgerFull = true;
      } else {
        writeFailures.push(settlement.id);
      }
    }
    // Served either way: the recommendation was computed for this request and belongs in the
    // response whether or not its bytes reached the file. `appended` counts writes and not
    // attempts — counting attempts would put `appended: 1` in the same diagnostics as
    // `writeFailures: ['bedar']`, and a reader summing appended + reused would find a total
    // larger than the history they can go and read.
    ledger.push(fresh);
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
      ledger: {
        // The store's name, not its path: `/api/alerts` is reachable without credentials and the
        // configured path is the absolute one a real deployment uses. See `ledgerName`.
        store: ledgerName(ledgerPath),
        appended,
        reused,
        unreadable: history.unreadable,
        writeFailures,
        skipped,
        full: ledgerFull || (ledgerStore?.isFull() ?? false),
        /** Set when the store could not be read; the response is served without its history. */
        unavailable: ledgerUnavailable,
      },
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
 * The road named in the sentence: the first significant named road on the route, walking
 * outward from the pocket.
 *
 * "First significant" rather than "first" or "longest", because both of those name the
 * wrong road. The first named edge out of a village is a residential street — "leave via
 * Calle Llanos" — which is true and useless to someone standing in Bédar. The longest is
 * wherever the route spends its time, which on a 25 km route to another town is a road
 * near the far end: that produced "Leave Bédar via Carretera de Turre a Mojácar towards
 * Mojácar".
 *
 * What a person needs is the road they walk out to and join. So: walk from the pocket,
 * skip the village streets, and take the first named road of a through class. Falls back
 * to the first named edge of any class when the route never reaches one, and returns
 * empty when the route has no named edge at all — which the caller treats as a rejection
 * rather than composing a sentence with a hole in it.
 *
 * Taken from the route the model actually selected, so the name and the geometry cannot
 * disagree, which is what makes the passability check meaningful rather than circular.
 */
const THROUGH_CLASSES = new Set(['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'unclassified']);

function roadNameOf(route: { segmentIds: string[] } | null, graph: RoadGraph): string {
  if (route === null) return '';
  const byId = new Map(graph.edges.map((e) => [e.id, e]));
  let fallback = '';
  for (const id of route.segmentIds) {
    const edge = byId.get(id);
    if (!edge?.name) continue;
    if (fallback === '') fallback = edge.name;
    if (THROUGH_CLASSES.has(edge.highway)) return edge.name;
  }
  return fallback;
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
