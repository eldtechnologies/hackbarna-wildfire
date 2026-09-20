# HTTP API reference

The server is an Express proxy on `http://127.0.0.1:3001` by default (`PORT`, `HOST`). It has
thirteen routes, all `GET`. There is no authentication, no rate limiting and no request body;
the only thing keeping the surface private is that it binds loopback, since `/api/fires` spends
Deepfire quota and a cut-time solve costs a couple of hundred milliseconds of the event loop.

The console calls four of the thirteen. The other nine answer over HTTP with no console surface
yet.

| Route | Console |
|---|---|
| `GET /api/fires` | yes |
| `GET /api/infrastructure` | yes |
| `GET /api/threats` | yes |
| `GET /api/situation` | yes |
| `GET /api/health` | no |
| `GET /api/growth` | no |
| `GET /api/forecasts` | no |
| `GET /api/egress` | no |
| `GET /api/egress/field` | no |
| `GET /api/reach` | no |
| `GET /api/alerts` | no |
| `GET /api/cap/:pocketId` | no |
| `GET /api/ledger` | no |

## Conventions

**Errors** are `{"error": "<message>"}` with a 4xx or 5xx status. An unknown path under `/api/`
returns Express's default HTML 404, not that shape.

**Provenance.** Every response that carries fire data names the source that actually served it:
`"replay"` or `"live"`. The console renders this as the LIVE/REPLAY badge. When live mode fails
for any reason the provider falls back to replay and the response says `replay`, so the badge
never claims live data that did not arrive.

**Timestamps are ISO 8601 with an explicit zone, and the JSON responses are UTC.** The CAP XML is
the exception: it carries the local offset CAP 1.2 expects (`+02:00` for this scenario), so parse
it as an offset timestamp rather than assuming `Z`.

A quantity the source did not supply is `null`, never a synthesized number — a null fire radiative
power means "not measured", a zero means "measured zero".

### The `?source=` selector

`/api/fires`, `/api/threats`, `/api/situation` and `/api/growth` accept an optional
`source=live|replay|configured`. Selection is local to each request; it does not change the
server default or another browser. `replay` always selects Los Gallardos; `configured` uses
`REPLAY_SNAPSHOT`. An absent source uses the server's configured default. Invalid values
return `400`.

Fire responses include `requestedSource` and `source`. A live failure returns
`requestedSource: "live"`, `source: "replay"`, and `fallbackReason: "live_unavailable"`.
The live request deadline is eight seconds; fallback always uses the pinned real capture.
These fields travel with the cursor, so reports and the map use the same evidence.

### The `?at=` cursor

Seven routes take `at`, in seconds since the scenario origin. It is the same cursor the console's
timeline scrubber drives, so the globe and the analysis agree on what time it is.

- Absent or empty (`?at=`) selects the live edge — the latest frame of a recording, or the full
  capture for a flat snapshot.
- The value must match `^\d+$`. Anything else is `400`, including `?at=-5`, `?at=1.5` and a
  repeated parameter (`?at[]=1`). Malformed cursors are refused rather than silently served as
  the latest state.
- `at` above `253402300799` is `400`.
- A valid `at` past the end of the timeline clamps to the last frame. That is not an error.
- The ceiling is a guard, not a promise that the whole range is usable. It exists so a date in a
  CAP document (Common Alerting Protocol, the XML format emergency-management systems exchange)
  stays inside the four-digit years that format allows. But the value it accepts resolves to the
  year 10056, and `/api/cap` validates the document it emits, so **the largest accepted cursor
  returns `502`** rather than a package:

  ```
  $ curl -s "localhost:3001/api/cap/bedar?at=253402300799"
  {"error":"CAP document failed validation","problems":["<sent> \"10056-07-08T01:59:59+02:00\" does not match the CAP date pattern",...]}
  ```

  `/api/egress` and `/api/alerts` accept the same cursor and answer `200`, but their `at` and
  `origin` fields carry the same five-digit year. Treat anything near the ceiling as out of range.

