# Three work streams

Proposal · 19 Sep 2026 · for the three of us

## What we are building

An alert-first product: **hotspot → road cut → last safe departure → CAP package.** The unit of
analysis is time-of-arrival, and the output is an artifact a 112 coordinator can send, not a map.

The console is the surface that shows it. This is the direction the spike (`last-safe-departure.md`)
and the model proposal both point at, and it is the one that answers the challenge's own wording —
perimeters, direction, movement.

## Who owns what

| Stream | Owner | Owns | Produces |
| --- | --- | --- | --- |
| **1 — Console and integration** | Magnus | `src/`, the open PRs, the demo | The surface a coordinator watches |
| **2 — Egress engine** | Daniel | `server/engine/`, `server/reach.ts`, the engine routes | Road cut times, last safe departure, the CAP package |
| **3 — Model and validation** | Ola | The training pipeline on the data box, `server/model/` | Measured baselines with their error bars, and a model only if it beats them |

## The decisions

Recorded here so nobody re-litigates them at hour 30.

| # | Decision |
| --- | --- |
| 1 | **The Deepfire client is rewritten first — item 0, before any merge.** It currently points at `api.deepfire.example.com` and expects flat fields; every engine module sits on it. Ola authors it with a working key, Magnus reviews and merges |
| 2 | **Stream 3 is harness-first and the baseline is the shipped answer.** A model ships only if it beats the baseline on the harness |
| 3 | **Ola's machine is the data box.** Stream 3 runs there; only the model artefact, its metrics and small fixture JSON cross back |
| 4 | **The 600-day hotspot archive pull is dropped.** The labels it existed to manufacture already exist as PT-FireSprd and FireSpread_MedEU |
| 5 | **The cut mask is hotspots + MTG + SEVIRI, sensor-footprint buffered, minus `deepfire:static-heat-sources`.** SEVIRI joined once its pixels were measured at ~3.1–4.2 km across rather than 12 km |
| 6 | **Last safe departure is a band, not a time**, swept over an assumption set printed beside every number |
| 7 | **The road graph comes from the OSM `/map` API, bbox only** — one tiled, rate-limited fetch, committed to JSON so the demo never depends on the network or the container. Amended 2026-09-20: the local Overpass it named is gone — nothing listens on `127.0.0.1:12345`, no `opdb` volume exists, and `/tmp/df/osm/andalucia.osm.pbf` is absent — and the committed graph records `api.openstreetmap.org` as its source. Geofabrik's andalucia PBF stays the fallback if the bbox ever widens |
| 8 | **The unification refactor lands on `main` first**, then each open branch rebases onto it — one conflict resolution per branch, done once |
| 9 | **The falsification test is re-run with the calibrated mask**, and whatever it shows goes on the slide |
| 10 | **CAP is one `<alert>` per pocket, one `<info>` per language.** Sender, status and scope are configurable, defaulting to a fictional demo sender with `status=Test`, `scope=Private` |
| 11 | **The harness tests both targets** — bearing/rate and burned area — so we can say which quantity a model helps with |
| 12 | **The July replay snapshot is recorded with the replay tooling** once item 0 lands, so the two validate each other |
| 13 | **Jev is out of scope.** The verification gate is deterministic OSM checks with a visible rejection log |
| 14 | **The live panel is best-effort; the replay is the spine** of the four minutes |
| 15 | **The foundation window is H0–4**, not H0–2 |
| 16 | **Scope is unchanged for now.** The added work is absorbed and re-cut at the H12 gate against real evidence |
| 17 | **The model proposal is updated rather than closed**, so it stops contradicting this plan while keeping the Jev check and the drift caveats it documents |

## The frozen interfaces

`shared/egress.ts`, `shared/alerts.ts` and `shared/growth.ts` are drafted in this PR. The H0–4
session ratifies them rather than authoring them from a blank page; three people writing a contract
from scratch under time pressure produce three different mental models.

They follow the convention already in `shared/fires.ts`: type-only, ISO strings and never `Date`,
`LatLon` objects and no GeoJSON inside the app, ids as strings.

**Until the freeze, treat them as proposal, not contract** — but treat them as the thing to argue
with, because everything else depends on them.

**Then each engine stream publishes a stub endpoint returning fixture data in the frozen shape.**
Stream 1 builds the client against those immediately. Without this, Stream 1 waits on Stream 2 and
two-thirds of the team idles.

