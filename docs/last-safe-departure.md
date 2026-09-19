# HackBarna — Wildfire: Last Safe Departure build plan

As of 2026-09-18 · spike-verified 2026-09-19 (see **Spike results** below)

HackBarna 3.0 · Norrsken House Barcelona · 19–20 September 2026 · Challenge run with Deepfire

> **This is a spike, not a study.** We ran the checks below against the live API and the real data, without a formal methodology, a held-out design, or peer review. The numbers are **what we saw when we ran the data**. They may be wrong, and some have already been corrected or withdrawn. Treat every figure as an observation, not a validated measurement. Where a result could not be reproduced, or relies on unverified steps, it is flagged inline.

## Spike results — observations from the spike (2026-09-19)

A spike ran this plan's own go/no-go tests against the live API and the real data. This is the outcome: what is feasible, what is false as written, and what is still unknown. The rest of the document is the original plan, corrected inline where the spike proved it wrong.

Every experiment behind these results — method, result and figure — is recorded in **Appendix A** at the end.

### Verified feasible

| Item | Evidence |
| --- | --- |
| Fire-spread runs in Spain | ELMFIRE and ForeFire both `COMPLETED` at Los Gallardos |
| Queue latency is not a blocker | ELMFIRE point ≤32 s; 10-member × 8 h cluster ensemble ≤3 min; ForeFire ≤4 min |
| Ensemble output | 10 members × 8 h = 80 features, each with `burn_probability` per hour |
| Historical replay data exists | 2,660 hotspots, 9–11 Jul 2026, 7 sources; **53 detections inside the 14:35–17:37 UTC evacuation window** |
| Archived perimeters exist for the July fire | 12 snapshots; first `computed_at` 2026-07-10T00:24Z (~10 h after ignition) |
| Road graph + cut times | 14,819 nodes from OSM; per-segment fire-arrival times computed |
| Road-cut field | Bédar exit road (AL-6109): first detection inside a 200 m buffer at **19:38 CEST** |
| **The road-cut test is inconclusive as a warning** | The 19:38 trigger is a single detection and the data carries no availability timestamp, so no lead time is demonstrated. Retrospective sensitivity only — see A10 |
| Independent ground truth | EFFIS burnt area **5,767 ha** (press ≈5,200) |
| Wind | ERA5: 22–25 km/h southerly, gusts 48–54 km/h, 38–40 °C, RH 10 % through the fire window |

### Not feasible as written

| Claim in this plan | Reality |
| --- | --- |
| "Ensemble spread from a real Deepfire cluster" drives the replay | **The simulation API cannot run a past date.** Unknown fields are rejected with the accepted list; there is no `asOf`, and `lookbackHours` is capped at 168. The replay must be **hotspot-driven**; the ensemble belongs to the live panel only |
| `ensembleMembers` on any ignition | **Cluster ignition only.** A point ignition silently runs 1 member |
| Ten timed runs to measure latency | **Max 2 simulations in progress** per client (`429 too-many-simulations`) |
| "You reconstruct the Jul 2026 perimeter yourself" | **Wrong — 12 perimeter snapshots exist** for that fire |
| Confidence band from ensemble spread (replay) | Impossible for a past fire. Derive it from detection geometry: VIIRS 375 m vs MTG 1 km, and overpass gaps |
| OSM as a values-at-risk source | **OSM has 3 buildings within 1 km of Bédar.** It cannot carry values-at-risk here |

### API constraints this plan did not know

- Point ignition → 1 member (forced). `sources` and `lookbackHours` apply to `clusterId` only.
- Default seeding **excludes MTG-I1** (geostationary) — a cluster sim needs `lookbackHours` long enough to cover polar detections.
- Short durations return `NO_SPREAD` ("did not spread past minimum threshold"). Use ≥6 h.
- A live collection the plan omits: **`deepfire:static-heat-sources`** (false-positive mask).
- One fire can carry **two cluster IDs** — identity needs matching.

### What the data showed that this plan does not contain

- **A 40-minute MTG gap, 16:28→17:08 UTC** — cloud, so no geostationary detection in that window. A detection gap is not evidence that the fire stopped.
- **Polar satellites alone are ~2.5 h later.** With MTG the exit road is flagged at 19:38 CEST; without it, 00:03. The 10-minute layer is what makes the earlier time possible.
- **Deepfire's perimeter is a fast operational estimate that we refine.** The final perimeter is 9,172 ha (reprojected; the raw `area_m2` field is 9,178 ha) against EFFIS's 5,767 ha reference. Fusing the two tightens the burnt-area estimate.
- **`active` is a time window** — 25 of 94 Iberian clusters have no NASA FIRMS detection within 10 km in 24 h. Read it as "recently seen" and confirm with a fresh detection.
- **The MTG archive is the strongest data asset.** A full 2026 archive (36,815 scans, 77 GB) covers the July fire with quality masks, acquisition times and file metadata. Deepfire's 1,932 MTG observations for that fire match the source files exactly — the same lineage, not independent confirmation.
- **Wind was the physical driver** — a southerly gusting 54 km/h ran the fire north into Bédar's exit road. This plan has no wind narrative.

### Still open (not verified)

- **Catastro INSPIRE building footprints** — the WFS answers `200` but rejects the bbox filter (*"No records founded for BBOX and SRS provided"*), the ATOM index path has moved, and TLS needs `-k`. **This is the values-at-risk blocker.**
- **INE padrón** — API is open; the correct operation/table is not yet identified.
- **ES-Alert second-language capability** and **Ley 17/2015 Art. 12.4** — unverified.
- **Technosylva's actual scope**, **WUIVAC/PERIL** details — unverified.
- Pending keys: **AEMET**, **OpenCelliD**, **Copernicus Data Space**, **EUMETSAT Data Store**, **TypeSafe/Jev**.

## Strategic read

Pick track 4 — the values-at-risk and evacuation-workflow track.

