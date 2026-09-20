import express from 'express';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LEDGER_PATH, SERVER_HOST, SERVER_PORT } from './config';
import { openLedger } from './engine/ledger';
import { getFires, parseSource } from './providers';
import { getInfrastructure } from './infrastructure';
import { getThreats } from './threats';
import { getSituation } from './situation';
import { growthFor } from './model';
import { loadMetrics, type Metrics } from './model/metrics';
import { engineRouter } from './engine/routes';
import { parseCursor, epoch, CursorError } from './providers/availability';
import { ForecastStore } from './model/forecast';

/**
 * The Express app, as a factory so tests can exercise the real routes over HTTP.
 * `metrics` is injectable to reach the growth route's failure path — a corrupt
 * harness artifact answering 502 rather than an empty score list; production uses
 * the committed file.
 */
export function createApp(metrics: () => Metrics = loadMetrics, forecasts = new ForecastStore()): express.Express {
  const app = express();

  app.use(engineRouter());

  app.get('/api/health', (_req, res) => {
    res.json({
      status: 'ok',
      service: 'ojo-de-fuego',
      mode: process.env.DATA_MODE ?? 'replay',
      time: new Date().toISOString(),
    });
  });

  app.get('/api/fires', async (req, res) => {
    try {
      // An absent cursor serves the replay edge; malformed cursors fail closed.
      const atSeconds = parseCursor(req.query.at);
      res.json(await getFires(atSeconds, parseSource(req.query.source)));
    } catch (err) {
      if (err instanceof CursorError) { res.status(400).json({error:err.message}); return; }
      console.error('[api] /api/fires failed:', err);
      res.status(502).json({ error: 'fire data unavailable' });
    }
  });

  app.get('/api/infrastructure', async (_req, res) => {
    try {
      res.json(await getInfrastructure());
    } catch (err) {
      console.error('[api] /api/infrastructure failed:', err);
      res.status(502).json({ error: 'infrastructure data unavailable' });
    }
  });

  app.get('/api/threats', async (req, res) => {
    const fireId = typeof req.query.fireId === 'string' ? req.query.fireId : '';
    if (!fireId) {
      res.status(400).json({ error: 'fireId query parameter required' });
      return;
    }
    try {
      const threats = await getThreats(fireId,await getFires(parseCursor(req.query.at), parseSource(req.query.source)));
      if (!threats) {
        res.status(404).json({ error: `unknown fireId ${fireId}` });
        return;
      }
      res.json(threats);
    } catch (err) {
      if (err instanceof CursorError) { res.status(400).json({error:err.message}); return; }
      console.error('[api] /api/threats failed:', err);
      res.status(502).json({ error: 'threat analysis unavailable' });
    }
  });

  app.get('/api/situation', async (req,res)=>{
    const fireId=typeof req.query.fireId==='string' ? req.query.fireId : '';
    if (!fireId) {res.status(400).json({error:'fireId query parameter required'});return;}
    try {
      const situation=await getSituation(fireId,parseCursor(req.query.at),parseSource(req.query.source));
      if (!situation) {res.status(404).json({error:'unknown fireId'});return;}
      res.json(situation);
    } catch(err) {
      if(err instanceof CursorError) {res.status(400).json({error:err.message});return;}
      console.error('[api] /api/situation failed:',err);
      res.status(502).json({error:'situation analysis unavailable'});
    }
  });

  app.get('/api/growth', async (req, res) => {
    // Guard the type like /api/threats. Express's extended query parser turns
    // `?clusterId[toString]=x` into an object whose toString is not callable;
    // coercing it throws a TypeError that rejects the async handler, and Express 4
    // does not catch that rejection, so the process exits. A non-string is no id,
    // i.e. a 400, not a crash.
    const clusterId = typeof req.query.clusterId === 'string' ? req.query.clusterId : '';
    if (!clusterId) {
      res.status(400).json({ error: 'clusterId is required' });
      return;
    }
    try {
      const evidence = await getFires(parseCursor(req.query.at), parseSource(req.query.source));
      const body = growthFor(clusterId, evidence, new Date(evidence.asOf ?? evidence.fetchedAt), metrics);
      if (!body) {
        res.status(404).json({ error: 'cluster not found' });
        return;
      }
      res.json(body);
    } catch (err) {
      if (err instanceof CursorError) { res.status(400).json({error:err.message}); return; }
      console.error('[api] /api/growth failed:', err);
      res.status(502).json({ error: 'growth data unavailable' });
    }
  });

  app.get('/api/forecasts', async (req,res) => {
    const {eventId,issue}=req.query;
    if ((eventId!==undefined || issue!==undefined) &&
        (typeof eventId!=='string' || !eventId || typeof issue!=='string' || epoch(issue)===null)) {
      res.status(400).json({error:'eventId and a timezone-qualified issue timestamp are required'});return;
    }
    try {
      if (eventId===undefined) { res.json({target:'observed_thermal_detection_within_horizon',forecasts:await forecasts.list()});return; }
      const forecast=await forecasts.get(eventId as string,issue as string);
      if(!forecast){res.status(404).json({error:'no prepared forecast for this event and issue time'});return;}
      res.json(forecast);
    } catch(err) {
      console.error('[api] forecast unavailable:',err);
      res.status(502).json({error:'forecast artifact unavailable'});
    }
  });

  // Serve the built frontend from the same process, so a container deployment
  // (Coolify/Docker) is one service on one port rather than a split proxy.
  //
  // Mounted AFTER the API routes so /api/* always wins; the SPA fallback only
  // catches non-API GETs. Guarded by the dist/ build existing: in `npm run dev`
  // Vite serves the client and proxies /api here, so there is no build to serve
  // and this stays inert. `express.static` handles real asset paths; anything
  // else falls through to index.html for client-side routing.
  const clientDist = resolve(dirname(fileURLToPath(import.meta.url)), '../dist');
  if (existsSync(clientDist)) {
    app.use(express.static(clientDist));
    app.get(/^(?!\/api\/).*/, (_req, res) => {
      res.sendFile(resolve(clientDist, 'index.html'));
    });
  }

  return app;
}

// Listen only when this file is the entry point, so importing it in a test does not
// start a server.
const isEntryPoint =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isEntryPoint) {
  // Preserve main's startup check before creating the app or accepting requests.
  try {
    openLedger(LEDGER_PATH);
  } catch (err) {
    console.error(
      `[server] refusing to start: the recommendation ledger is unusable: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(1);
  }
  const app = createApp();
  app.listen(SERVER_PORT, SERVER_HOST, () => {
    console.log(`[server] ojo-de-fuego server listening on http://${SERVER_HOST}:${SERVER_PORT}`);
  });
}
