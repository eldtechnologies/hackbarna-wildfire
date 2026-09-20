import express from 'express';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LEDGER_PATH, SERVER_HOST, SERVER_PORT } from './config';
import { openLedger } from './engine/ledger';
import { getFires } from './providers';
import { getInfrastructure } from './infrastructure';
import { getThreats } from './threats';
import { growthFor } from './model';
import { loadMetrics, type Metrics } from './model/metrics';
import { engineRouter } from './engine/routes';

/**
 * The Express app, as a factory so tests can exercise the real routes over HTTP.
 * `metrics` is injectable to reach the growth route's failure path — a corrupt
 * harness artifact answering 502 rather than an empty score list; production uses
 * the committed file.
 */
export function createApp(metrics: () => Metrics = loadMetrics): express.Express {
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
      // ?at=<seconds> scrubs a recorded event timeline. Absent or invalid
      // values serve the latest state (live edge).
      const atRaw = req.query.at;
      const atParsed = atRaw === '' ? NaN : Number(atRaw);
      const atSeconds = Number.isFinite(atParsed) ? Math.max(0, atParsed) : undefined;
      res.json(await getFires(atSeconds));
    } catch (err) {
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
      const threats = await getThreats(fireId);
      if (!threats) {
        res.status(404).json({ error: `unknown fireId ${fireId}` });
        return;
      }
      res.json(threats);
    } catch (err) {
      console.error('[api] /api/threats failed:', err);
      res.status(502).json({ error: 'threat analysis unavailable' });
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
      const body = growthFor(clusterId, await getFires(), new Date(), metrics);
      if (!body) {
        res.status(404).json({ error: 'cluster not found' });
        return;
      }
      res.json(body);
    } catch (err) {
      console.error('[api] /api/growth failed:', err);
      res.status(502).json({ error: 'growth data unavailable' });
    }
  });

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
