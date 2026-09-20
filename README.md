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

Other scripts: `npm run build` (production build), `npm run typecheck` (client + server type check),
`npm run test` (server unit tests, Node's built-in runner).

## Infrastructure + threat analysis

Bundled infrastructure (hospitals, schools, towns, power lines) lives in `data/infrastructure/*.geojson` and is committed to the repo. Regenerate with `node scripts/fetch-infrastructure.mjs` (needs network). Sources: Generalitat de Catalunya open data (equipaments, caps de municipi) and OpenStreetMap high-voltage power lines via the Overpass API, attribution in each file's `properties`.

API endpoints:

- `GET /api/infrastructure`: all bundled infrastructure assets (point assets + power line paths).
- `GET /api/threats?fireId=<clusterId>`: server-side turf.js analysis. For the fire's perimeter, lists every asset inside the perimeter, inside the 5/10/20 km buffer rings, or inside the projected spread corridor, with per-asset distance and category.

## Growth model

`GET /api/growth?clusterId=<id>&at=<seconds>` returns descriptive detection-centroid motion and corpus baseline scores. Its `validation=diagnostic_only` and `roadUse=unsupported` fields are explicit: those scores do not validate fire-front arrival. See [the current architecture decision](docs/model-proposal.md).

`GET /api/forecasts` lists prepared native-grid thermal forecasts; `?eventId=<id>&issue=<ISO timestamp>` serves one validated artifact. The [handoff contract](docs/forecast-contract.md) includes coverage, provenance, calibration and fallback semantics. Set `FORECAST_DIR=data/forecasts/example` to serve the real archived persistence example. Model promotion follows the [prospective evaluation gate](docs/thermal-evaluation.md).

The scores live in `data/model/metrics.json`, produced by `tools/model/harness.py` against corpora that stay on the data box. The corpus metrics carry `source` and `generator`; separate diagnostic and uncertainty artifacts name their targets and limitations. Regenerate with:

```bash
STREAM3_DATA_DIR=<corpora> uv run --with geopandas --with pandas --with scikit-learn python tools/model/harness.py
```

The harness writes nothing unless every corpus scored, so a run without the data cannot overwrite the committed artifact.

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

- **Flat snapshot** (one moment): `{ scenario, hotspots, clusters, perimeters }`, e.g. `los-gallardos-2026-07-09.json` (a real capture from the Deepfire API).
- **Recording** (an event timeline): `{ scenario, recordedAt, intervalSeconds, frames: [{ t, hotspots, clusters, spread }] }`, captured by the record script against the mock.

### Recording mock data

The record script speaks the mock's flat `{hotspots, clusters, spread}` shape, not the real API's OGC collections, so recordings are captured from `npm run mock:deepfire` (below):

```bash
npm run mock:deepfire &

# single capture (one moment)
DEEPFIRE_BASE_URL=http://localhost:4590 npm run record:snapshot -- --scenario <name>

# continuous recording for timeline replay (n frames, s seconds apart)
DEEPFIRE_BASE_URL=http://localhost:4590 npm run record:snapshot -- --scenario <name> --frames 8 --interval 15
```

Files are written as `data/snapshots/<scenario>-<UTCstamp>.json`. The mock's fire grows on an accelerated clock, so you can capture hours of fire growth in under two minutes.

### Replaying a recorded event as a timeline

A recording carries its frames' timestamps. `/api/fires` returns a `timeline` block (`start`, `end`, `durationSeconds`, `frames`) and serves the latest frame by default (the live edge). Scrub the event with `?at=<seconds>` (seconds since the first frame):

```bash
curl localhost:3001/api/fires?at=0    # first frame
curl localhost:3001/api/fires?at=106  # last frame of the committed drill (its durationSeconds)
```

### Which snapshot is served

1. `REPLAY_SNAPSHOT` naming a file in `data/snapshots/` exactly.
2. `REPLAY_SNAPSHOT` as a scenario prefix: newest `<name>-*.json`. A set `REPLAY_SNAPSHOT` that matches nothing is an error (502), never a silent substitute.
3. `REPLAY_SNAPSHOT` set to an empty value: the newest `.json` in the directory, so a fresh recording automatically becomes the demo scenario.
4. Unset: the default `los-gallardos-2026-07-09.json`.

### Mock Deepfire server

For rehearsal without the real API, `npm run mock:deepfire` serves the flat raw shape on `http://localhost:4590` (`MOCK_PORT`, `MOCK_SPEED` for simulated seconds per real second, default 120). The fire grows on the accelerated clock, so an 8-frame, 15-second-interval recording captures roughly 3.5 simulated hours of a fire. The mock is consumed by `npm run record:snapshot`; it does not serve the OGC paths the live provider calls, so it cannot stand in for `DATA_MODE=live`.

The committed `castelltallat-drill-*.json` recording was captured this way: 8 frames, hotspots 10 to 13, perimeter 7.4 to 11 km2. Select it with `REPLAY_SNAPSHOT=castelltallat-drill` (the prefix picks the newest matching recording).
## Egress engine

`server/engine/` answers a different question from the console: not "where is the fire"
but "when does the road out close, and can this village still leave".

| Route | Returns |
| --- | --- |
| `GET /api/egress?at=<seconds>` | Pockets, the routes out of each, and the last-safe-departure band per route |
| `GET /api/egress/field` | The cut-time field over the road network. Cursor-independent — fetch it once |
| `GET /api/alerts?at=<seconds>` | The alert packages, the rejection log and the decision ledger |
| `GET /api/cap/:pocketId?at=<seconds>` | One CAP 1.2 XML document for that pocket |
| `GET /api/ledger?limit=<n>` | The whole recommendation history, in the order it was recorded. No cursor: the point is reading the incident without already knowing which moments to ask for. `limit` takes the most recent n; `total` reports what the store holds |
| `GET /api/reach` | The over-alerting figure: population inside a mobile cell's served footprint for a fire that does not reach it. No cursor — both inputs are whole-window properties. Published with the proportion of cells carrying a measured range rather than the operator's fallback, and with the survey box the cells were drawn from |

`?at=` is seconds since the scenario origin, matching `/api/fires`. Responses publish the
origin they resolved, because the client's globe and this engine have to agree on what
time it is; a malformed cursor answers 400 rather than silently serving the latest state.

The band is the point. The same road reads 19:38 CEST or 00:03 CEST depending on which
sensors you trust, so the engine sweeps twelve assumption sets and ships the envelope,
naming the configuration behind each end rather than reporting a point estimate.

Rebuild the committed data with:

```bash
node scripts/fetch-roads.mjs     # OSM road graph       -> data/graph/
node scripts/fetch-pockets.mjs   # Catastro footprints  -> data/pockets/
node scripts/fetch-reach.mjs     # OpenCelliD cells     -> data/reach/   (needs OPENCELLID_TOKEN)
```

`fetch-reach.mjs` is the only one that needs a credential; it exits non-zero if any tile
failed, so a partial survey cannot be mistaken for a complete one.

`npm run test` runs the suite (Node's built-in runner). The CAP tests validate the emitted
XML against the official OASIS schema with `xmllint`, so that binary needs to be present
for those to run; they skip cleanly if it is not.

### Deepfire credentials

The API issues a token from a `client_id` / `client_secret` pair rather than a static key:

```bash
curl -s -X POST "https://api.deepfire.co/v1/token" \
  -H "Content-Type: application/json" \
  -d "{\"client_id\": \"$DEEPFIRE_CLIENT_ID\", \"client_secret\": \"$DEEPFIRE_CLIENT_SECRET\"}"
```

The response carries `access_token`, `token_type: "Bearer"` and `expires_in` — about 180
days, with no refresh token, so re-exchange the same credentials when it lapses. Put both
values in `.env` (gitignored) and send the token as `Authorization: Bearer …`. Scripts
reading `.env` directly should note the values may be quoted there.

## Data pipeline

Use [`tools/next_run/README.md`](tools/next_run/README.md) for the corrected extraction,
weather joins, masked labels, isolated evaluation roles, and training commands.
Run Python checks from the repository root:

```bash
python -m pip install -r tools/next_run/requirements.txt
python -m pytest tools/next_run/test_next_run.py tools/pipeline -q
```

`tools/pipeline/` and `data/wildfire-spread/` retain the historical Iberian experiment
for audit. They are not the next training dataset. Legacy build/scoring commands
require `--legacy-reproduction`; see [`docs/growth-baselines-AP.md`](docs/growth-baselines-AP.md)
for the old numbers and their limitations. Do not mix their shards with `tools/next_run`.