The cursor is not a wall clock and not a "give me the data as of this date" filter. Under causal
replay an observation appears only once its delivery time has passed, so on the default capture
`?at=0` returns no hotspots at all (nothing has been delivered yet), `?at=100000` returns 460,
and the live edge returns all 2,743. The delivery assumptions behind that are in
[Data modes and snapshots](../README.md#data-modes-and-snapshots).

`/api/egress/field` and `/api/reach` take no cursor: both are whole-window properties rather than
per-moment ones, and an `at` passed to them is ignored.

## Console API

### `GET /api/fires`

The fire picture: hotspots, clusters, observed perimeters and any spread projection, filtered to
what was in hand at the cursor.

Query: `at`, `source` (both optional).

Returns `source`, `requestedSource`, optional `fallbackReason`, `provenance`, `fetchedAt`,
`scenario`, `asOf`, `availability`, `timeline`, `hotspots`,
`clusters`, `perimeters`, `spread`.

`timeline` carries `start`, `end`, `durationSeconds` and the `frames` array, so a client can build
a scrubber without knowing the scenario in advance. `asOf` is the evidence time the response
resolved, which is not necessarily the cursor you asked for.

`400` malformed cursor · `502` fire data unavailable (no snapshot matched, or live failed and
replay failed too).

Served from a 5-second memo keyed on source and cursor, with identical concurrent requests sharing one
upstream fetch.

### `GET /api/infrastructure`

The bundled assets: hospitals, schools, towns and power lines.

Query: none.

Returns `status` (`state` of `available` / `partial` / `unavailable`, plus `loadedFiles`,
`failedFiles` and `rejectedFeatures`), `assets` and `powerLinePaths`.

A missing or unparseable GeoJSON file degrades `status.state` rather than failing the request, so
a partial bundle is visible in the response instead of looking like an empty region.

`assets` carries all 8,079 features in the committed bundle: 6,523 points (80 hospitals, 4,895
schools, 1,548 towns) and 1,556 power lines. The line assets appear in `assets` as well as in
`powerLinePaths`, which is the id-keyed lookup for their geometry — so do not read `assets` as
points only, and do not add the two arrays together.

The bundle spans two regions that are not equally good, described by `INFRASTRUCTURE_COVERAGE`
and `ALMERIA_COVERAGE` in `server/infrastructure.ts`: Catalonia from Generalitat open data, and
eastern Almería from an OpenStreetMap snapshot taken 18 September 2026. Only the Catalonia region
is an administrative inventory.

`502` infrastructure data unavailable. Nothing a request can supply reaches that path: the loader
degrades every malformed or missing file into a `200` with `status.state` of `partial` or
`unavailable`, which is the behaviour to code against. The `502` covers a fault inside
`getInfrastructure` itself, and because the loader promise is memoised for the process lifetime,
such a rejection latches — the route keeps answering `502` until restart.

Read once per process.

### `GET /api/threats`

Proximity analysis for one fire: every asset inside the perimeter, inside the 5/10/20 km rings, or
inside the projected spread corridor.

Query: `fireId` (required), `at`, `source` (optional).

Returns `fireId`, `infrastructureStatus`, `infrastructureCoverage`, `hasPerimeter`, `rings`,
`threatened`, `corridorCount`, `computedAt`.

`rings` always lists all four bands (`inside`, `ring-5km`, `ring-10km`, `ring-20km`) whether or
not any asset falls in them, so a reader can tell "no assets in this ring" from "this ring was
not evaluated". Results are sorted innermost ring first, then by distance. Power lines are
sampled every 500 m along their length, so a span crossing a ring is not missed between vertices.

`infrastructureCoverage` names the region the answer came from, as `{label, bbox}` plus a `note`
on the Almería region recording that its OSM snapshot is not a historical inventory and that
mapped assets may be incomplete. It is `null` only when the fire falls outside both regions, which
is a different statement from an empty threat list — so "nothing near this fire" can never be
confused with "we hold no data here".

`400` missing `fireId` or malformed cursor · `404` unknown `fireId` · `502` threat analysis
unavailable.

Cached for 60 seconds against a hash of the fire's *geometry* — provenance, scenario, the cluster,
its perimeters and its future spread steps. Transport timestamps and cursor spellings do not
invalidate the entry, so refetching the same fire at a different cursor reuses the work.

### `GET /api/situation`

The situation report: server-rendered facts, deterministic proximity priorities, and an optional
model that may only order them.

Query: `fireId` (required), `at`, `source` (optional).

Returns `fireId`, `summary`, `recommendations`, `narrator`, `packet`.

`packet` is the authoritative record — hotspot count, FRP sum, first and last detection, perimeter
area and observation time, spread bearing and compass, threat list, coverage and availability
policy. `summary` and `recommendations` are prose derived from it. Every number the console
renders comes from `packet`, never from the model.

`narrator` is `"template"` or `"llm"`. `"llm"` means a chat-completions model returned an ordering
of the supplied fact IDs; it never writes factual prose. Invalid, missing, duplicate or invented
IDs fall back to `"template"`. With no `LLM_API_KEY` the endpoint answers without a model call.

`400` missing `fireId` or malformed cursor · `404` unknown `fireId` · `502` situation analysis
unavailable.

## Analysis API

### `GET /api/health`

Liveness. Query: none. Always `200`.

```json
{"status":"ok","service":"ojo-de-fuego","mode":"replay","time":"2026-09-20T09:46:05.155Z"}
```

`mode` is read from the environment at request time, while the provider captures `DATA_MODE` at
module load. If you change the variable under a running server the two can disagree; the badge on
`/api/fires` reports what actually served the data.

### `GET /api/growth`

Descriptive motion of a fire's detection centroid, beside two offline corpus baselines.

Query: `clusterId` (required), `at`, `source` (optional).

Returns `clusterId`, `at`, `provenance`, `scenario`, `target`, `validation`, `roadUse`,
`availabilityPolicy`, `evidenceWindowHours`, `model`, `baselines`, `scores`, `scoreScope`,
`shippedBaseline`, `shipped`.

Read the labels, not just the numbers. `validation` is `diagnostic_only` and `roadUse` is
`unsupported`: the returned vector does not validate fire-front arrival and must not be converted
into a road-cut time. `scoreScope` is `offline_corpus_baselines`, meaning the scores describe the
corpora, not this online estimator. `shipped` names which predictor is being served; today that
is `persistence`, with `model: null`, because the learned model beats persistence on rate R² but
is worse on bearing error in both corpora. See
[stream3-baselines.md](stream3-baselines.md).

Motion uses only the past six hours, splits at a temporal midpoint so simultaneous observations
stay together, and requires at least 30 minutes between weighted time centroids. Sparse or
coincident observations yield a null direction and rate.

`400` missing or non-string `clusterId` · `404` unknown cluster · `502` corrupt metrics file.

### `GET /api/forecasts`

Prepared native-grid thermal forecasts.

Query: none, or `eventId` **and** `issue` together.

With neither, returns the target and the list of prepared event/issue pairs:

```json
{"target":"observed_thermal_detection_within_horizon","forecasts":[{"eventId":"f2236085fb7b93e9ff94261e","issuedAt":"2026-07-01T11:00:00+00:00"}]}
```

With both, returns one validated artifact. Its `predictor`, `status`, `deployment` and `roadUse`
travel with it: the committed example is a `persistence` fallback with
`fallbackReason: "no_accepted_checkpoint"`, `deployment: "research_only"` and
`roadUse: "unsupported"`. The target is *an observed thermal detection somewhere in each future
1/3/6-hour window* — not a perimeter, not a road-arrival time. `identity` binds seven SHA-256
values covering the dataset manifest, the input bytes, the checkpoint and the inference code, and
a checksum mismatch is a `502` rather than a silently different forecast.

`400` only one of the two parameters, or a non-timezone-qualified `issue` · `404` no prepared
forecast for that pair · `502` oversized, invalid or corrupt artifact.

With `FORECAST_DIR` unset the list is empty and a lookup is a `404` — never an error, and never a
fallback to a different issue time. Set `FORECAST_DIR=data/forecasts/example` to serve the
committed example.

## Engine API

The egress engine answers a different question from the console: not where the fire is, but when
the road out closes and whether a village can still leave. It reads the committed road graph,
Catastro footprints, INE population, the July capture and the static-heat fixture once per
process; the cold build takes seconds and each solve a couple of hundred milliseconds.

### `GET /api/egress`

Pockets, the routes out of each, and the last-safe-departure band per route.

Query: `at` (optional).

Returns `provenance`, `at`, `origin`, `scenario`, `windowEnd`, `assumptions`, `sensorFamilies`,
`unattributedCutSegments`, `profiles`, `configurations`, `fireId`, `clusterIds`, `detections`,
`segments`, `totalSegments`, `pockets`, `fetchedAt`.

`segments` holds **cut segments only** — a segment the fire never reaches is absent from the
array, not present with a null `cutAt`. That is why `segments` is shorter than `totalSegments`
(4,225 of 29,834 over the committed capture), and it is why a null check on `cutAt` finds nothing
to match.

Departure and cut times are reported as a range rather than a single time. The same road reads
19:38 CEST or 00:03 CEST depending on which sensors you trust and how wide you draw their
footprints, and a point estimate would hide that choice. So the engine sweeps twelve sensor
configurations (`all-1x`, `all-0.5x`, `all-2x`, `geopolar-1x`, …) against two assumption profiles
(`cautious`, `optimistic`) — twenty-four solves — and reports the envelope, naming the
configuration behind each end.

`sensorFamilies` reports what each family contributed, including the families that contributed
nothing, so a missing instrument is visible in the answer rather than only in the source. Over the
committed July capture: 2,660 detections, 4,225 cut segments of 29,834.

**Two different nulls live in this response, and they mean opposite things.**

- A `lastSafeDeparture` that is itself `null` means the route **is already cut** at this cursor —
  the worst case. `server/engine/egress.ts` sets it when the band's earliest departure has already
  passed.
- A `latest` that is `null` *inside* a band means the opposite: no combination of configuration
  and assumption profile closes that route inside the modelled window, so there is no upper bound.
  That is the **safest** state.

Every Bédar route reads the second way over the committed capture. The inner field is nullable
precisely because a consumer that read it as "already cut" would invert the safest result into the
most alarming one. `basis` on every band names what was swept, so the number never travels without
its assumptions.

`400` malformed cursor · `502` egress solve unavailable. Engine faults are deliberately `502`, not
`400`: a failure here is the engine's, not the caller's.

Each route takes the `?at=` cursor; `origin` is published because the console's globe and this
engine resolve their origins independently and a client should compare them rather than assume
they agree.

Memoised per cursor in a 256-entry map.

### `GET /api/egress/field`

The cut-time field over the road network. Cursor-independent — fetch it once.

Query: none (an `at` is ignored).

Returns `provenance`, `origin`, `scenario`, `assumptions`, `profiles`, `sensorFamilies`,
`unattributedCutSegments`, `segments` (cut segments only) and `totalSegments`.

`502` cut field unavailable.

### `GET /api/reach`

The over-alerting figure: population inside a mobile cell's served footprint for a fire that does
not reach it.

Query: none (an `at` is ignored).

Returns `source`, `fetchedAt`, `region`, `tilesRequested`, `tilesFailed`, `failures`,
`surveyScope`, `cells`, `unusable`, `measuredFraction`, `threatenedSettlementIds`,
`unusableSettlements`, `totalOverAlerted`, `unknownPopulation`, `rows`.

Over the committed survey: 625 cells from 88 requested tiles, `measuredFraction` 0.3712 — the
proportion of cells carrying a measured range rather than the operator's fallback — and
`totalOverAlerted` 12,041.

`surveyScope` states the box the cells were drawn from, so a low count reads as "few requested"
rather than "none exist". A tower outside that box whose range reaches a settlement inside it was
never requested, and the response says so. `unknownPopulation` is kept separate from zero: a
population key that is absent is unknown, not invisible.

The served footprints are a committed fixture under `data/reach/`, never a request-path call.
`OPENCELLID_TOKEN` is read only by `scripts/fetch-reach.mjs`, which exits non-zero if any tile
failed so a partial survey cannot be mistaken for a complete one.

`502` reach unavailable — including a missing, malformed or empty fixture, no usable cells, or a
threat ID absent from the settlement list.

### `GET /api/alerts`

The alert packages, the rejection log and the decision ledger for the cursor.

Query: `at` (optional).

Returns `provenance`, `at`, `cap`, `packages`, `rejected`, `ledger`, `diagnostics`.

`cap` reports the configured sender, status and scope — the default is a fictional demo sender
with `status: "Test"` and `scope: "Public"`. `packages` are the CAP packages that survived
validation; `rejected` are the candidates that did not, each with its reason, and
`incomplete_template` is separated from `no_evidence` on purpose: a phrasing that could not be
completed is a different failure from a pocket with nothing to say.

`diagnostics` carries the emitter counts per pocket and the ledger block (`store`, `appended`,
`reused`, `unreadable`, `writeFailures`, `skipped`, `full`, `unavailable`).

**This route writes.** A `GET` on `/api/alerts` appends a recommendation to the ledger unless an
entry with the same input fingerprint already exists, in which case it is reused. That is what
makes `/api/ledger` a record of what the engine advised rather than a record of what was asked
for.

A ledger that cannot be read does not fail this route: it serves without history and reports
`diagnostics.ledger.unavailable`, because a full store should not take the alert package down with
it. `/api/ledger` makes the opposite choice.

`400` malformed cursor · `502` alert package unavailable.

### `GET /api/cap/:pocketId`

One CAP 1.2 XML document for one pocket, as `application/xml; charset=utf-8`.

Path: `pocketId` — `bedar` in the committed scenario. Query: `at` (optional).

The document root is `<alert>`, so one pocket per request. Each pocket carries one `<info>` per
language, and each `<info>` names its `<language>`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<alert xmlns="urn:oasis:names:tc:emergency:cap:1.2">
  <identifier>ojo-de-fuego:bedar:20260711T110826Z:no_verified_action</identifier>
  <sender>demo@ojo-de-fuego.invalid</sender>
  <sent>2026-07-11T13:08:26+02:00</sent>
  <status>Test</status>
  <msgType>Alert</msgType>
  <source>ojo-de-fuego replay los-gallardos-2026-07-09</source>
  <scope>Public</scope>
  <info>
    <language>en</language>
    <category>Fire</category>
    <category>Safety</category>
    <event>Incendio forestal / Wildfire</event>
    <responseType>Prepare</responseType>
    <urgency>Immediate</urgency>
    <severity>Extreme</severity>
    <certainty>Possible</certainty>
    <headline>No safe route from Bédar could be verified. Await instructions from the emergency services.</headline>
    ...
```

Instruction text comes from a closed set of pre-approved phrasings; the engine selects one and
fills in names, it does not compose sentences. A pocket whose document fails the engine's own
semantic validation is a `502`, so an unvalidated document is never served as if it had passed.

`404` unknown pocket, with the available IDs in the body · `400` malformed cursor · `502` failed
validation or engine fault.

### `GET /api/ledger`

The whole recommendation history, in the order it was recorded.

Query: `limit` (optional). `limit` takes the most recent *n*; absent or empty returns all.

Returns `store` (the file's basename, never its path), `total`, `limit`, `unreadable`, `entries`.

Each entry carries `id`, `at` (the cursor the recommendation was made for), `recordedAt` (when it
was written), `pocketId`, `recommendation`, `evidence`, `inputs`, `inputFingerprint`,
`cursorSeconds` and `rejected`. The two timestamps answer different questions and are kept apart
deliberately: `at` is when the event happened, `recordedAt` is when an operator would have seen
the recommendation.

The route takes no cursor, because reading an incident should not require already knowing which
moments to ask for.

The store is append-only, capped at 16 MiB, and refuses a symlink or a non-regular file. The
server refuses to start if the ledger path is unusable rather than serving without a record of
what it advised. Default `data/ledger/recommendations.jsonl`, gitignored, created on first run.

`400` malformed `limit` · `502` recommendation history unavailable.

## Caching and bounds

| Route | Bound |
|---|---|
| `/api/fires` | 5 s memo per cursor, in-flight requests coalesced |
| `/api/infrastructure` | read once per process |
| `/api/threats` | 64 entries / 60 s, keyed on fire geometry |
| `/api/situation` | 64 orderings / 60 s; 4 s per-caller wait, 15 s provider abort, 2 concurrent provider jobs |
| `/api/forecasts` | none; index re-read per request, 4 MB index and 2 MB artifact caps |
| `/api/egress`, `/api/egress/field`, `/api/alerts`, `/api/cap/*` | 256 cursors, oldest evicted |
| `/api/reach` | none; fixture re-read per request |

There is no throttling anywhere. A solve is ~200–260 ms on the event loop and the routes are
unauthenticated, which is why `HOST` defaults to loopback. Point it at `0.0.0.0` only
deliberately.
