import express from 'express';
import { SERVER_PORT } from './config';
import { getFires } from './providers';

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

app.listen(SERVER_PORT, () => {
  console.log(`[server] ojo-de-fuego server listening on http://localhost:${SERVER_PORT}`);
});