The challenge's "resources" link resolves to Deepfire's own platform. Docs at [docs.deepfire.co](https://docs.deepfire.co/).

### Live now

| Endpoint | What it gives you | History |
| --- | --- | --- |
| [`deepfire:hotspots`](https://docs.deepfire.co/api/hotspots) | Points with `fire_radiative_power` (MW), `confidence`, `observed_at`, `source`, `country`, `cluster_id` | Since Jan 2025 |
| [`deepfire:clusters`](https://docs.deepfire.co/api/clusters) | Candidate fires. Only `first_observed`, `last_observed`, `active`, `id`. Point geometry | Since Jan 2025 |
| [`deepfire:satellite-perimeters`](https://docs.deepfire.co/api/satellite-perimeters) | MultiPolygon snapshots with `area_m2`, `computed_at`, `observed_watermark`, `n_hotspots` | Since Jun 2026 only |
| [`/v1/fire-spread/simulations`](https://docs.deepfire.co/api/fire-spread) | ELMFIRE or ForeFire, `ensembleMembers` 1–50 (**cluster ignition only** — a point ignition runs 1), `durationHours` 1–24, one polygon per hour | Async, poll 10s, fails at 60min. **No historical date** (`asOf` rejected). **Max 2 concurrent** per client |
| [`/mcp`](https://docs.deepfire.co/ai/connect-to-ai) | MCP server, no auth. Two tools: `deepfire_search_fires`, `deepfire_get_fire` | Live |

### Marked "coming soon"

`values-at-risk` · `official-incidents` · `ml-detections`

Track 4's actual wording: *"Build an **agentic** system that identifies the infrastructure, people, and assets in danger when a fire breaks out, and helps make evacuation calls (which hospital, which school, etc.)."* Note **"agentic"** — this plan has no agent. Add one for orchestration and per-facility reasoning; keep the alert text templated.

### Free headroom inside the live API

- **Clusters carry no growth attribute.** No area, no rate. Fusing the 1 km geostationary refresh (MTG-I1 / Meteosat-12 FCI) with 375 m VIIRS precision to estimate growth *rate* rather than position is unclaimed.
- **The perimeter layer is built for speed** (`cumulative-multihull-v1` — a cumulative multi-hull over hotspots) and gives immediate, broad coverage. Fusing it with EFFIS/EMS reference outlines and fuel-aware growth tightens the burnt-area estimate.
- **`observed_watermark` vs `computed_at`** gives a measured satellite-acquisition-to-output latency (56–164 min across the 12 July perimeters).
- **Perimeters start Jun 2026, hotspots start Jan 2025.** The Jul 2026 Almería fire **does** have archived perimeters (12 snapshots, verified) — do not reconstruct it. Earlier events (the whole Aug 2025 season) you reconstruct yourself. Note the first Los Gallardos perimeter is `computed_at` 2026-07-10T00:24Z, ~10 h after ignition: no perimeter existed during the evacuation window.

### Satellites over Iberia

Of the 15 sources Deepfire ingests, GOES-18/19 and Himawari-9 are irrelevant here. What matters over Spain: VIIRS ×3 (375 m, polar), Landsat 8/9 (30 m), Sentinel-3A/B SLSTR (1 km), MetOp-B/C (1.1 km), MODIS (1 km), and for temporal density MTG-I1 FCI (nominal 1 km) and Meteosat-9/10 SEVIRI (3 km).

## The thesis

Burned area is not where people die. The road out closes before the fire reaches the house.

2025 was genuinely the record: [7,783 fires across 25 of 27 EU member states burned 1,079,538 hectares](https://joint-research-centre.ec.europa.eu/jrc-news-and-updates/2025-was-eus-most-destructive-wildfire-season-record-2026-03-31_en), nearly double the 2006–2024 average, with Germany, Spain, Cyprus and Slovakia at all-time records. A heatwave in the first three weeks of August triggered 22 very large fires in Portugal and Spain almost simultaneously, burning 460,585 hectares — 43% of the EU total.

But the deadly fire was small.

### Los Gallardos, Almería — 9 July 2026

| Fact | Value |
| --- | --- |
| Burned area | ~5,200 ha (about 1% of the Aug 2025 Iberian megafires) |
| Deaths | 14 (reported) |
| Evacuated | >1,400 |
| Reported ignition | Electrical infrastructure; cause under official investigation |
| ES-Alert sent | **No** |

How they died shapes the design brief:

- Several people died in a vehicle, and others on foot, on the way out. [Reporting](https://www.infobae.com/espana/2026/07/10/atrapados-por-el-fuego-en-pocos-minutos-el-incendio-en-los-gallardos-almeria-sorprendio-a-las-victimas-mientras-buscaban-una-salida-en-coche-o-a-pie/) describes victims caught while looking for a route that was not the planned one.
- During the evacuation of Bédar, the main exit road was blocked by fire, forcing evacuees to divert toward Lubrín on improvised routes in dense smoke.
- Beyond the village core, dwellings are scattered across the sierra, many owned by foreign residents, especially British.
- The regional emergencies chief said cell coverage cannot address one settlement without hitting neighbours not in danger: ["If we send an ES-Alert message, we send it to 6,000 people."](https://es.euronews.com/my-europe/2026/07/11/por-que-la-junta-de-andalucia-no-activo-el-sistema-es-alert-en-los-gallardos-habria-sido-p) The stated priority was instructions adapted to each settlement, avoiding a general alert that might push people against emergency service orders.
- [Situación Operativa 1 was not declared until 19:37](https://www.elplural.com/autonomias/andalucia/junta-andalucia-acorralada-mar-dudas-actuacion-incendio-gallardos-almeria_396675102) — **three hours after ignition** (16:25–16:35), not after the first evacuations (~17:30). One source only: El País says 20:08. The deaths fall in **21:00–22:30 CEST**; the roads toward Bédar were reported cut at ~22:30.
- Telephony infrastructure was damaged by the fire itself, degrading comms during the response.

### This is not an Almerían anomaly

Pedrógão Grande, Portugal, June 2017: [dozens died in or near their cars on the N-236](https://en.wikipedia.org/wiki/June_2017_Portugal_wildfires). Portugal's official Independent Technical Commission concluded that [an early warning could have prevented most of the deaths](https://www.safecommunitiesportugal.com/pedr%C3%B3g%C3%A3o-grande-fire-report-key-findings/), and that the absence of early warning "did not allow to prevent most fatalities." Reported ignition: electric discharge from power lines — the same reported cause as Los Gallardos.

### What follows from first principles

Detection latency is not the binding constraint. Neither is spread modelling. The constraint is the gap between a simulation and a sent instruction — and the recurring mechanism is that the escape route can close before the fire reaches the dwelling.

A values-at-risk system that only asks "which buildings fall inside the burn polygon" misses the mechanism. At Los Gallardos the road was cut first.

## What to build

**A last-safe-departure engine that emits ready-to-send alert packages, not a map.**

Working name: *Última Salida*. The unit of analysis is time-of-arrival, not perimeter; the output is a CAP message, not a dashboard.

```mermaid
flowchart TD
  A[Deepfire cluster<br/>active, ES] --> B[Ensemble spread<br/>20 members, 6-12h]
  B --> C[Time-of-arrival<br/>surface]
  C --> D[Road graph<br/>edge cut times]
  C --> E[Building pockets<br/>Catastro]
  D --> F[Last safe<br/>departure time]
  E --> F
  F --> G{Route survivable?}
  G -->|yes| H[Leave via route X]
  G -->|no| I[No verified action:<br/>operator assessment]
  H --> J[CAP 1.2 package]
  I --> J
  J --> K[ES-Alert footprint<br/>simulation]
```

### Stage by stage

1. **Ensemble spread — live panel only.** `POST /v1/fire-spread/simulations` with `ensembleMembers: 20`, `durationHours: 8` and a **`clusterId`** (a point ignition runs 1 member). Returns hourly polygons each carrying `burn_probability` — a probabilistic time-of-arrival surface rather than one perimeter. **The replay cannot use this**: the API has no historical date, so the past fire is replayed from its observed hotspot timeline.
2. **Road-graph survivability.** Intersect the time-of-arrival surface with an OSM drive graph. For the live panel it comes from the ensemble; for the replay it is built from observed detections (first detection within a safety buffer of each segment). Every road segment gets a cut time. This is the object nobody operational computes — the spike built it: 14,819 nodes. **Use a safety buffer ≥300 m**; below that a router threads the gaps between detections and the result is unreliable.
3. **Egress solve.** Cluster building footprints into population pockets. For each pocket, walk forward in time over the graph: which exits remain reachable at hour *h*? Derive **last safe departure time** per pocket per route, banded from detection geometry — not from an ensemble that cannot run for a past fire. The spike computed a road-cut field for Bédar, but the *departure* time is sensitivity-bound and not demonstrated as a warning (see A10).
4. **Protective action.** Where the departure time has passed, or no survivable route is found, the output is **not** automatically shelter-in-place: failing to find a route does not show the building is survivable. The default is "no verified protective action; operator assessment required", unless shelter suitability is independently established. Couple to CAMS smoke so "shelter" is never advised into a lethal column.
5. **The artifact.** A CAP 1.2 alert package: geometry, `urgency`/`severity`/`certainty`, and message text in Spanish, the co-official language, and the languages implied by the municipality's padrón nationality mix.

### Verified generation (your anti-hallucination story)

Do not let a language model write the instruction. Compose candidate sentences from pre-approved templates in code, one per instruction type and language, then select among them. Every road and place name must resolve to a real OSM feature **and** be model-passable at send time, or the candidate is discarded. See the TypeSafe section below for the selection and verification layer. Have this working and say so unprompted — it is the first thing anyone will probe.

### The ES-Alert footprint simulation

This is the part that directly answers why the alert was withheld. Cell broadcast reaches every handset within the coverage of the activated antennas; the delimitation of the affected area is approximate and depends on the number, position and distribution of antennas ([Protección Civil](https://www.proteccioncivil.es/coordinacion/redes/ran/public-warning-system)).

Pull tower locations from OpenCelliD, approximate served footprints, and report:

> Polygon A alerts ~6,200 people, 1,430 of whom are in the modelled danger zone. Polygon B alerts ~2,100 and covers 1,380 of them — 96% of those at risk, 66% less over-alerting. Three pockets need a *different* instruction and are listed separately.

That turns an intuition made under stress into a quantified, auditable trade-off.

### The decision ledger

Log every recommendation with its evidence and timestamp. An auditable record is itself a feature: it makes the basis of each recommendation reviewable afterwards, for a decision the responsible authority takes under uncertainty.

### Two things worth knowing

- **ES-Alert already supports a second language**, delivered per Cell Broadcast protocol to handsets configured in a non-Spanish locale. So the constraint is not technical. Our work is about the decision layer, not the delivery layer.
- **Authority sits with the CCAA 112 centres** under Ley 17/2015 Art. 12.4. You are building decision support for them, never a public-facing alerting authority. Say this before you are asked.

## TypeSafe / Jev in the pipeline

**Jev cannot generate text at all, by design.** That is not a limitation to work around — it is the reason to use it. It forces the alert message to be *selected* from safe phrasings rather than written, which removes hallucination structurally instead of catching it after the fact.

Verified against [the HTTP API](https://docs.typesafe.ai/api) and [the jev-1.13 jaggedness page](https://docs.typesafe.ai/model-jaggedness/jev-1.13) on 18 Sep 2026.

### The API, exactly

```http
POST https://api.typesafe.ai/v1/systemone
Authorization: Bearer <API_KEY>
Content-Type: application/json
```

One `state`, a map of named `questions`, one typed `answer` per question under the same keys. Three question types: `noul` (yes/no probability, no separate confidence), `choice` (option + full distribution + confidence), `score` (probability-weighted level + distribution + confidence).

| Constraint | Value |
| --- | --- |
| Endpoint | `POST /v1/systemone`, no streaming |
| Model | `jev-latest` → `jev-1.13.0` |
| Choice options | 1–255 |
| Score levels | 2–10 |
| Token budget | ~64k state + all questions; ~32k state + longest single question |
| Rate limits | 250k tok/s, 1,200 req/min (moving without notice) |
| Pricing | $0.042 / M input tokens, output free |
| Reported latency | ~70–500 ms per call |
| Errors | 401, 422, 429, 529 — retry 429/529 with backoff |

### Use 1 — Select the alert sentence, do not write it

Write the safe phrasings once, in code, per instruction type and per language. Pre-approved, reviewable, finite. Then one Choice picks the right one for this pocket's situation.

A successful Choice answer cannot contain a value outside your option list. That is a structural guarantee, not a measured one. For safety-critical public instructions, that property is worth more than fluency.

```json
{
  "state": { "pocket": "Bédar - dispersed dwellings NE",
             "egress": "primary route modelled cut before earliest feasible departure",
             "alternate": "secondary route open, longer",
             "smoke": "heavy on alternate" },
  "model": "jev-latest",
  "questions": {
    "instruction": {
      "type": "choice",
      "instructions": "Which protective action instruction fits this pocket's situation?",
      "criteria": {
        "evacuate_primary": "Primary route open and reachable in time",
        "evacuate_alternate": "Primary unusable, alternate open and reachable in time",
        "shelter_if_verified": "No route reachable AND shelter suitability independently established",
        "no_action": "Pocket not threatened in the modelled window"
      }
    }
  }
}
```

The geometry decides the situation. Jev only maps a described situation to a phrasing.

### Use 2 — The verification gate

Batch every check into one call. Their [parallel questions cookbook](https://docs.typesafe.ai/cookbooks/parallel_questions.md) reports 13 questions in a single request being 12.2× cheaper and 10× faster than one at a time, with identical answers.

- Does this message instruct movement toward the described fire position? (Noul)
- Would a reader in a hurry have to guess which of two roads is meant? (Score)
- Does the English carry the same urgency as the Spanish? (Noul)
- Is the wording proportionate to the described certainty? (Score)

Gate on the numbers. Their [confidence guide](https://docs.typesafe.ai/confidence) recommends three bands — act automatically, proceed with caution, do not act — with boundaries set by the stakes of each action, not one global number. Their consistency cookbooks suggest a Noul in roughly 0.3–0.7 means *uncertain*, not medium intensity, and a top Choice probability under 0.60 should escalate even when confidence reads high. For an evacuation instruction, set the bar high and route everything else to the operator with the failing check attached. That failure lands in the decision ledger, which is the point.

### Use 3 — Spanish bulletins into typed state

Deepfire's `official-incidents` is not shipped, so authority statements are prose: AEMET CAP warnings, INFOCA and 112 bulletins, DGT road-closure notices. Turning *"la carretera AL-6111 permanece cortada"* into a typed observation that feeds the road graph is real semantic work.

Two constraints apply. Retrieve and filter in code first and send only the fields the question needs, because accuracy falls as state fills with irrelevant material. And Jev does not treat state as hostile by default — injected or adversarially framed content can move the answer — so keep this to official sources, not open social feeds.

### Further uses, ranked

Ship the first two. They change the physics of the egress solve, which is the core claim. The rest are stretch.

| # | Use | Why it earns a call |
| --- | --- | --- |
| 1 | **Evacuation-difficulty class per facility** | Score over ordered levels — self-evacuating adults, needs transport, needs assisted transport, needs medical transport. Turns a messy multilingual name-and-tag blob into the required egress time that drives LSDT. This is the variable WUIVAC treats as a constant |
| 2 | **Route usability class** | OSM says an edge exists; whether it is an evacuation route is a different question. Choice over any vehicle / passenger car / 4x4 or emergency only / not an egress route. Reweights the graph per vehicle class — a coach leaving a residencia needs a different graph than a private car |
| 3 | **Cluster ↔ named incident matching** | Deepfire gives `cluster_id`; authorities say "el incendio de Bédar". Their [entity-alignment cookbook](https://docs.typesafe.ai/cookbooks/entity_alignment.md) is this exact shape — one Score whose three levels are merge, leave unlinked, hand to a curator. No threshold to fit |
| 4 | **Backtest ground truth from Spanish press** | Which settlements were evacuated, when, which roads were reported cut. This is how you get an accuracy number instead of a claim. Time-expensive |

#### Why use 1 and 2 matter most

Both address what actually killed people. Use 1 supplies the egress time that separates a campsite from a nursing home. Use 2 is the direct answer to victims fleeing down a forest track that turned out to be a dead end — `highway=track`, `surface=unpaved`, `noexit=yes` is a road in the graph and not an escape route.

#### Marginal

- **Ignition-type screening** (wildfire vs. agricultural burn vs. greenhouse). Spain has a lot of *quemas agrícolas*, so false-positive screening is real. But you have labelled hotspot history back to January 2025 — train a small supervised classifier instead. It will beat a general judgment model on a narrow, data-rich task.
- **CAP field coding.** `urgency`, `severity` and `certainty` are closed enums, which fits Choice. But certainty comes from your ensemble and urgency from time-to-arrival; both are computed. Only `category` and `event` are judgment, and those are near-constant for wildfire.

#### Ruled out

- Language selection from padrón nationality mix — a lookup, not a judgment.
- Multi-fire triage ranking — still mostly numeric.
- Anything comparing timestamps.

#### The discipline that matters more than the list

Seven plausible uses is seven network calls on a critical path in a 48-hour build, each a new way for the demo to die. Every call needs an answer to "why is a model doing this instead of code?" Expect that question about your weakest use, not your strongest. Ship two, plus the selection-and-verification layer.

### Where it must not go

| Never | Why |
| --- | --- |
| Road cut times, arrival times, LSDT | It cannot do arithmetic or count reliably |
| Anything comparing timestamps | Dates are read as text, not ordered values — bucket the comparison in code and pass the label |
| Computing how much earlier one route closes | Score levels are weakly calibrated numerically; threshold only |
| Writing the message | It cannot generate text |
| Keeping two answers consistent | It gives no structural-invariant guarantee; enforce in code |

### Risks, stated plainly

- **Access is a waitlist.** Request a key early. If it does not arrive, the pipeline runs without it — the verification gate falls back to the deterministic OSM checks alone.
- **The product is new** (launched 2026-09-17). Call the HTTP endpoint directly; the JS SDK is at v0.6.0.
- **Typed output guarantees the interface, not truth.** Calibration is group-level, not a per-answer promise. We use it to select and to check, not as a correctness proof.
- **Non-English performance is unverified.** No language limitation appears on the published jaggedness list. Our messages are Spanish and Catalan, so test a Spanish state before relying on it, and report what we find.
- **It is optional.** It is not one of the challenge's provided resources. It counts only if the gate visibly works and the rejection log is shown.

## Tonight: three go/no-go tests

Each of these can change the plan. Finding out at hour 20 would leave too little time to adapt. Get the key first: [app.deepfire.co/settings/api-clients](https://app.deepfire.co/settings/api-clients).

```bash
export TOKEN="..."
export DF="https://api.deepfire.co"
```

### Test 1 — Does fire-spread run in Spain?

The docs say a simulation returns `FAILED` when "the cluster is outside the modelled regions." The worked example in their docs is North Macedonia, so Europe is probably covered. Prove it.

```bash
# Point ignition at Los Gallardos
curl -s -X POST "$DF/v1/fire-spread/simulations" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"latitude": 37.167, "longitude": -1.939, "durationHours": 6}'

# then poll
curl -s -H "Authorization: Bearer $TOKEN" \
  "$DF/v1/fire-spread/simulations/<id>"
```

Watch for `status`: `COMPLETED` / `NO_SPREAD` / `FAILED`, and read `errorMessage` if it fails.

### Test 2 — ForeFire vs ELMFIRE

Deepfire defaults to `elmfire`, calibrated on US LANDFIRE fuels. ForeFire is Corsican, built for Mediterranean shrubland. Run both on the same ignition and compare.

```bash
curl -s -X POST "$DF/v1/fire-spread/simulations" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"latitude": 37.167, "longitude": -1.939, "durationHours": 6,
       "model": "forefire", "ensembleMembers": 10}'
```

Choosing ForeFire for Almería, and being able to say why in one sentence, is a 30-second credibility win.

### Test 3 — Real queue latency

Simulations can sit `QUEUED` up to 60 minutes before being marked `FAILED`. Time ten runs. If it is slow, your real-time claim needs pre-warming and your live demo needs a fallback path.

### Also pull tonight (slow, do it while you sleep)

```bash
# Historical hotspots for the Los Gallardos fire window
curl -sG -H "Authorization: Bearer $TOKEN" \
  "$DF/ogc/features/v1/collections/deepfire:hotspots/items" \
  --data-urlencode "bbox=-2.15,37.05,-1.75,37.35" \
  --data-urlencode "filter-lang=cql2-text" \
  --data-urlencode "filter=observed_at >= TIMESTAMP('2026-07-09T00:00:00Z') AND observed_at < TIMESTAMP('2026-07-13T00:00:00Z')" \
  --data-urlencode "limit=10000" \
  --data-urlencode "f=application/geo+json" > gallardos_hotspots.geojson

# Current active clusters over Iberia (for the live panel)
curl -sG -H "Authorization: Bearer $TOKEN" \
  "$DF/ogc/features/v1/collections/deepfire:clusters/items" \
  --data-urlencode "bbox=-10,36,4,44" \
  --data-urlencode "filter-lang=cql2-text" \
  --data-urlencode "filter=active = true" \
  --data-urlencode "f=application/geo+json"
```

**Request a TypeSafe API key tonight** — access is a waitlist and it will not arrive on demand tomorrow. If it does not come through, the verification gate falls back to deterministic OSM checks and nothing else in the pipeline changes.

Also: Catastro INSPIRE buildings for Los Gallardos, Bédar, Lubrín and Turre (ATOM, per-municipality GML), OSM extract for the same bbox, and an AEMET OpenData key (free, by email).

**Building footprints are one blocker; the evacuation dataset is the bigger one.** Catastro did not answer our query in the spike (the WFS rejects the bbox filter, the ATOM index path has moved, and its TLS needs `-k`), and OSM has only **3 buildings within 1 km of Bédar**. But even with footprints, an evacuation solve still needs occupancy, vehicle demand, departure delays, shelter capacity, a directed road graph, road capacities and usable destinations. None of that is in hand. See A13.

### Fallback if any test fails

Elliptical Rothermel propagation of your own: ESA WorldCover 10 m or CORINE as fuel proxy, Copernicus DEM GLO-30 for slope, AEMET hourly wind. Half a day of work. It de-risks everything downstream and it is worth building the interface for it even if Deepfire's model works, so the demo cannot die on stage.

## Hour-by-hour

The rule: a working end-to-end path by hour 12, then improve one stage at a time. Never leave the pipeline broken overnight.

| Window | Do | Done means |
| --- | --- | --- |
| Tonight | API key, three tests, bulk data pulls | You know if the spread model works in Spain |
| H0–2 | Repo, data loaded locally, bbox fixed to one region | No network dependency for the replay path |
| H2–5 | Ensemble → time-of-arrival raster | You can render "fire here at hour h, p=0.7" |
| H5–9 | OSM graph, edge cut times, egress solve | One pocket shows a last safe departure time |
| H9–12 | **End-to-end spike**: hotspot → road cut → one CAP file | The minimal path works end to end. Capture a snapshot |
| H12–16 | Sleep in shifts. Do not skip this | Somebody is coherent at the end |
| H16–20 | Catastro pockets, padrón languages, message generation + verification loop | Messages name real, passable roads |
| H20–26 | OpenCelliD footprint simulation, precision/recall numbers | The "6,200 vs 2,100" slide exists |
| H26–32 | Replay UI with a clock. Backtest against the real Bédar timeline | The falsification test has an answer |
| H32–38 | Live panel on a current Iberian cluster. Decision ledger | Two panels both work |
| H38–44 | Freeze. Rehearse the demo four times, timed | No feature lands after the freeze |
| H44–48 | Buffer for the thing that breaks | Something always breaks |

### Rules that matter more than the schedule

- **Freeze at H38.** A demo that runs beats a feature that half-works. Every team that loses does so by shipping at hour 47.
- **Record a video of the working demo at H32.** If the live path dies on stage, you play it. Say you are playing it.
- **One region only.** Almería for the replay, wherever is burning for the live panel. Do not generalise.
- **Cache everything.** Deepfire queue latency is outside your control. Pre-run the replay simulations and store the GeoJSON on disk.
- **Two people on the pipeline, one on the demo.** The demo is a deliverable, not a wrapper. "Demo quality" is an explicit criterion.

## Scope tiers

Build strictly downward. Nothing from a lower tier starts until the tier above works end to end.

### Must have — without these there is no submission

1. ~~Ensemble spread from a real Deepfire cluster, hourly polygons, ≥10 members.~~ **Shown to run** — 10 × 8 h with `burn_probability`, but only on an available active `clusterId` (the spike's run used a cluster near Don Benito, not Los Gallardos).
2. ~~OSM road graph with per-edge cut times.~~ **Verified** — 14,819-node graph, per-segment cut times.
3. ~~One last safe departure time for one real population pocket, with a confidence band.~~ **Partially shown** — the Bédar road-cut field is computed; the *departure* time is sensitivity-bound and not demonstrated as a warning (see A10).
4. A valid CAP 1.2 XML file as output, Spanish + English. *(not started)*
5. The Los Gallardos replay with a clock. *(data verified; build pending)*

### Should have — the differentiators

6. Evacuation-difficulty class per facility, feeding required egress time into LSDT.
7. Route usability class, so the graph knows which edges are actually escape routes.
8. ES-Alert footprint simulation with over-alerting numbers.
9. Catastro building pockets rather than hand-drawn ones.
10. Language selection from padrón nationality mix.
11. Selection-and-verification layer for the alert text.
12. Live panel on a currently active Iberian fire.

### Nice to have — only if you are ahead

13. Decision ledger UI.
14. CAMS smoke coupling for shelter-in-place viability.
15. Cluster ↔ named official incident matching.
16. Backtest ground truth extracted from Spanish press and bulletins.
17. Growth-rate estimation from MTG-I1 + VIIRS fusion.
18. Re-entry / all-clear timing.
19. Enriched perimeters: fuse Deepfire's `cumulative-multihull-v1` estimate with EFFIS/EMS reference outlines and fuel-aware growth. **Proposed, not implemented** — the spike did not build or test a fusion method.

### Cut list — drop in this order

Drop from 19 downward. Items 6 and 7 come last because they change what the egress model computes, not how it looks — everything above them is presentation or coverage.

If you are cutting into the must-haves, you have the wrong project; fall back to the replay alone, presented honestly as a retrospective analysis. That still demonstrates the insight and still beats a dashboard.

### Things that look essential and are not

- **A pretty map.** One clear map beats an interactive one. Spend the time on the computation, not the interaction.
- **Authentication, multi-user, persistence.** It is a 48-hour prototype and everyone knows it.
- **Covering all of Spain.** One region, done properly, is more defensible than broad but shallow coverage.
- **Your own detection model.** The platform already fuses many satellites. A narrower, well-tested scope is worth more here.

## Data sources

The first four are the build. The rest are differentiation.

| Source | For | Access |
| --- | --- | --- |
| [Deepfire API](https://docs.deepfire.co/) | Hotspots, clusters, ensemble spread | Bearer token, free key |
| OpenStreetMap | Road graph incl. `highway=track`, dead-end topology | OSMnx / Geofabrik extract |
| [Catastro INSPIRE](https://www.catastro.hacienda.gob.es/webinspire/index.html) | Building footprints + `currentUse`, per municipality | ATOM / WFS, GML, ETRS89, free |
| [AEMET OpenData](https://opendata.aemet.es/centrodedescargas/inicio) | Hourly wind, gusts, station obs, fire-risk maps, CAP warnings | Free key by email; MCP server `@rldona/aemet-mcp` |
| OpenCelliD | Cell tower positions → ES-Alert footprint simulation | Free API key, CC-BY-SA |
| INE padrón | Population and **foreign nationality by municipality** → alert languages | Free download |
| CAMS | Smoke / PM2.5 forecast → shelter-in-place viability | Copernicus ADS |
| Copernicus DEM GLO-30 | Slope for the fallback propagation model | Free |
| ESA WorldCover 10 m / CORINE | Fuel proxy for the fallback model | Free |
| EFFIS / GWIS | FWI + `fuel_map` + `modis.ba.poly` burnt area (WMS verified; **WFS not served**) | Free, no key |
| NASA FIRMS | VIIRS 375 m + MODIS active fire, 24 h CSV | Free; **24 h CSVs need no key** (MAP_KEY only for the area API) |
| Open-Meteo | Hourly wind (ERA5) + air quality (CAMS-backed) | Free, no key |
| EUMETView | Sentinel-3 SLSTR FRP, MSG fire, RGB imagery | Free WMS, no key |
| LSA SAF (IPMA) | MTG products: MTFRPPixel (used), MTLST, MTDAL | Free, no key |
| Copernicus DEM GLO-30 / ESA WorldCover | Slope + fuel, AWS Open Data | Free, no key |
| Copernicus EMS Rapid Mapping | Official delineation vectors for major fires — ground truth | Free |
| REGA | Livestock holdings — people die returning for animals | Public registry |
| OSM `power=minor_line` | Ignition sources; the PSPS bridge | OSM |
| TypeSafe / Jev | Selecting alert phrasings; verification gate; Spanish bulletins into typed state | POST /v1/systemone, Bearer key — waitlist, request tonight |

### Notes on the ones with traps

- **Catastro:** Navarra and the Basque Country run separate cadastres with thinner schemas. Irrelevant for an Andalusian or Catalan demo, but do not promise national coverage.
- **INE mobile-phone mobility data** looks perfect for de-facto population and is not. Areas have ≥5,000 residents (too coarse for a village pocket), foreign roaming phones are excluded (exactly the tourists and some expats), and it is experimental and historical, not live. Use it as a **seasonal multiplier** only, and say so.
- **OpenCelliD** is crowd-sourced and incomplete in rural Spain. Your footprint estimate is an approximation — present it as one. The argument survives: even an approximate footprint beats the intuition it replaces.
- **OSM tracks** in rural Almería are decent but variable. The roads people die on are often the ones missing from the dataset you would reach for first. That is worth saying out loud as a limitation rather than letting someone else find it.

### The creative pick

If you do one non-obvious thing, make it **OpenCelliD**. It turns the alert's own reach into a computed number: who each polygon would actually reach, and who it would over-alert.

## The demo

Two panels, no dashboard. Four minutes. Rehearse it timed, four times.

### Panel 1 — Replay (retrospective)

9 July 2026, Los Gallardos. Real Deepfire hotspots, a clock, scrub forward.

1. 16:48 — first detections appear.
2. The live path would run an ensemble; the replay cannot — the API has no historical date — so the surface is built from the observed detections as they appear.
3. The moment the model shows the Bédar exit road closing, the system emits the alert package: polygon, footprint estimate, Spanish and English text, per-pocket instructions.
4. Show the timestamp against when vehicles were actually trapped.
5. One line: no ES-Alert was sent that day.

### Panel 2 — Live (proves real time)

[EFFIS forecasts very extreme fire danger across most of France, the Pyrenees and northwestern Morocco for 17–23 September 2026](https://joint-research-centre.ec.europa.eu/scientific-activities/natural-and-man-made-hazards/forest-fires/current-wildfire-situation-europe_en), with extreme to very high danger over much of the Iberian Peninsula. Europe is at 668,035 ha year-to-date against a 20-year average of 346,567 ha.

Verified 2026-09-19: **94 active clusters over Iberia**, several on the Spanish mainland. Query one live, produce a real alert package on stage, and show the measured latency from `observed_watermark` to output — **56 min – 2 h 44 min** across the 12 July perimeters.

Have the recorded fallback ready. If you play it, say you are playing it.

### Presenting a fatal fire with restraint

This matters more than the code. Fourteen people died ten weeks ago and the investigation is open. Spanish attendees will be in the room.

**Do:** present it as "here is what the coordinator could have had on screen." Acknowledge that hindsight is cheap and the inquiry is ongoing. Frame the ES-Alert decision as genuinely hard — public reporting indicates differentiated instructions per settlement were an important consideration — and present the system as a way to make that trade-off computable, not as a judgement on the decision.

**Do not:** show victim details or imagery, name individuals, assert cause, or imply the Junta was negligent. Do not say "we would have saved them."

Done with restraint this is the most powerful demo at the event. Done wrong it alienates the room. The difference is two or three sentences of framing, so write them in advance rather than improvising.

## Risks and counterarguments

Four places this could be wrong. Know them before anyone else does.

### Technosylva already does much of this

They are Spanish (León), used operationally in Spain by the UME and several regions, and they advertise identifying population at risk, evacuation planning support, sub-30-second simulations, deterministic and probabilistic runs, and [decisions around near-term mitigation, resourcing and placement, and PSPS events](https://technosylva.com/products/overview/). They also compute evacuation time zones, or "firesheds."

Be precise about the gap rather than claiming novelty you do not have:

- They sell a common operating picture to agencies and utilities. They do not produce the citizen-facing instruction.
- Firesheds buffer the **asset**. They do not appear to model **egress route survivability over time**.
- They cannot send the message. Our work sits between the modelled picture and the instruction.

### The trigger-buffer concept is 20 years old

Cova, Dennison et al. published [trigger points computed from wind, topography, fuel and estimated evacuation time](https://ui.adsabs.harvard.edu/abs/2005TrGIS...9..603C/abstract), where evacuation is recommended once a fire crosses the buffer edge. Formalised as WUIVAC, extended by PERIL. Cite it; do not pretend you invented it.

Your three actual contributions:

1. WUIVAC runs pre-fire what-if scenarios. Yours runs on live satellite-observed position.
2. WUIVAC treats evacuation time as a fixed constant. Yours derives it from route survivability.
3. WUIVAC buffers the asset. Yours operates on the road network.

### The over-alerting trade-off has no right answer

Many warning researchers argue you alert broadly and early, because the cost of an unnecessary alert sits far below the cost of a death. There is also evidence that frequent alerts cause desensitisation. We do not take a side.

Present the trade-off as explicit and quantified. "Here is what each polygon costs you" is more defensible under questioning than "we optimised for fewer alerts."

### The falsification test — run it first

If a road-aware egress model, run on the real Deepfire hotspots from 9 July 2026, produces a cut time for the Bédar exit **later** than when vehicles were actually trapped, the thesis fails.

Run that early, not at hour 30. If it does not hold, pivot to trigger buffers around fixed vulnerable facilities — schools, residencias, campsites — which is weaker but still worth building.

**Run 2026-09-19 — inconclusive as a warning.** The Bédar exit road is the **AL-6109** ("Carretera de Los Gallardos a Bédar"). The first detection inside a 200 m buffer of the road is at **19:38 CEST**, and the first deaths are reported at ~21:00. But that trigger is a single MTG detection, and the data carries **no availability timestamp** — we know when it was observed, not when it could have been acted on. So this is a **retrospective sensitivity result, not a demonstrated lead time**. It is also fragile: at a 100 m buffer the first in-buffer detection is 21:18, and with polar data only it is 00:03. A real product must cut on the burnt area, not a point radius.

### Technical risks

| Risk | Mitigation |
| --- | --- |
| Spread model excludes Spain | **Cleared** — both models run in Spain |
| Queue latency kills the live demo | **Cleared** — ≤3 min for a 10 × 8 h ensemble. But **max 2 concurrent**, so pre-warm through a queue |
| OSM missing the actual escape tracks | State it as a limitation; it is also a finding |
| OSM missing the actual buildings | **Real** — 3 buildings within 1 km of Bédar. Catastro is not optional |
| Ensemble too slow at 20 members | Drop to 10; the shape of the distribution is what matters |
| A model invents a road name | No free-form generation — the sentence is selected from templates in code, then checked against OSM |
| Deepfire's perimeter runs large vs EFFIS (+59 %) | Expected for a fast estimate. Fuse with EFFIS/EMS before it feeds values-at-risk |

### Ethical boundary

This is decision support for authorities, never public-facing. Only CCAA 112 centres can issue ES-Alert. Deepfire's own docs state their perimeters are estimates, "not official surveyed fire boundaries and should not be treated as authoritative for safety or legal purposes." Put that on a slide yourself. Saying it before you are asked reads as operational maturity.

## Pitch language

### The opening, roughly

> Spain's record year burned a million hectares. The fire that killed the most people this year burned five thousand. Fourteen died at Los Gallardos in July — in a car, and on foot, on roads the fire reached first. No mobile alert was sent; public reporting points to the difficulty of one broadcast carrying different instructions to different settlements.
>
> Detection has improved enormously — the platform fuses many satellites. The harder gap is between an observation and a usable instruction. We built a prototype that explores how to narrow it.

### Map the criteria explicitly

| Criterion | Your answer |
| --- | --- |
| Helps first responders do their job | Produces the artifact a 112 coordinator actually needs: a polygon, a message, a per-pocket instruction |
| Technical implementation and accuracy | Backtested against a real fire with real historical hotspots; measured latency, not claimed |
| Creative use of datasets and APIs | Cluster ensembles with `burn_probability`, ForeFire over ELMFIRE for Mediterranean fuels, EFFIS burnt-area ground truth, cell towers to model the alert's own footprint |
| Demo quality | Replay with a clock plus a live fire, four minutes, rehearsed |

### Q&A to have ready

- **"How is this different from Technosylva?"** They model fire and show agencies a picture. We produce the message, model who actually receives it, and compute which exits close when. Different layer.
- **"Isn't the LLM going to hallucinate a road?"** Every road name is resolved against OSM and checked as passable in the model at send time, or the sentence is rejected. Here is the rejection log.
- **"You are second-guessing a real emergency decision."** We are not. Public reporting indicates different settlements needed different instructions and one broadcast could not carry them. We make that trade-off computable instead of a judgement call under stress.
- **"What is your accuracy?"** Give the backtest number and its confidence band, and say where the model is weak. Do not give a single number with no error bar.
- **"Could this be deployed?"** Not as-is, and not by us. Only CCAA 112 centres can issue ES-Alert. CAP output is the integration point, which is why we emit CAP rather than a UI.

### Words to avoid

Dashboard. Platform. Real-time insights. Anything someone who builds wildfire software hears ten times a day. Say what it computes and what comes out of it.

### The one sentence to land

The fire reached the road before it reached the houses, and nothing in the stack tracked that. That is the gap we set out to close.


## Appendix A — Experiment log and figures

This appendix records every experiment the spike ran: what we did, the method, the result, and the figure. It is **not a scientific study** — no formal design, no replication, no peer review. It is what we saw when we ran the data, and some entries below are flagged as wrong, corrected, or withdrawn. All times are CEST (UTC+2) unless marked UTC.

### A0. Method and data inventory

We pulled the data below, then ran the experiments that follow. The figures are in `img/`.

| Dataset | What we got | Source |
| --- | --- | --- |
| Deepfire hotspots | **2,660** detections, 9–11 Jul 2026, 7 sources | `deepfire:hotspots` |
| Deepfire satellite perimeters | **12** snapshots; first `computed_at` 2026-07-10T00:24Z | `deepfire:satellite-perimeters` |
| Deepfire active clusters | **94** over Iberia (19 Sep 2026) | `deepfire:clusters` |
| NASA FIRMS 24 h CSVs | 4 sensors: VIIRS SNPP / NOAA-20 / NOAA-21, MODIS | NASA FIRMS |
| MTG-I1 fire product | LSA-509 MTFRPPIXEL. A **full 2026 archive** (36,815 scans, 73,630 files, 77 GB, Jan–Sep 2026) covers the July fire, with quality masks, per-pixel acquisition times and file metadata | LSA SAF (IPMA) |
| EFFIS burnt area | vectorised from the `modis.ba.poly.season` WMS layer | EFFIS/GWIS |
| Terrain | Copernicus DEM GLO-30 (30 m) | AWS open data |
| Fuel | ESA WorldCover 2021 v200 (10 m) | AWS open data |
| Roads | OSM drive graph, **14,819** nodes after 30 m quantisation | OSM / Overpass |
| Buildings | OSM building footprints in the bbox | OSM / Overpass |
| Wind / weather | ERA5 hourly, via Open-Meteo | Open-Meteo |

Two sources we could not use in the spike: **Catastro** (see A13) and **Copernicus EMS Rapid Mapping** (no activation matched the query).

### A1. The observation timeline

**What we did.** Plotted every detection by position, time and FRP; binned detections per hour; built hourly maps across the fire window.

**Result.** 2,660 detections. First at **09 Jul 16:48 CEST** (14:48 UTC); last at **11 Jul 12:08 CEST**. Source split: **MTG 1,932**, all polar sensors **728**. **53 detections fall inside the 14:35–17:37 UTC evacuation window** — the fire was observed during the evacuation period.

![01 — All hotspot detections, colour = time, size = fire radiative power; villages marked.](img/01_hotspots_timeline.png)

![02 — Detections per hour, stacked by source, with the evacuation window marked.](img/02_detection_cadence.png)

![03 — Hourly small multiples, 9 Jul 16:00 → 10 Jul 04:00 CEST: the fire front walking north into Bédar.](img/03_hotspots_hourly_grid.png)

### A2. Source mix and radiative power

**What we did.** Separated detections by sensor; plotted FRP against time per source.

**Result.** The geostationary layer (MTG-I1 FDIR, nominal 1 km, 10-minute scans) carries the temporal density. The 375 m polar layer (VIIRS) carries the positional precision. Neither alone is enough — see A6 and A10.

![06 — Per-source panels: positions, time colour, statistics.](img/06_source_breakdown.png)

![07 — Fire radiative power against time per source, log scale, 30-minute median.](img/07_frp_timeseries.png)

### A3. The archived perimeters

**What we did.** Overlaid the 12 archived perimeter snapshots and compared the final one to the hotspot cloud and to EFFIS.

**Result.** The first perimeter is dated **2026-07-10T00:24Z**, about **10 h after ignition**. **No perimeter existed during the evacuation window** — the observation that kills any "just use the perimeter" design.

![04 — Perimeter snapshots overlaid, colour = computed_at, area annotated.](img/04_perimeters_evolution.png)

![05 — Final perimeter against all hotspots; evacuation-window detections highlighted.](img/05_hotspots_vs_perimeters.png)

### A4. Fire-spread simulation — can it run in Spain?

**What we did.** Ran simulations through Deepfire: a point ELMFIRE ignition and a point ForeFire ignition at Los Gallardos, and a 10-member × 8 h **cluster** ensemble. The ensemble is a **different ignition** — the API simulates active clusters, so it ran on a cluster near Don Benito (Badajoz), ~400 km away. All runs used **current (September) weather**, because the API cannot run a historical date.

**Result.** All runs reached `COMPLETED`. Latency: point ≤32 s; the 10 × 8 h ensemble ≤3 min. So the "spread model excludes Spain" risk is **cleared**, and latency is not the blocker.

**Constraints found.** `ensembleMembers` needs a `clusterId` (a point ignition runs 1 member). Max **2 simulations in progress** per client. Short durations return `NO_SPREAD` — use ≥6 h. The API has **no historical date**, so a past fire cannot be re-simulated.

![08 — Fire-spread runs: (a) point ELMFIRE and (b) point ForeFire at Los Gallardos; (c) a 10-member cluster ensemble on a different fire (Don Benito, Badajoz), September weather.](img/08_simulation_spread.png)

**Decision.** We do **not** build the thesis on the simulation layer. See A14 — the professional model's own validation puts the ceiling on this class of model. The simulation is a supporting input, not the accuracy story.

### A5. Active clusters over Iberia

**What we did.** Pulled all `active = true` clusters over Iberia and checked each against FIRMS.

**Result.** **94 active clusters.** Of these, **25 have no NASA FIRMS detection within 10 km in 24 h** — `active` is a time window, not a live state. This is the live-panel dataset, and the caveat to state up front.

![09 — 94 active fire clusters on the Iberian Peninsula, 19 September 2026.](img/09_active_clusters_iberia.png)

### A6. The MTG 10-minute layer

**What we did.** Read the raw MTG-I1 FCI fire product (LSA-509 MTFRPPIXEL), rendered it three ways, and compared Iberia against Deepfire's clusters.

**Result.** ~2,296 pixels flagged globally. The dense cluster over Africa is **agricultural burning, not wildfire** — the reason fire services filter by region and confidence. Over Iberia the product is sparse but decisive at 10-minute cadence.

**Resolution and timeliness.** Nominal resolution is **1 km** at the sub-satellite point (Iberian detections span 1.34–1.59 km² each), not 2 km. Scans are every **10 minutes**, but the provider states typical delivery of around **20 minutes**, up to 45 — a 10-minute scan cadence does not mean a 10-minute alert. The 2026 archive also covers the whole fire history, not one scan.

![10 — MTG-I1 FCI active-fire pixels, whole disk. Colour and size = FRP (MW).](img/10_mtg_fdir_disk.png)

![11 — MTG-I1 fire pixels over Iberia compared with Deepfire clusters.](img/11_mtg_fdir_iberia_vs_deepfire.png)

![12 — The African burning belt, labelled: Zambia, Zimbabwe, Mozambique, Malawi, Angola, Madagascar.](img/12_mtg_africa_labeled.png)

![13 — The African belt over an OpenStreetMap basemap.](img/13_mtg_osm_africa.png)

![14 — Iberia over an OpenStreetMap basemap.](img/14_mtg_osm_iberia.png)

### A7. FIRMS × Deepfire × MTG cross-check

**What we did.** Loaded all four FIRMS 24 h CSVs for Iberia, then measured each Deepfire cluster's distance to the nearest FIRMS detection.

**Result.** The two layers agree: Deepfire's clusters sit on the same polar detections that FIRMS reports raw. That consistency is a good sign — the fused layer is stable — and the geostationary (MTG) layer is where we add the most.

![16 — Three fire sources over Iberia: NASA FIRMS (375 m polar), Deepfire clusters, MTG (1 km geostationary).](img/16_firms_deepfire_mtg_iberia.png)

### A8. Terrain and fuel for a fallback model

**What we did.** Built a slope raster from Copernicus DEM GLO-30 and a fuel proxy from ESA WorldCover, over the fire area.

**Result.** The fire area is **shrubland and grassland with cropland breaks** on gently to moderately sloping terrain — classic Mediterranean fuel. This is the input set for a fallback Rothermel-style model (A15), and the fuel basis for the FBFM40 problem noted in the main plan.

![15 — Terrain (slope) and fuel (ESA WorldCover) over the Los Gallardos fire area.](img/15_terrain_fuel_gallardos.png)

### A9. Wind reconstruction (ERA5)

**What we did.** Pulled hourly ERA5 wind, gust, temperature and humidity for the fire evening.

**Result.** Through the fire window: mean speed **19.3 km/h**, max **25.3 km/h**, gusts to **54.0 km/h**, direction **185–205°** (southerly), temperature to **39.6 °C**, relative humidity down to **10 %**. The southerly gale ran the fire **north** into Bédar's exit road. Wind is the physical driver, and the plan must carry it.

### A10. The road-cut test — retrospective and sensitivity-bound

**What we did.** For every drivable OSM way, we assigned a **time of arrival (ToA)** — the earliest detection time within a buffer R of the way. We then compared the modelled cut time of the Bédar exit road (AL-6109) against the known timeline. We repeated at three buffer radii and with polar-only data.

**Timeline anchors (UTC / CEST):** ignition 14:25–14:35; evacuations ~15:30; Situación Operativa 1 17:37–18:08; **deaths 19:00–20:30 UTC (21:00–22:30 CEST)**; roads reported cut ~20:30 UTC (22:30 CEST).

**Result — first detection inside the buffer (retrospective):**

| Buffer R | Data | Earliest AL-6109 cut |
| --- | --- | --- |
| 100 m | all sources | 09 Jul **21:18** CEST |
| 200 m | all sources | 09 Jul **19:38** CEST |
| 500 m | all sources | 09 Jul **19:38** CEST |
| any R | **polar only** | 10 Jul **00:03** CEST |

The first detection inside a 200 m buffer of AL-6109 is at **19:38 CEST**; the first deaths are reported ~21:00. This is **not** a demonstrated warning: the trigger is a single detection at 19:38:21, the data carries no availability timestamp, and a detection gap does not mean the fire stopped. It is also fragile — at a 100 m buffer the first in-buffer detection is 21:18, and with polar-only data 00:03. **This is a retrospective sensitivity result, not verified lead time.**

![17 — Road-cut test: per-segment time-of-arrival against the observed timeline and the AL-6109 cut times. The buffer/source sensitivity is in the table above, not in the figure.](img/17_falsification_test.png)


### A11. The egress cut-time field

**What we did.** Turned the per-way cut times into a continuous time-of-arrival field over the road network, so every segment carries a colour = when the fire reaches it.

**Result.** The gif we can hand a coordinator: the fire's approach to the road network as a clock, not a perimeter.

![18 — Egress cut-time field over the road network.](img/18_egress_cuttime_field.png)

The egress solver builds the 14,819-node graph, takes the Bédar pocket and two candidate exits (south toward Los Gallardos, north toward Lubrín), and writes the last feasible departure per exit.

### A12. Ground-truth comparison

**What we did.** Vectorised the EFFIS burnt area from its WMS layer and compared it with Deepfire's final perimeter and with the hotspot convex hull.

**Result.**

| Source | Burnt area |
| --- | --- |
| EFFIS (satellite delineation) | **5,767 ha** |
| Press ("official", approximate) | ~5,200 ha |
| Deepfire final perimeter | **9,172 ha** |
| Hotspot 300 m buffer / hull | (see figure) |

**Reading.** Deepfire's perimeter is a fast operational layer. At 9,172 ha (reprojected; the raw `area_m2` field is 9,178 ha), it runs ~59 % larger than the EFFIS reference of 5,767 ha, with IoU 0.61 — the shape you expect from an immediate estimate. **Caveat:** that reference is not an event-dated delineation. It is derived by selecting green pixels from the seasonal `modis.ba.poly.season` WMS image, so the comparison is indicative, not a matched-date validation. No fusion method was built or tested; tightening the burnt area with EFFIS/EMS is a proposal, not a result.

![19 — Ground-truth comparison: EFFIS burnt area vs Deepfire perimeter vs hotspot extent.](img/19_groundtruth_comparison.png)

### A13. Values at risk — what the data does and does not give us

**What we did.** Counted OSM buildings in the bbox and how many fall inside the burn; measured building density within 1.5 km of each settlement. Then tried the two authority sources: Catastro INSPIRE and INE padrón.

**Result.** **OSM carries only 3 buildings within 1 km of Bédar**, so it is not the values-at-risk source here. Catastro did not answer our query in the spike (the WFS rejects the bbox filter, the ATOM index path has moved, and its TLS needs `-k`). INE's API is open but the correct operation is not yet identified.

![20 — Values at risk: OSM buildings against the EFFIS burnt area and the Deepfire perimeter.](img/20_values_at_risk.png)

**Building footprints are not the whole blocker — the evacuation data is.** Even with Catastro, an evacuation solve still needs occupancy, vehicle demand, departure delays, shelter capacity, a directed road graph that preserves real connectivity, road capacities, and usable destinations with capacities. The spike has none of these, and its road prototype merges nearby nodes, treats roads as bidirectional, and checks the next node rather than exposure along each segment. The missing test is one complete Bédar scenario: population and vehicle-demand ranges, a directed graph, and a calculation that shows how long the population takes to clear each bottleneck and when no feasible route remains.

### A14. The simulation ceiling — ELMFIRE's own validation

**Why this matters.** We tested the professional side of the simulation layer, because the obvious question is "why not just simulate?". The answer is measured, not assumed.

**What we did.** Cloned ELMFIRE, built it, ran a tutorial case, and read its own validation report (`docs/validation_report.pdf`).

**Local run.** The stock Dockerfile is **x86-only**; it fails on Apple Silicon (*"running an x86 program on an arm64 OS without multi-arch libraries"*). One change — the micromamba URL, `linux-64` → `linux-aarch64` — builds it natively in **2 m 15 s**. The constant-wind tutorial reaches *"End of simulation reached successfully"* (9,822.9 acres) and writes time-of-arrival, fireline intensity, spread rate and hourly isochrones. **ELMFIRE runs here.** We ran only the shipped constant-wind tutorial — we did **not** test ELMFIRE's predictive accuracy on our own case, which needs a full FBFM40 fuel deck. Status: runs locally, local accuracy untested.

**Its own validation report** — 1,295 real fires:

| Metric | Value |
| --- | --- |
| Total cases | 1,295 |
| Comparable output | **561** (of 1,295 attempted) |
| No output reported | **698** |
| Non-ignited (Jaccard < 0.01) | 36 |
| Jaccard, ELMFIRE (n=561) | **median 0.133, mean 0.178** |
| Jaccard, FARSITE (n=512) | median 0.137, mean 0.176 |
| Best case (AMARGO) | 0.76 |
| Example (BRUSH CREEK 2, 2022) | IoU 0.151; simulated 2.22 km² vs observed 12.89 km²; **area ratio 0.17** |
| Skill vs wind speed | **R² ≈ 0.001** (none) |

**Result.** Over the 561 comparable cases, ELMFIRE's median overlap with the observed scar is **0.133** (mean 0.178), and FARSITE scores almost the same. The 698 no-output cases are a reported subset, not proof of a universal failure rate. Point-ignition spread modelling is a coarse instrument for everyone, which is why we lead with observations. Our contribution is to put a measured clock beside the model: observation-driven, with the model filling only the gap after the last observation.

Caveats: the benchmark is US fires on LANDFIRE fuels; the no-output cases are partly input or queue problems; and this is our read of someone else's report, not our own test.

### A15. Our own propagation model

**What we did.** Built a minimal Rothermel-style propagation — ESA WorldCover fuel, Copernicus DEM slope, ERA5 wind — and fit it against the held-out detections.

**Result.** A single-parameter toy model, seeded from detections before 18:00 UTC and scored on the 2,562 held-out detections. Two settings tell the story, and they cannot be quoted together: at **R0 = 0.03 m/s** the arrival-time **MAE is 10.06 h** but the modelled area is **17,534 ha** (~3× the observed 5,767); at **R0 = 0.01 m/s** the area is 6,191 ha (within ~7 %) but the MAE is **23 h**. The timing and the area do not agree at any one setting. A row/index orientation bug was found and fixed (`own_sim_fixed.py`); it changed the MAE only to 9.85 h. This is a mechanism check, not an accurate predictor. Two further limits: arrival is scored against repeated satellite detections of the same fire, and the parameters were selected on the same observations used to report the score — so it is not a true held-out test.

![21 — Our own propagation model at R0=0.010 against the observed detections: area within ~7 %, arrival-time MAE 23 h.](img/21_own_simulation.png)

### A16. Experiment outcomes — summary

| # | Experiment | Outcome |
| --- | --- | --- |
| A1 | Observation timeline | 2,660 detections; 53 inside the evacuation window |
| A2 | Source mix | MTG 1,932 (10 min) + polar 728 (375 m); neither alone suffices |
| A3 | Archived perimeters | 12 snapshots; none during the evacuation window |
| A4 | Simulation runs in Spain | Yes; ≤3 min; but no historical date, max 2 concurrent |
| A5 | Active clusters | 94; 25 unconfirmed by FIRMS in 24 h |
| A6 | MTG layer | Sparse over Iberia, decisive at 10 min; African belt is burning, not wildfire |
| A7 | FIRMS × Deepfire | Agree; both rest on the same polar detections — MTG adds the 10-minute layer |
| A8 | Terrain / fuel | Shrub–grass with cropland breaks; FBFM40 mismatch for ELMFIRE |
| A9 | Wind (ERA5) | Southerly, gusting 54 km/h — the physical driver |
| A10 | Road-cut test | Inconclusive as a warning — first in-buffer detection 19:38 CEST, no availability timestamp |
| A11 | Egress cut-time field | Per-segment ToA over the 14,819-node graph |
| A12 | Ground truth | EFFIS 5,767 ha (seasonal WMS, not event-dated); Deepfire 9,172 ha |
| A13 | Values at risk | Catastro unanswered; the gap is the whole evacuation dataset, not just buildings |
| A14 | Simulation ceiling | ELMFIRE median Jaccard 0.133 (n=561); FARSITE 0.137 |
| A15 | Own model | MAE 10 h at R0=0.03 (area 3× over); area within 7 % at R0=0.01 (MAE 23 h) |
