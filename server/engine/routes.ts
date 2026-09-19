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
import { SWEEP_CONFIGS } from './sweep';

export function engineRouter(): Router {
  const router = Router();

  /**
   * Parse the cursor. Express hands `?at=1&at=2` through as an array, and
   * `Number(['1','1'])` is NaN, so only a plain string is accepted.
   */
  const parseAt = (raw: unknown): number | undefined => {
    if (typeof raw !== 'string' || raw === '') return undefined;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : undefined;
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
      const built = buildEgress(atSeconds === undefined ? {} : { atSeconds });
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
      console.error('[api] /api/egress failed:', err);
      res.status(502).json({ error: 'egress solve unavailable' });
    }
  });

  router.get('/api/egress/field', (_req: Request, res: Response) => {
    try {
      const built = buildEgress({});
      res.json({
        provenance: built.response.provenance,
        origin: built.diagnostics.originIso,
        scenario: built.diagnostics.scenario,
        assumptions: built.response.assumptions,
        // Cursor-independent: the same field answers every `at`.
        segments: built.response.segments.filter((s) => s.cutAt !== null),
        totalSegments: built.response.segments.length,
      });
    } catch (err) {
      console.error('[api] /api/egress/field failed:', err);
      res.status(502).json({ error: 'cut field unavailable' });
    }
  });

  // Deliberately not a stub returning an empty package list. An empty list reads as
  // "no alert is needed", which is the single most dangerous thing this system could
  // say by accident, and the emitter is not built yet.
  router.get('/api/alerts', (_req: Request, res: Response) => {
    res.status(503).json({
      error: 'alert emitter not built yet',
      detail:
        'The egress solve and the cut field are live at /api/egress. The CAP package ' +
        'emitter (server/engine/cap/) has not landed, so there are no packages to return. ' +
        'This endpoint answers 503 rather than 200 with an empty list, because an empty ' +
        'list is indistinguishable from "no alert required".',
    });
  });

  return router;
}
