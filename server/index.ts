import express from 'express';
import { LEDGER_PATH, SERVER_HOST, SERVER_PORT } from './config';
import { openLedger } from './engine/ledger';
import { getFires } from './providers';
import { getInfrastructure } from './infrastructure';
import { getThreats } from './threats';
import { getSituation } from './situation';
import { engineRouter } from './engine/routes';

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

app.get('/api/situation', async (req, res) => {
  const fireId = typeof req.query.fireId === 'string' ? req.query.fireId : '';
  if (!fireId) {
    res.status(400).json({ error: 'fireId query parameter required' });
    return;
  }
  try {
    // Same timeline semantics as /api/fires: ?at=<seconds> scrubs a recorded
    // event, absent serves the latest state.
    const atRaw = req.query.at;
    const atParsed = atRaw === '' ? NaN : Number(atRaw);
    const atSeconds = Number.isFinite(atParsed) ? Math.max(0, atParsed) : undefined;
    const situation = await getSituation(fireId, atSeconds);
    if (!situation) {
      res.status(404).json({ error: `unknown fireId ${fireId}` });
      return;
    }
    res.json(situation);
  } catch (err) {
    console.error('[api] /api/situation failed:', err);
    res.status(502).json({ error: 'situation analysis unavailable' });
  }
});

// Open the recommendation ledger before anything is served.
//
// The store documents that an unusable path is "an error at startup that names the path", and
// until this call existed that was not true: `openLedger` ran only per request, so a
// misconfigured LEDGER_PATH produced a server that started healthy and then answered 502 on
// `/api/alerts` and `/api/cap/:pocketId` — the two routes that exist to tell people to leave —
// with the real reason visible only in the log. Refusing to start is the promise the store makes,
// and it is the right one for a setting an operator can fix before anyone depends on the process.
try {
  openLedger(LEDGER_PATH);
} catch (err) {
  console.error(
    `[server] refusing to start: the recommendation ledger is unusable: ${err instanceof Error ? err.message : String(err)}`,
  );
  process.exit(1);
}

app.listen(SERVER_PORT, SERVER_HOST, () => {
  console.log(`[server] ojo-de-fuego server listening on http://${SERVER_HOST}:${SERVER_PORT}`);
});
