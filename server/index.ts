import express from 'express';
import { SERVER_PORT } from './config';

const app = express();

// Placeholder until the data provider card lands the real endpoints.
app.get('/api/health', (_req, res) => {
  res.json({
    status: 'ok',
    service: 'ojo-de-fuego',
    mode: process.env.DATA_MODE ?? 'replay',
    time: new Date().toISOString(),
  });
});

app.listen(SERVER_PORT, () => {
  console.log(`[server] ojo-de-fuego server listening on http://localhost:${SERVER_PORT}`);
});
