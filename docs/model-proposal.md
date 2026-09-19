# Stream 3 — validation and baselines

Cluster growth vector · 19 Sep 2026 · updated after the plan review

## What this document is now

It began as a proposal to train a model predicting fire direction and rate. A review measured the
thing it would have to beat, and the result changed the stream: **the baseline wins**, and the
honest deliverable is a validated baseline shipped with its error bars, plus a harness that will
tell us if any model ever beats it.

This document records that measurement, corrects a premise the original version got wrong, and
specifies what Stream 3 builds. The plan itself is in [`work-plan.md`](work-plan.md).

## The measurement

Leave-one-event-out on PT-FireSprd, predicting burned area at *t+dt*:

| Model | R² | median MAPE |
| --- | --- | --- |
| Persistence | 0.9910 | 8.5 % |
| **Constant rate of spread** | **0.9926** | **7.8 %** |
| Learned gradient-boosted model | 0.8625 | 13.2 % |

Not close. A model trained on the available features loses to two rules that take a line of code.

That is not a reason to stop — it is the reason to be precise about what gets claimed. A measured
"persistence wins, and here is its error on held-out fires" is a stronger answer to the accuracy
criterion than a model whose number is worse and unreported.

## A premise this document got wrong

The original version argued that spread prediction has no labels, because the only event-dated
progression record was Deepfire's perimeter layer starting June 2026. That was true of the sources
we had looked at and false overall. Two labelled progression datasets were already downloaded and
parsed:

| Dataset | Content | Projection | Size |
| --- | --- | --- | --- |
| **PT-FireSprd** | 80 Portuguese fires, 2015–2021; 1,070 L1 progression steps; 34 events / 237 dated intervals parsed | EPSG:32629 | 33 MB (Zenodo 7495506) |
| **FireSpread_MedEU** | 103 events, 2017–2023; 320 positive progression steps | EPSG:3035 | 2.8 MB (Zenodo 18200075) |

Observed rate of spread across the parsed events: **median 53.4 ha/h, p90 1,155 ha/h**.

Validation by fire is possible on real events today. The 600-day Deepfire hotspot pull that the
original proposal treated as the long pole existed only to manufacture labels that already exist,
so **it is dropped**.

**One trap, recorded before somebody loses an afternoon to it.** PT-FireSprd's L1 `p` polygons are
*increments*, not cumulative perimeters. Sorting them by polygon size produces negative spread
rates. Cumulate by time — order by `burn_perio`, then `date_hour` — or the dataset lies.

## What the harness tests

Both targets, because the measurement above and the product claim are about different quantities:

- **Burned area at *t+dt*** — what the review measured, and where the baseline is very strong.
- **Bearing and rate** — what the Monitoring track actually asks for ("determine the direction they
  are spreading"), and what the original proposal targeted. Constant-ROS winning on area does not
  imply it wins on direction, and direction is the verb nothing currently provides.

Scoring the second is the reason this stream still exists. If a model beats persistence on bearing
and rate, that is a real result with a real place in the product. If it does not, we can say so with
a number attached.

## Baselines first

1. **Persistence** — same bearing, same rate as the last observed interval.
2. **Constant rate of spread** — the measured area-growth rate held constant.

Both are built and scored *before* anything is trained, on the same held-out events. They ship
unless something beats them.

## Method

**Split by fire, never by time.** Holding out hours inside one fire leaks the answer — the model has
seen how that fire behaves. Every number reported here and later is leave-one-event-out.

Corroborating evidence, from a separate experiment: a fire-pixel classifier trained on the MTG
archive under spatial-block cross-validation scored **AUC 0.80 ± 0.15, with folds running 0.58 to
0.99**. Same lesson from a different direction — when the held-out set shares geography with the
training set, the number is optimistic. The split decides the honesty of everything above it.

**Features.** Recent detections (FRP-weighted centroid, spatial spread, age), wind speed, direction
and gust, DEM slope and aspect, land-cover class, hour of day, time since last detection, and sensor
mix. The last two matter more than they look: a detection gap is not evidence the fire stopped, and
without them a model learns the sampling artefact as if it were fire behaviour.

**Model.** Gradient boosting over tabular features — minutes on CPU. Note that `lightgbm` does not
load in this environment; `sklearn.ensemble.HistGradientBoostingClassifier` is the same family
without the OpenMP dependency.

## What ships

`GET /api/growth?clusterId=` returns the baseline beside the model's numbers, both with their
held-out scores, and a `shippedBaseline` flag saying which one is on screen. The console prints the
number next to the claim rather than leaving it to the Q&A.

If a model wins on bearing and rate, it ships and the baselines travel with it as context. If it
does not, the baseline ships and the negative result goes in the writeup — which is worth as much
as a positive one when the question is "how do you know?"

## Non-goals

- **Not a spread simulator.** Deepfire's, and its own validation measures the ceiling — median
  Jaccard 0.133 over 561 real fires. Worth stating plainly: Deepfire exposes no spread *collection*.
  Its perimeters are observed only, and the simulation is a separate async API, so wherever this
  document says "the perimeter" it means an observed one.
- **Not a detector.** That is the Early detection track, and Deepfire's fusion already does it.
- **Not the cut-time mask.** Detection accumulation for the cut mask is Stream 2's, though the two
  share the detection-drift caveat.
- **Not the alert text.**

## Can Jev help train it? No.

Checked against the vendor's API reference and the jev-1.13 model page. Recorded here so nobody
re-opens it:

- **It cannot train, fine-tune or produce a model.** One endpoint, three question types, no
  embeddings, no vector output, no batch API. It returns a typed decision, not a representation.
- **It cannot generate these labels.** Displacement between detection windows is arithmetic, and
  Jev's published limits say it "is not a calculator", "does not count reliably", and reads dates
  as text rather than ordered values — each of which is a step in the label pipeline.
- **It could serve as a feature source** if we wanted per-cluster judgement features. An independent
  replication reports that extracting scored dimensions and fitting local weights beat a single
  direct question on classification tasks. An add-on, not the model.

The verification gate in the plan is deterministic OSM checks; Jev is out of scope there too.

## Open

- **Whether a model beats the baselines on bearing and rate.** The harness will say. Until it does,
  the baseline is what ships.
- **Whether the area result holds on FireSpread_MedEU.** It was measured on PT-FireSprd only. Running
  the second dataset is cheap and either confirms the finding or complicates it — both worth knowing
  before we quote the number.
