import express from 'express';

const PORT = 3001;

const app = express();
app.use(express.json());

// Placeholder until the data provider card lands the real endpoints.
app.get('/api/health', (_req, res) => {
  res.json({
    status: 'ok',
    service: 'ojo-de-fuego',
    mode: process.env.DATA_MODE ?? 'replay',
    time: new Date().toISOString(),
  });
});

app.listen(PORT, () => {
  console.log(`[server] ojo-de-fuego proxy listening on http://localhost:${PORT}`);
});
