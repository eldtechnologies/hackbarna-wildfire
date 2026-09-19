# Model proposal — growth vector per fire cluster

For the HackBarna 3.0 team · 19 Sep 2026 · proposal for discussion, nothing built yet

## The proposal

Train **one small model** that predicts, for each active fire cluster, **where the fire is heading and how fast** — a direction and a rate over the next few hours.

Not a spread simulator. A gradient-boosted regressor over tabular features, with two trivial baselines it has to beat. If it doesn't beat them, we ship the baseline and report both numbers.

## Why this one, and not a fire-spread model

Two facts decide it.

**1. Our own track asks for direction, and Deepfire doesn't give it.** The Monitoring track reads: *"draw real-time perimeters of active fires from satellite data, determine the direction they are spreading, and simulate their movement."* Deepfire supplies perimeters and a spread simulation. It does not supply direction — clusters carry only `first_observed`, `last_observed`, `active` and `id`. No area, no rate, no growth attribute of any kind. The middle third of our own track's requirement is the gap, and it is the one piece nobody has to reach for.

**2. Spread prediction has no labels.** Training a spread model means learning from observed fire progressions. The only event-dated progression record is the perimeter layer, and it starts **June 2026** — in our region that is one fire with 12 snapshots. The industry spread models train on years of archives across tens of thousands of fires. On one event we would train a memoriser and have no honest way to report its accuracy.

Direction and rate are a different problem, because they can be derived from the hotspot archive we already have back to **January 2025**.

## What it predicts, exactly

For each active cluster at time *t*:

- **Direction** — bearing of movement (degrees, or a coarse class — see open questions)
- **Rate** — rate of frontal advance (km/h)
- *or* jointly: displacement in km over the next *N* hours

Horizon *N*: fix from validation, start at 1 h and 3 h.

This is deliberately **observation-driven nowcasting**, not forecasting from ignition. It answers "where is this one going" for a fire that is already burning — the question a coordinator watching a live screen actually asks.

## Data

| Source | Used for | Status |
| --- | --- | --- |
| `deepfire:hotspots` | label source and primary features — detections with FRP, source, timestamp | archive since Jan 2025; **pull not yet done** |
| `deepfire:clusters` | grouping detections into fires | live |
| `deepfire:satellite-perimeters` | independent check on a subset (Jun 2026 onward) | live |
| MTG-I1 FCI (LSA-509) | high-cadence detections, 10-minute scans | 2026 archive, 36,815 scans / 77 GB |
| ERA5 via Open-Meteo | wind speed, direction, gust, RH, temperature | free, no key |
| Copernicus DEM GLO-30 | slope, aspect | used in the spike |
| ESA WorldCover 10 m | fuel class | used in the spike |

The pull that matters — Iberia bbox, Jan 2025 to now, paginated — is the long pole. It can run in the background while the demo is built.

## Labels — how they are derived

For each cluster, take a window **[t−3 h, t]** and the following window **(t, t+1 h]**. Compute the FRP-weighted centroid of the detections in each. The label is the displacement vector between them.

That is a measurement, not a judgement — which is why this problem has labels and spread prediction doesn't.

Three error sources to handle explicitly rather than hope away:

- **Detection drift is not fire motion.** New detections appear at the head, old ones age out. The centroid moves for reasons that are not spread.
- **Sampling is uneven.** MTG arrives every 10 minutes; polar sensors can be ~2.5 h apart; the July fire had a 40-minute MTG gap (16:28→17:08 UTC) that is a gap in observation, not evidence the fire stopped.
- **Clusters can be sparse.** 25 of 94 Iberian clusters had no FIRMS detection within 10 km in 24 h.

So: keep only clusters with enough detections in **both** windows, and carry detection count, age and source mix as features so the model can learn the sampling artefact rather than absorb it as fire behaviour.

## Baselines it must beat

1. **Persistence** — next displacement = last displacement
2. **Wind-drift** — move downwind (ERA5 direction) at the observed rate

Both are a few lines of code. Build them first, treat them as the thing to beat, and report all three numbers side by side on held-out fires. If the model doesn't beat persistence, we ship persistence and say so — that is a real accuracy result, and it answers the accuracy criterion better than an unvalidated simulator does.

## Validation

- **Split by fire, not by time.** Holding out hours inside one fire leaks the answer — the model has seen that fire's behaviour.
- **Report a band**, with the baseline beside it. No single number without an error bar.
- **Include the July fire** in the test set: it is the one event we can compare against a real outcome (the AL-6109 cut, the reported timeline).
- **State what the score measures**: agreement with satellite detections of the fire, not with the fire front. Those are not the same thing, and the difference is the honest caveat to put on the slide.

## Where it plugs into the product

- **Threat corridor** (values-at-risk overlay): a direction and rate turns "assets within 10 km of the perimeter" into "assets in the path within the next three hours".
- **Time-of-arrival field**: helps fill the gap after the last observation.
- It does **not** touch the alert text. That stays template-selected and OSM-checked.

## Effort and sequencing

| When | What |
| --- | --- |
| Now, background | Hotspot archive pull — Iberia bbox, Jan 2025 → now, paginated |
| After M2 (hotspots + perimeters live) | Dataset build: windowing, labels, features → then baselines → then the model |
| H38 freeze | Nothing new lands after |

The modelling itself is hours, not days: tabular features, a few thousand rows, gradient boosting. It must not compete with the demo path.

## Kill criteria

- Pull can't produce enough clusters with dense detections → narrow the bbox or the season, or drop it
- Baseline matches the model → ship the baseline, report both
- It threatens the demo path → drop it. Demo quality is a judging criterion.

## Non-goals

- **Not a spread simulator.** That is Deepfire's, and its own validation measures the ceiling (median Jaccard 0.133 over 561 real fires).
- **Not a detector.** That is the Early detection track and Deepfire's fusion.
- **Not ignition-type screening.** A valid classifier with real labels, but it is a filter nobody in the demo ever sees.
- **Not the alert text.**

## Jev: what it can and cannot do for us here

Checked 19 Sep 2026 against `docs.typesafe.ai/api` and the jev-1.13 jaggedness page.

**It cannot train or fine-tune anything.** One endpoint, `POST /v1/systemone`; three question types (`noul`, `choice`, `score`); no embeddings, no vector output, no batch API. It returns a typed decision, not a representation — and its own docs say it "is not trained to generate text".

**It cannot generate our labels.** Our labels are measured, not judged: displacement between consecutive detection windows is arithmetic, and Jev's published limits say it "is not a calculator", "does not count reliably", and reads dates as text rather than ordered values. Every one of those is a step in our label pipeline.

**It can, however, serve as a feature source.** An independent replicate of Jev's interface reports that extracting 12–14 scored dimensions and fitting local weights beat a single direct question on classification tasks. If we later want per-cluster judgement features — "is this detection pattern one front or several?" — that is a legitimate call. It is an add-on, not the model.

**Its limits matter if we do call it:** no arithmetic, no reliable counting, dates as text, accuracy falls as unrelated content grows in the `state`, and it does not treat injected content as hostile. There is also a practical dependency: access is a waitlist, and if the key doesn't arrive the pipeline runs without it.

So Jev stays where the plan already puts it — **selecting and verifying the alert sentence** — and stays out of training.

## Open questions for the team

1. **Horizon** — 1 h, 3 h, or both?
2. **Direction as bearing or class?** A coarse class (N/NE/E/…) is easier to validate and easier to show on screen; a bearing is more useful downstream. 
3. **Who owns the archive pull**, and does it run somewhere that stays awake?
4. **Do we have the Deepfire API key in hand?** The pull needs it before anything else here can start.
