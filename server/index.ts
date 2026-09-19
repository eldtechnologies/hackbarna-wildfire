import express from 'express';
import { SERVER_HOST, SERVER_PORT } from './config';
import { getFires } from './providers';
import { getInfrastructure } from './infrastructure';
import { getThreats } from './threats';

const app = express();

app.get('/api/health', (_req, res) => {
  res.json({
    status: 'ok',
    service: 'ojo-de-fuego',
    mode: process.env.DATA_MODE ?? 'replay',
    time: new Date().toISOString(),
  });
});

app.get('/api/fires', async (_req, res) => {
  try {
    res.json(await getFires());
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

app.listen(SERVER_PORT, SERVER_HOST, () => {
  console.log(`[server] ojo-de-fuego server listening on http://${SERVER_HOST}:${SERVER_PORT}`);
});
