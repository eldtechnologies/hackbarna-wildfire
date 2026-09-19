// Engine routes.
//
// Time convention: `?at=<seconds>` since the scenario origin, matching the convention
// PR #11 sets for `/api/fires`. One cursor, one unit, everywhere. The response carries
// the resolved ISO instant so a client never has to redo the arithmetic, and the origin
// it was resolved against so the globe and the engine cannot disagree about what time
// it is.
//
// The cut field is split from the cursor answer on purpose. Cut times are a whole-window
// property and do not depend on the cursor, so re-sending 4,225 of them on every scrub
// frame would be megabytes per second of a static payload — the design pass measured
// 3.6 MB when the full 29,834-segment array was included. A client fetches
// `/api/egress/field` once and calls `/api/egress?at=` for the moving parts.

import { Router, type Request, type Response } from 'express';
import { buildEgress, loadContext } from './egress';
import { buildAlerts } from './alerts';
import { SWEEP_CONFIGS } from './sweep';
import { ledgerName, openLedger, type StoredEntry } from './ledger';
import { LEDGER_PATH } from '../config';

export interface EngineRouterOptions {
  /**
   * How many memoised responses to keep. Configurable so the bound's behaviour is
   * testable without walking 300 cursors through a full solve each.
   */
  cacheLimit?: number;
  /**
   * Where the recommendation ledger lives. Defaults to the configured path.
   *
   * An option for the same reason `cacheLimit` is one: without it a test that exercises
   * the router appends to the deployment's real ledger, and those entries then answer
   * later requests in place of a computation — the suite silently changing the behaviour
   * of the thing it is testing.
   */
  ledgerPath?: string;
}

/** The ledger path this router uses, resolved once so every route agrees. */
const resolveLedgerPath = (options: EngineRouterOptions): string => options.ledgerPath ?? LEDGER_PATH;

/**
 * A request parameter the client got wrong — the cursor, or the history limit.
 *
 * Distinct from the engine's own RangeErrors — the profile scaling refuses an unusable
 * speed, the mask refuses a lattice it cannot cover — so `fail` can answer 400 for the one
 * and 502 for the other. Both were RangeErrors, and catching the class rather than the
 * meaning turned an engine fault into a client error.
 */
class RequestError extends RangeError {}

