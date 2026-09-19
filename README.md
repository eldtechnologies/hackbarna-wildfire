# Ojo de Fuego

Real-time wildfire intelligence console for Spain, built at HackBarna 2026 (Barcelona).

Live satellite hotspots, active fire perimeters, and spread simulation on a 3D globe, plus an AI agent that identifies infrastructure and people at risk and recommends evacuation priorities.

Tracks: **Monitoring active fires** + **Values at risk**.

See [docs/DESIGN.md](docs/DESIGN.md) for the full design document.

## Developing

```bash
npm install
bun run dev
```

Starts the Vite client on http://localhost:5173 and the Express proxy on http://localhost:3001 (the client proxies `/api/*` to it).

Other scripts: `bun run build` (production build), `bun run typecheck` (client + server type check),
`bun run test` (server unit tests, Node's built-in runner).

## Data modes

The server has two data sources, selected with `DATA_MODE`:

- `replay` (default): serves a cached snapshot from `data/snapshots/` (set `REPLAY_SNAPSHOT` to pick the file). Works with no keys and no network.
- `live`: calls the Deepfire API (`DEEPFIRE_BASE_URL`, `DEEPFIRE_API_KEY`) and normalizes the response. On any failure it transparently falls back to the replay snapshot.

Every `/api/fires` response carries a `provenance` field (`live` or `replay`) so the HUD can show which source served the data. The Deepfire payload shapes are mocked from the public API description in `server/providers/normalize.ts`; adjust that one file when the real spec arrives.
