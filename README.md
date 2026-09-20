# Ojo de Fuego

Real-time wildfire intelligence console for Spain, built at HackBarna 2026 (Barcelona).

Live satellite hotspots, active fire perimeters, and spread simulation on a 3D globe, plus an AI agent that identifies infrastructure and people at risk and recommends evacuation priorities.

Tracks: **Monitoring active fires** + **Values at risk**.

See [docs/DESIGN.md](docs/DESIGN.md) for the full design document.

## Developing

```bash
npm install
npm run dev
```

Starts the Vite client on http://localhost:5173 and the Express proxy on http://localhost:3001 (the client proxies `/api/*` to it).

Other scripts: `npm run build` (production build), `npm run typecheck` (client + server type check).

## Infrastructure + threat analysis

Bundled infrastructure (hospitals, schools, towns, power lines) lives in `data/infrastructure/*.geojson` and is committed to the repo. Regenerate with `node scripts/fetch-infrastructure.mjs` (needs network). Sources: Generalitat de Catalunya open data (equipaments, caps de municipi) and OpenStreetMap high-voltage power lines via the Overpass API, attribution in each file's `properties`.

API endpoints:

- `GET /api/infrastructure`: all bundled infrastructure assets (point assets + power line paths).
- `GET /api/threats?fireId=<clusterId>`: server-side turf.js analysis. For the fire's perimeter, lists every asset inside the perimeter, inside the 5/10/20 km buffer rings, or inside the projected spread corridor, with per-asset distance and category.
- `GET /api/situation?fireId=<clusterId>`: situation agent. Assembles a computed situation packet (perimeter area, derived spread heading, hotspot/FRP totals, threat list) and narrates it: plain-language summary plus evacuation recommendations ordered by severity. All figures come from computed geometry; the narrator only phrases them. Returns `narrator: 'llm'` or `'template'` so the demo is honest about which produced the prose.

## Situation agent

The server calls an OpenAI-compatible chat-completions endpoint to narrate the packet. Without `LLM_API_KEY` (or when the call fails, times out after 15 s, or returns malformed output) it falls back to a deterministic template narration, so the endpoint always answers and the keyless demo works offline. The key lives only in the server env, never in the browser.

Spread direction note: the fire schema has no measured wind field, so the packet's spread direction is the drift heading computed from the perimeter centroid toward the furthest spread projection, not a measured wind. A live wind feed (WeatherNext is the planned source in DESIGN.md) is a follow-up.

```bash
LLM_BASE_URL=https://api.openai.com/v1   # any OpenAI-compatible /chat/completions endpoint
LLM_API_KEY=...
LLM_MODEL=gpt-4o-mini
```

## Data modes

The server has two data sources, selected with `DATA_MODE`:

- `replay` (default): serves a cached snapshot from `data/snapshots/` (set `REPLAY_SNAPSHOT` to pick the file). Works with no keys and no network.
- `live`: calls the Deepfire API (`DEEPFIRE_BASE_URL`, `DEEPFIRE_API_KEY`) and normalizes the response. On any failure it transparently falls back to the replay snapshot.

Put keys in a `.env` file at the project root (gitignored, auto-loaded by `npm run server`):

```bash
DATA_MODE=live
DEEPFIRE_BASE_URL=https://...
DEEPFIRE_API_KEY=...
```

Every `/api/fires` response carries a `provenance` field (`live` or `replay`) so the HUD can show which source served the data. The Deepfire payload shapes are mocked from the public API description in `server/providers/normalize.ts`; adjust that one file when the real spec arrives.
