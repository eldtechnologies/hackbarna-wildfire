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
```

`bun run test` runs the suite (Node's built-in runner). The CAP tests validate the emitted
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