export function engineRouter(options: EngineRouterOptions = {}): Router {
  const router = Router();

  /** Year 9999. Past this the CAP date pattern fails on the year's width. */
  const MAX_AT_SECONDS = 253_402_300_799;

  /**
   * One error response shape for every engine route.
   *
   * A cursor the client got wrong is a client error and answers 400. It used to map to
   * 400 on `/api/egress` only, because that route had its own branch; `/api/alerts` and
   * `/api/cap` fell through to the generic catch and reported `at=-5` as a 502 with a
   * stack trace, which says the server is broken when the request was.
   */
  const fail = (res: Response, err: unknown, fallback: string): void => {
    // Only a bad cursor is the client's fault. This used to catch every RangeError, and
    // the engine throws them too — the profile scaling refuses an unusable speed, the mask
    // refuses a lattice it cannot cover — so a corrupt committed graph was answered as
    // "your request was invalid" with the engine's internal message echoed to the caller,
    // on every request, forever. Engine failures are ours and belong in the log.
    if (err instanceof RequestError) {
      res.status(400).json({ error: err.message });
      return;
    }
    console.error(`[api] ${fallback}:`, err);
    res.status(502).json({ error: fallback });
  };

  /**
   * Parse the cursor: a canonical non-negative integer, or nothing at all.
   *
   * `undefined` means the client sent no `at` and gets the end of the window, which is
   * the documented default. Every other shape is rejected rather than falling back,
   * because the fallback is the most-informed state — the opposite of what a client
   * asking for a malformed time intended.
   */
  const parseAt = (raw: unknown): number | undefined => {
    if (raw === undefined) return undefined;
    if (typeof raw !== 'string') {
      // Express hands `?at[]=1&at[]=2` through as an array. Silently falling back would
      // serve the end of the window — the most-informed state — to a client that asked
      // for something else, which is the opposite answer.
      throw new RequestError('at must be a single value');
    }
    if (raw === '') return undefined;
    // Canonical digits only: `Number()` also accepts '0x10', '1e5' and ' 42 ', so a
    // cursor would silently mean something other than what the client wrote.
    if (!/^\d+$/.test(raw)) throw new RequestError('at must be a non-negative integer number of seconds');
    const n = Number(raw);
    if (n > MAX_AT_SECONDS) throw new RequestError('at is beyond the representable range of a CAP timestamp');
    return n;
  };

  /**
   * Parse `?limit=`: how many of the most recent entries to return.
   *
   * Absent means all of them, which is what the endpoint returned before a limit existed and
   * what a small history wants. Rejected rather than falling back when malformed, for the same
   * reason the cursor is: the fallback is the least bounded answer, so a client that asked for
   * a bounded one and got the whole file has the opposite of what it asked for.
   */
  const parseLimit = (raw: unknown): number | undefined => {
    if (raw === undefined || raw === '') return undefined;
    if (typeof raw !== 'string') throw new RequestError('limit must be a single value');
    if (!/^\d+$/.test(raw)) throw new RequestError('limit must be a non-negative integer');
    const n = Number(raw);
    // A digit string long enough to overflow is not a count of anything.
    if (!Number.isSafeInteger(n)) throw new RequestError('limit is too large to be a number of entries');
    return n;
  };

  /**
   * The tail of the history that a limit asks for.
   *
   * Spelled out rather than written `entries.slice(-limit)`, because `-0` is `0` to `slice`:
   * a limit of zero would return `slice(0)` — the entire store — which is the exact inversion
   * of the request, in the direction that costs the most.
   */
  const selectEntries = (entries: StoredEntry[], limit: number | undefined): StoredEntry[] => {
    if (limit === undefined || limit >= entries.length) return entries;
    if (limit === 0) return [];
    return entries.slice(-limit);
  };

  /**
   * Memoised responses, because the build is deterministic.
   *
   * Every engine request runs the twelve-configuration sweep on the event loop, over each
   * swept assumption profile — measured at roughly 200-260 ms of CPU with no coalescing,
   * so eight concurrent callers serialise to about 2 s and one client at a few requests a
   * second stalls `/api/fires` and `/api/health` with it. The routes are unauthenticated,
   * so the cursor is the only thing that varies and it is a small integer space a scrubber
   * revisits constantly.
   *
   * Reachability, stated accurately rather than as the reassurance that used to be here:
   * `SERVER_HOST` defaults to `127.0.0.1` (server/config.ts), so by default this is
   * loopback-only and the exposure is a local process. Setting `HOST=0.0.0.0` — which that
   * file documents as the way to show the demo from a phone — puts unauthenticated,
   * unthrottled, ~250 ms-of-event-loop routes on the LAN. The earlier wording here claimed
   * the server "binds every interface" unconditionally, which is not true by default and
   * invites a reader to misjudge the exposure in whichever direction they were already
   * leaning.
   *
   * Bounded so a hostile cursor walk cannot use the cache as a memory amplifier: the
   * scrubber's own path through the window is tens of entries, and a producer that
   * exceeds the cap evicts oldest-first rather than growing.
   */
  const CACHE_LIMIT = options.cacheLimit ?? 256;
  const egressCache = new Map<number | undefined, ReturnType<typeof buildEgress>>();
  const alertsCache = new Map<number | undefined, ReturnType<typeof buildAlerts>>();
  const memoise = <T>(cache: Map<number | undefined, T>, at: number | undefined, build: () => T): T => {
    const hit = cache.get(at);
    if (hit !== undefined) return hit;
    const built = build();
    if (cache.size >= CACHE_LIMIT) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    cache.set(at, built);
    return built;
  };

  // Warm the context so the first scrub is not a twelve-second stall. The cold build
  // parses the capture, indexes 2,660 detections against 29,834 edges and runs twelve
  // cut-field configurations; everything after that is a solve per configuration.
  void (async () => {
    try {
      const t0 = Date.now();
      loadContext();
      console.log(`[engine] context ready in ${Date.now() - t0} ms`);
    } catch (err) {
      console.error('[engine] context failed to load; /api/egress will 502:', err);
    }
  })();

  router.get('/api/egress', (req: Request, res: Response) => {
    try {
      const atSeconds = parseAt(req.query.at);
      const built = memoise(egressCache, atSeconds, () =>
        buildEgress(atSeconds === undefined ? {} : { atSeconds }),
      );
      // Only segments the fire reaches. A segment absent from this list was never cut
      // within the modelled window, which is a different statement from "not yet" and
      // is exactly the distinction the contract's nullable cutAt exists to make.
      const segments = built.response.segments.filter((s) => s.cutAt !== null);
      res.json({
        ...built.response,
        segments,
        origin: built.diagnostics.originIso,
        scenario: built.diagnostics.scenario,
        windowEnd: built.diagnostics.windowEnd,
        detections: built.diagnostics.detections,
        totalSegments: built.response.segments.length,
        configurations: SWEEP_CONFIGS.map((c) => ({ id: c.id, label: c.label })),
      });
    } catch (err) {
      fail(res, err, 'egress solve unavailable');
    }
  });

  router.get('/api/egress/field', (_req: Request, res: Response) => {
    try {
      const built = memoise(egressCache, undefined, () => buildEgress({}));
      res.json({
        provenance: built.response.provenance,
        origin: built.diagnostics.originIso,
        scenario: built.diagnostics.scenario,
        assumptions: built.response.assumptions,
        // The swept set travels with the field as well as with each cursor answer. This is
        // the payload a client fetches once, and a band basis naming a profile it has no
        // way to resolve is a dead reference — the reader cannot see the values behind the
        // label without asking a second endpoint for them.
        profiles: built.response.profiles,
        // Cursor-independent: the same field answers every `at`.
        segments: built.response.segments.filter((s) => s.cutAt !== null),
        totalSegments: built.response.segments.length,
      });
    } catch (err) {
      fail(res, err, 'cut field unavailable');
    }
  });

  router.get('/api/alerts', (req: Request, res: Response) => {
    try {
      const atSeconds = parseAt(req.query.at);
      const built = memoise(alertsCache, atSeconds, () =>
        buildAlerts({
          ...(atSeconds === undefined ? {} : { atSeconds }),
          ledgerPath: resolveLedgerPath(options),
        }),
      );
      res.json({
        ...built.response,
        ledger: built.ledger,
        diagnostics: built.diagnostics,
      });
    } catch (err) {
      fail(res, err, 'alert package unavailable');
    }
  });

  /**
   * One CAP 1.2 document per pocket.
   *
   * `<alert>` is the document root in CAP, so a multi-pocket send is several messages,
   * each with its own identifier — which is how acknowledgement works in a real system.
   * The endpoint therefore takes a pocket rather than returning a bundle that would not
   * be schema-valid.
   */
  router.get('/api/cap/:pocketId', (req: Request, res: Response) => {
    try {
      const atSeconds = parseAt(req.query.at);
      const built = memoise(alertsCache, atSeconds, () =>
        buildAlerts({
          ...(atSeconds === undefined ? {} : { atSeconds }),
          ledgerPath: resolveLedgerPath(options),
        }),
      );
      const pocketId = String(req.params.pocketId);
      const xml = built.documents.get(pocketId);
      if (xml === undefined) {
        res.status(404).json({
          error: `no CAP document for pocket "${pocketId}"`,
          available: [...built.documents.keys()],
        });
        return;
      }
      // Refuse to serve a document that failed its own checks. A CAP file is the thing
      // that gets broadcast; emitting one the engine has already flagged, with the
      // failure visible only in a different endpoint's diagnostics, is how a malformed
      // alert reaches the public.
      const validation = built.diagnostics.emitter.validation[pocketId];
      if (validation && !validation.ok) {
        console.error(`[api] /api/cap refused to serve ${pocketId}:`, validation.problems);
        res.status(502).json({ error: 'CAP document failed validation', problems: validation.problems });
        return;
      }
      // Express's res.send(string) defaults to text/html; a CAP consumer wants XML.
      res.type('application/xml; charset=utf-8');
      res.send(xml);
    } catch (err) {
      fail(res, err, 'CAP emission failed');
    }
  });

  /**
   * The whole recommendation history, in recording order.
   *
   * No cursor is supplied: the point of the record is that a reviewer can read the incident
   * without already knowing which moments to ask for. Recording order rather than cursor
   * order, because the engine is asked for cursors by a scrubber rather than in sequence and
   * sorting would present a later moment before an earlier one.
   *
   * `unreadable` travels with the entries so a short history cannot be read as a complete
   * one — a truncated line from a crash mid-append is skipped, not hidden.
   */
  router.get('/api/ledger', (req: Request, res: Response) => {
    try {
      const path = resolveLedgerPath(options);
      const { entries, unreadable } = openLedger(path).history();
      const limit = parseLimit(req.query.limit);
      // `count` is what the store holds and `entries` is what this response carries, so a
      // limited read is never mistaken for a short history. The limit bounds the RESPONSE, not
      // the read — the file is parsed whole either way, and the store's byte cap is what bounds
      // that. A full store serialised to 15.5 MiB, which is not a page anyone can open.
      res.json({
        // The name rather than the path: this route needs no credentials, and the configured
        // path is the absolute one a real deployment uses. See `ledgerName`.
        store: ledgerName(path),
        count: entries.length,
        unreadable,
        entries: selectEntries(entries, limit),
      });
    } catch (err) {
      fail(res, err, 'recommendation history unavailable');
    }
  });

  return router;
}
