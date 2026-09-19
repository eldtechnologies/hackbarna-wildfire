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

## Data modes

The server has two data sources, selected with `DATA_MODE`:

- `replay` (default): serves a cached snapshot from `data/snapshots/`. Works with no keys and no network.
- `live`: calls the Deepfire API (`DEEPFIRE_BASE_URL`, `DEEPFIRE_API_KEY`) and normalizes the response. On any failure it transparently falls back to replay, so a dead API or venue wifi never blanks the demo.

Put keys in a `.env` file at the project root (gitignored, auto-loaded by `npm run server`):

```bash
DATA_MODE=live
DEEPFIRE_BASE_URL=https://...
DEEPFIRE_API_KEY=...
```

Every `/api/fires` response carries a `provenance` field (`live` or `replay`) so the HUD can show which source served the data. The Deepfire payload shapes are mocked from the public API description in `server/providers/normalize.ts`; adjust that one file when the real spec arrives.

## Snapshots and recordings

`data/snapshots/` holds two file formats, both in the raw Deepfire shape so replay goes through the same normalizer as live data:

- **Flat snapshot** (one moment): `{ scenario, hotspots, clusters, spread }`, e.g. `castelltallat-2025.json`.
- **Recording** (an event timeline): `{ scenario, recordedAt, intervalSeconds, frames: [{ t, hotspots, clusters, spread }] }`, captured by the record script.

### Recording live data

```bash
# single capture (one moment)
DEEPFIRE_BASE_URL=... DEEPFIRE_API_KEY=... npm run record:snapshot -- --scenario <name>

# continuous recording for timeline replay (n frames, s seconds apart)
DEEPFIRE_BASE_URL=... DEEPFIRE_API_KEY=... npm run record:snapshot -- --scenario <name> --frames 8 --interval 15
```

Files are written as `data/snapshots/<scenario>-<UTCstamp>.json`. Recording against the real API captures the event as it happens; against the mock (below) you can capture hours of fire growth in under two minutes.

### Replaying a recorded event as a timeline

A recording carries its frames' timestamps. `/api/fires` returns a `timeline` block (`start`, `end`, `durationSeconds`, `frames`) and serves the latest frame by default (the live edge). Scrub the event with `?at=<seconds>` (seconds since the first frame):

```bash
curl localhost:3001/api/fires?at=0    # first frame
curl localhost:3001/api/fires?at=105  # last frame of an 8x15s recording
```

### Which snapshot is served

1. `REPLAY_SNAPSHOT` naming a file in `data/snapshots/` exactly.
2. `REPLAY_SNAPSHOT` as a scenario prefix: newest `<name>-*.json`. A set `REPLAY_SNAPSHOT` that matches nothing is an error (502), never a silent substitute.
3. No setting: the newest `.json` in the directory, so a fresh recording automatically becomes the demo scenario.

### Mock Deepfire server

For rehearsal without the real API, `npm run mock:deepfire` serves the mocked raw shape on `http://localhost:4590` (`MOCK_PORT`, `MOCK_SPEED` for simulated seconds per real second, default 120). The fire grows on the accelerated clock, so an 8-frame, 15-second-interval recording captures roughly 3.5 simulated hours of a fire.

```bash
npm run mock:deepfire &
DATA_MODE=live DEEPFIRE_BASE_URL=http://localhost:4590 DEEPFIRE_API_KEY=dev npm run server
# kill the mock and the next /api/fires poll falls back to replay automatically
```

The committed `castelltallat-drill-*.json` recording was captured this way and is the default replay scenario: 8 frames, hotspots 10 to 13, perimeter 7.4 to 11 km2.
