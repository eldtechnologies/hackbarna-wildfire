# Three work streams

Proposal · 19 Sep 2026 · for the three of us

## What we are building

An alert-first product: **hotspot → road cut → last safe departure → CAP package.** The unit of
analysis is time-of-arrival, and the output is an artifact a 112 coordinator can send, not a map.

The console is the surface that shows it. This is the direction both the spike
(`last-safe-departure.md`) and the model proposal point at, and it is the one that answers the
challenge's own wording — perimeters, direction, movement.

## The split

| Stream | Owns | Produces |
| --- | --- | --- |
| **1 — Console and integration** | `src/`, the open PRs, the demo | The surface a coordinator watches |
| **2 — Egress engine** | `server/engine/`, `server/reach.ts`, the engine routes | Road cut times, last safe departure, the CAP package |
| **3 — Model** | `server/model/`, the training pipeline, `data/model/` | Direction and rate per cluster, with its baselines |

Stream 3 runs in parallel from the start — the training is the long pole and does not block the
other two.

## The frozen interfaces — first hour, all three together

Three type-only files under `shared/`, written together and then frozen. They are the contract
that lets three people work without waiting on each other.

| File | Contains |
| --- | --- |
| `shared/egress.ts` | road segment, cut time, pocket, egress result, last safe departure, confidence band |
| `shared/alerts.ts` | alert package, CAP message, instruction, language, ledger entry |
| `shared/growth.ts` | growth vector, and the baseline results returned beside it |

Match the convention already in `shared/fires.ts`: type-only, ISO strings and never `Date`,
`LatLon` objects and no GeoJSON inside the app, ids as strings.

**Then each engine stream publishes a stub endpoint returning fixture data in the frozen shape
on day one.** Stream 1 builds the client against those stubs immediately. This is the whole
trick — without it, stream 1 waits on stream 2 and two-thirds of the team idles.

## Stream 1 — Console and integration

**1. Unify the seams, then merge.** This lands on `main` before anything else and before the open
PRs go in. Four PRs are in flight and they collide: three incompatible visibility-listener APIs,
two `initHud` return contracts, three overlapping fire visualisations, four click handlers on one
canvas, and up to three concurrent `/api/fires` fetches.

- One visibility-listener API in the layer registry — `(id, visible) => disposer` from PR #10,
  which generalises what #8 and #9 each invented.
- One `HudHandle` with a single badge setter. Drop the hardcoded `REPLAY` badge.
- One `fires` store and one `cursor` owned by the entry module, subscribed to by every layer and
  panel. This kills the triple-fetch and makes the replay clock a property of the app rather than
  of one layer.
- One pick router dispatching by id prefix, replacing four independent handlers that all fire on
  the same click.
- Merge order **#11 → #10 → #8 → #9**, keeping #9's cluster rectangles over #10's duplicate
  cluster markers. #11 goes first because it sets the time convention everything else adopts.

**2. Lock the time convention: `?at=<seconds>`.** PR #11 adds `GET /api/fires?at=<seconds>` and a
`ReplayTimeline` to the shared types — event-timeline seconds from the start of a recording, not
an ISO timestamp. Adopt that exact convention for the engine routes (`/api/egress?at=`,
`/api/alerts?at=`) rather than inventing a second one. One cursor, one unit, everywhere.

**3. Replay with a clock.** The server half exists in PR #11; the work here is the scrubber UI and
propagating the cursor to the engine endpoints, so scrubbing moves the road cut and the alert
package together with the fire. Its recording tooling also lets us capture a real session into a
multi-frame snapshot and rehearse against it.

**4. Layers and panels.** Cut-time field over the road network; pocket report showing departure
time per route with its band; alert package panel with the CAP download.

**5. Live panel.** The ensemble path on a currently active Iberian cluster — `clusterId` with
`ensembleMembers`. Max two simulations concurrent, so pre-warm and cache.

**6. Demo.** Rehearse timed. Record the video at H32.

## Stream 2 — Egress engine

Everything lives in `server/engine/`, and consumes `getFires()` from the existing provider layer
so `DATA_MODE` and the live→replay fallback are inherited rather than rebuilt.

Every engine route takes the same `?at=<seconds>` cursor as `/api/fires`, so one scrubber drives
the fire, the road cut and the alert package together. Endpoints return the cursor time they
actually answered for, since frame selection is "at or before".

**1. Graph.** Directed road graph from the local Overpass instance, **cached to disk as JSON** so
the demo never depends on the container being up.

**2. Mask and cut times.** Build a per-timestep fire mask from detections, buffered by *sensor
footprint* — MTG around 1 km, VIIRS 375 m. A segment is cut at the first timestep whose
accumulated mask intersects it.