## Stream 1 — Console and integration

**Item 0. Rewrite the Deepfire client.** It has never been pointed at the real API — the endpoint
default is a placeholder domain, and the normalizer expects flat `latitude`/`longitude`/`frp`/
`acq_datetime` fields against an API that returns OGC Feature collections with GeoJSON geometry and
`fire_radiative_power`. Four defects fall out of the same file: the confidence map's keys are
lowercase so every value silently becomes 0.5; clusters are read for fields the real API does not
have, so membership has to come from each hotspot's `cluster_id`; the bbox helper returns infinities
for empty input; and there is no `active` filter, so the globe would render every detection since
January 2025 rather than the live fire. Missing FRP must stay `null`, never `0`.

This is server-side, self-contained, and unblocks the console, the engine and the live panel at
once. It also makes the July snapshot recording possible, which is what validates it.

**Ola authors it and the Los Gallardos snapshot, Magnus reviews and merges.** The key and the
corrected shapes are already there, and the snapshot travelling in the same PR is what makes the
fix demonstrably working rather than merely merged. Magnus keeps the refactor and the merge order,
so this does not move ownership of the console.

**Then unify the seams and merge.** Four branches are in flight and they collide: three incompatible
visibility-listener APIs, two `initHud` return contracts, three overlapping fire visualisations,
four click handlers on one canvas, and up to three concurrent `/api/fires` fetches.

- One visibility-listener API — `(id, visible) => disposer` from PR #10, which generalises what #8
  and #9 each invented.
- One `HudHandle` with a single badge setter. Drop the hardcoded `REPLAY` badge.
- One `fires` store and one cursor owned by the entry module, subscribed to by every layer and
  panel. This kills the triple-fetch and makes the replay clock an app property.
- One pick router dispatching by id prefix, replacing four handlers that all fire on the same click.
- Rebase order **#11 → #10 → #8 → #9**, keeping #9's cluster rectangles over #10's duplicate
  markers. #11 first because it sets the time convention.

**Lock the time convention: `?at=<seconds>`.** PR #11 adds `GET /api/fires?at=<seconds>` and a
`ReplayTimeline` — event-timeline seconds, not an ISO timestamp. Engine routes adopt the same
parameter rather than inventing a second one. One cursor, one unit, everywhere.

**Then the panels.** Cut-time field over the road network; pocket report showing the departure band
per route with its assumptions; alert package panel with the CAP download and the rejection log.

**Live panel last, best-effort.** A currently active cluster with a cluster-ignition ensemble, max
two concurrent, so pre-warm and cache. The demo is designed to stand without it.

## Stream 2 — Egress engine

Everything lives in `server/engine/`, consuming `getFires()` from the provider layer so `DATA_MODE`
and the live→replay fallback are inherited.

**Graph.** One tiled, rate-limited fetch from the OSM `/map` API over a bbox around Los Gallardos
and Bédar, committed to `data/graph/` as JSON. Small, fast to rebuild, and the demo never depends on
the network or the container running. Geofabrik's andalucia PBF (194 MB, verified) is the documented
fallback if the bbox ever widens.

**Mask and cut times.** Accumulate Deepfire hotspots, the MTG archive and the SEVIRI series, each
buffered by *sensor footprint* — MTG around 1 km, VIIRS 375 m, SEVIRI 3.1–4.2 km — after
**subtracting `deepfire:static-heat-sources`**. That subtraction is not optional: the archive
carries persistent industrial heat, including cells around 18 MW within about 20 km of Gallardos,
and a mask built from raw detections would cut a road on a gas flare.

Three sensors means three footprints and three latencies in the sweep, which widens the band. That
is the honest result rather than a problem: SEVIRI rarely sets a cut time on a small fire — on
Gallardos it starts about three hours after MTG and stops seven hours before it — so it mostly
covers gaps and widens the estimate. The band is what ships, so a wider one that is true beats a
narrow one that is not.

A segment is cut at the first timestep whose accumulated mask intersects it. This replaces the
point-radius cut that read 19:38, 21:18 or 00:03 for the same road depending on buffer and sensor
mix — the spike's central weakness, and the reason a defensible band is possible at all.