This replaces the point-radius cut, which is the single biggest weakness in the spike: the same
exit road "closed" at 19:38, 21:18 or 00:03 depending on the buffer radius and sensor mix. A
sensor-calibrated accumulated mask removes the arbitrary parameter — and it is what makes a
defensible confidence band possible at all.

**3. Egress.** Pockets from Catastro footprints, tiled in ~500 m boxes, with INE padrón
population. Walk forward over the graph to get last safe departure per pocket per route.

Acceptance is the spike's own missing test: **one complete Bédar scenario** — population and
vehicle-demand ranges, a directed graph, and a calculation showing how long the population takes
to clear each bottleneck and when no feasible route remains.

**4. The package.** Pre-approved phrasings per instruction and language; CAP 1.2 XML emission;
deterministic OSM name and passability checks; and a **visible rejection log**. The rejection log
is the anti-hallucination story and the first thing anyone will probe.

**5. Reach.** OpenCelliD tower positions to served footprints, producing the over-alerting
numbers — the "6,200 versus 2,100" comparison.

**6. Ledger.** Append-only record of every recommendation with its evidence and timestamp.

**7. Nice-to-haves** in the cut order below.

## Stream 3 — Model

Runs in parallel from the first hour. Full reasoning is in the cluster growth vector proposal,
open alongside this document.

**1. Pull — start now.** Deepfire hotspots, Iberia bbox, January 2025 onward, paginated. This is
the long pole and it costs nothing to run in the background while the rest is built.

**2. Labels and features.** Displacement between consecutive detection windows. Carry detection
count, age and sensor mix as features so the model learns the sampling artefact rather than
absorbing it as fire behaviour.

**3. Baselines first.** Persistence and wind-drift, both a few lines, built before any training.

**4. Train.** Gradient boosting over tabular features — minutes on CPU, no GPU rental needed. Pin
Python 3.12 in a `uv` venv; 3.14 wheels for xgboost and lightgbm are a coin flip.

**5. Serve.** `GET /api/growth?clusterId=`, returning the baseline numbers beside the model's. If
the model does not beat persistence, we ship persistence and report both — that is a real
accuracy result and a better answer to the accuracy criterion than an unvalidated simulator.

**Optional upgrade:** SEVIRI FRP gives 15-minute fire detections back to 2004, against the
Deepfire archive's uneven cadence. Worth checking whether it is reachable through the LSA SAF
channel already used for MTG before treating a key as a blocker.

## Sequence

| Window | What |
| --- | --- |
| H0–2 | Together: freeze the three shared type files. Stream 1 lands the unification refactor. Streams 2 and 3 publish their stub endpoints. |
| H2+ | Parallel, each stream against the frozen contracts. |
| H12 | The spike's own end-to-end test: hotspot → road cut → one CAP file. |
| H32 | Record the demo video. |
| H38 | Freeze. Nothing new lands after. |

## Scope and cut order

The scope runs through the spike's nice-to-have tier, which is larger than the window. The tiers
are the execution rule, not a menu.

**Drop from 19 downward. Items 6 and 7 come last** — evacuation-difficulty class and route
usability class change what the egress model computes rather than how it looks, so they are worth
more than anything above them.

If the must-haves are at risk, fall back to the replay alone, presented honestly as a
retrospective analysis. That still demonstrates the insight and still beats a dashboard.

## Verification

There is no test framework today; `npm run typecheck` is the only gate. Add `node --test` — built
into Node 26, no new dependencies — for the pure functions: cut times, egress, CAP escaping, mask
accumulation.

End to end, in order:

1. `npm run typecheck` after every phase. It is strict across both projects.
2. `npm test` for the pure functions.
3. One `/api/fires` request per page load, and a layer checkbox that actually changes the render.
4. Scrub the replay to 2026-07-09 19:38 CEST and confirm the Bédar exit road shows as cut; scrub
   to 17:00 and confirm it does not. That is the spike's falsification test, run against the
   product rather than a notebook.
5. Validate the emitted CAP file against the CAP 1.2 XSD — not merely "it is XML".
6. `/api/growth` returns the baselines beside the model's numbers, held out by fire, not by time.

## One thing to say out loud, early

Authority sits with the CCAA 112 centres under Ley 17/2015 Art. 12.4, and Deepfire's own docs say
their perimeters are estimates and not authoritative for safety purposes. We are building decision
support for coordinators, never a public-facing alerting authority. Saying it before we are asked
reads as operational maturity; being asked reads as a gap.