**Egress.** Pockets from Catastro footprints tiled in ~500 m boxes, with INE padrón population.
Walk forward over the graph to get a departure band per pocket per route. The unknowns — mobile
fraction, departure delay, vehicle occupancy, speed by road class — are swept, and the assumption
set is returned with the response and printed beside every number.

Acceptance is the spike's own missing test: one complete Bédar scenario, showing how long the
population takes to clear each bottleneck and when no feasible route remains.

**The package.** Pre-approved phrasings per instruction and language; one `<alert>` per pocket with
one `<info>` per language; CAP 1.2 XML; deterministic OSM name and passability checks; and a
**visible rejection log**, which is the anti-hallucination story and the first thing anyone probes.

**Reach.** OpenCelliD towers to served footprints, producing the over-alerting numbers — the
"6,200 versus 2,100" comparison.

**Ledger.** Append-only record of every recommendation with its evidence and the cursor time.

## Stream 3 — Model and validation

Runs on the data box from the first hour and never blocks the other two.

**1. The harness, both targets.** Leave-one-event-out over PT-FireSprd and FireSpread_MedEU,
scoring burned area *and* bearing/rate. The review measured constant-ROS beating a learned model on
area (R² 0.992 against 0.862), but that is a different quantity from the one the Monitoring track
asks for, so the direction claim gets tested rather than assumed.

**2. Baselines first.** Persistence — same bearing, same rate — and constant rate of spread, built
and scored before anything is trained.

**3. Train opportunistically.** Gradient boosting over tabular features. Note that `lightgbm` is
not viable in this environment; `sklearn.ensemble.HistGradientBoostingClassifier` is the same
family without the OpenMP dependency.

**4. Serve.** `GET /api/growth?clusterId=` returns the baseline beside the model's numbers, both
held out by **fire, not by time**, with `shippedBaseline` saying which one is on screen. A measured
"persistence wins, here is its error" is a stronger answer to the accuracy criterion than a model
that loses and is not reported.

## Foundation window — H0–4

| What | Who |
| --- | --- |
| Ratify the three shared type files | All three |
| Item 0 — the Deepfire client and the July snapshot | Ola, reviewed by Magnus |
| The unification refactor on `main` | Magnus |
| Stub endpoints in the frozen shapes | Daniel |
| Harness scaffolding on the data box | Ola |

Stream 3 is independent of the others and starts immediately regardless — its work happens on
another machine.

## Scope and cut order

Scope is unchanged; the added work is absorbed. Re-cut at the H12 gate, against evidence about what
is actually slow rather than against a guess made now.

When the cut comes, **drop from 19 downward, and items 6 and 7 come last** — evacuation-difficulty
class and route usability class change what the egress model computes rather than how it looks.

If the must-haves are at risk, fall back to the replay alone, presented honestly as a retrospective
analysis. That still demonstrates the insight and still beats a dashboard.

## Verification

There is no test framework; `npm run typecheck` is the only gate. Add `node --test` — built into
Node 26, no new dependencies — for the pure functions: cut times, egress, CAP escaping, mask
accumulation, and the OSM name resolver.

End to end, in order:

1. `npm run typecheck` after every phase. It is strict across both projects.
2. `npm test` for the pure functions.
3. One `/api/fires` request per page load, and a layer checkbox that actually changes the render.
4. Scrub the replay to 2026-07-09 19:38 CEST and confirm the Bédar exit road shows as cut; scrub to
   17:00 and confirm it does not. That is the spike's falsification test run against the product.
5. Validate the emitted CAP against the CAP 1.2 XSD — not merely "it is XML".
6. `/api/growth` returns baselines beside the model's numbers, held out by fire.

## Open

- **Whether a model beats the baselines on bearing and rate.** The harness will say. Until it does,
  the baseline is what ships.
- **How much the SEVIRI band actually widens.** Its per-sensor timing on Gallardos is known; whether
  that holds across the other events belongs in the calibration sweep, because it moves the band
  more than it moves the mean.

## One thing to say out loud, early

Authority sits with the CCAA 112 centres under Ley 17/2015 Art. 12.4, and Deepfire's own docs say
their perimeters are estimates and not authoritative for safety purposes. We are building decision
support for coordinators, never a public-facing alerting authority. Saying it before we are asked
reads as operational maturity; being asked reads as a gap.
