# Stream 3 — growth baselines and the measured model result

What a cluster's growth estimate is, what the naive predictors score on held-out
fires, and why the baseline is what ships.

The short version: **persistence wins the area target and no model built from these
corpora beats it on direction.** Both numbers travel with every response.

## What runs where

| Part | Lives | Why |
| --- | --- | --- |
| `tools/model/harness.py` | this repo | The scoring harness. Committed so the numbers are reproducible. |
| `data/model/metrics.json` | this repo | The harness output the server reads. |
| `data/model/fixture-*.json` | this repo | The extracted event series, so a reader can check a number without the bulk data. |
| `server/model/` | this repo | The served baselines, the metrics loader, and `GET /api/growth`. |
| The corpora | the data box | PT-FireSprd and FireSpread_MedEU. Too large to commit. |

## Method

**Leave-one-fire-out, never leave-one-step-out.** Every score holds out a whole
fire. Holding out steps inside one fire leaks the answer: the model has already
seen how that fire behaves. Any parameter a baseline fits — the constant rate of
spread — is fitted on the other fires only.

**Two corpora, reported separately.** Their cadences differ by an order of
magnitude, and each carries a different usable signal, so pooling them would
average two different measurements.

| Corpus | Median step | Fires | Signal |
| --- | --- | --- | --- |
| PT-FireSprd | 1.0 h | 72 | `spdir_p` and `ros_p` per period: a real bearing and a real rate of advance |
| FireSpread_MedEU | 24.4 h | 60 | Cumulative burned area per acquisition; direction from centroid displacement |

**Two targets.** Burned area at the next state, and bearing plus rate. They are
different quantities, and one baseline winning the first says nothing about the
second.

## Results

Measured on held-out fires, gap-filtered to steps of 7 days or less. **Two
aggregates, because they disagree and either alone misleads:**

- **Pooled R²** — one R² across every held-out pair. Variance-weighted, so a fire
  that grows through three orders of magnitude owns most of it.
- **Per-fire median R²** — the typical fire. This is the number to quote when
  asking "does it work on a normal fire".

### Burned area at the next state

| Corpus | Predictor | Pooled R² | Per-fire median R² | Median MAPE |
| --- | --- | ---: | ---: | ---: |
| PT-FireSprd | persistence | 0.9897 | **0.5720** | 6.5 % |
| PT-FireSprd | constant ROS | 0.9856 | **−0.0800** | 9.5 % |
| FireSpread_MedEU | persistence | 0.7681 | **−3.4177** | 37.5 % |
| FireSpread_MedEU | constant ROS | 0.8026 | **−10.9490** | 48.5 % |

The gap between the columns is the whole story. Pooled R² 0.99 says "a few enormous
fires are predicted well". Per-fire median 0.57 says "the typical fire is not".
On MedEU the per-fire median is **negative**: persistence is worse than the fire's
own mean, because a growth series is non-stationary and carrying the last value
forward systematically under-predicts it.

### Bearing and rate

| Corpus | Predictor | Median bearing error | Rate R² | Rate MAPE |
| --- | --- | ---: | ---: | ---: |
| PT-FireSprd | persistence | 42.6° | 0.087 | 56.6 % |
| PT-FireSprd | model | 56.2° | 0.119 | 73.7 % |
| FireSpread_MedEU | persistence | 70.1° | −1.043 | 88.4 % |
| FireSpread_MedEU | model | 86.9° | −0.083 | 83.8 % |

The model is gradient boosting over the only features these corpora carry: the
previous area, the previous rate, the elapsed time, and the previous bearing. That
is the honest ceiling of a tabular model here — **no wind, terrain, fuel or
moisture exists in either corpus**, which is exactly the input a spread model
actually needs.

## The metric is the weak part, not the model

**R² on scalar burned area cannot separate a useful model from a no-change model.**
That is not a guess about this harness; it is what the published benchmarks show.
Persistence is an explicit baseline in both of them, and it is the *worst* model on
the metrics the field actually uses:

| Benchmark | Metric | Persistence | Best learned model |
| --- | --- | ---: | ---: |
| Next Day Wildfire Spread (Huot 2022) | AUC(PR) | 11.5 | 28.4 |
| WildfireSpreadTS (Gerard 2023) | test AP | 0.193 | 0.404 |

Persistence has the **highest precision** in NDWS (35.7 %) and the lowest AUC. On
area it looks excellent. On a mask it is the baseline everything beats by roughly
**2–2.5×**.

So the correct reading of the tables above is *not* "a model is unnecessary". It is
**"this metric cannot answer the question, and a model without weather, terrain and
fuel has nothing to learn from"**. The field evaluates spread with AUC(PR), AP, F1
or IoU on a mask. This harness reports R² on a scalar, because that is what the
plan's measurement used. That choice should change before any model is compared
against these numbers.

Two further protocol notes: this split is **leave-one-fire-out**, which is harder
than the published random-week split; and the plan's original 0.9910 reproduces
here as pooled R² 0.9897, so the number was measured correctly and read too
generously.

## Four findings

**1. The area result is a horizon effect on top of an aggregation effect.** The
plan's R²=0.99 reproduces on PT-FireSprd at a **1-hour median step**, and it is
pooled. At MedEU's 24-hour cadence persistence falls to 0.77 pooled and **−3.42**
per fire. Quote 0.99 without naming the horizon *and* the aggregation and the number
is misleading twice over.

**2. The direction target is where the baseline fails.** A random heading gives a
median error of 90°. The Global Fire Atlas reports spread direction at 45°
quantisation, so 45° is the resolution floor for daily satellite direction.
Persistence lands at **42.6° on PT-FireSprd** — better than chance, at the floor, and
only just. At 24 h it is **70.1°** — better than chance, but well above the floor
and far worse than the hourly figure, so daily direction skill is weak rather than
absent.

**3. The model does not rescue finding 2, and cannot here.** It is marginally better
on rate at MedEU and worse on PT-FireSprd, but on bearing it is worse on both
(56.2° against 42.6°). The reason is in the feature list, not the architecture.

**4. The baseline ships for now — for a stated reason.** `model` is null because
nothing beat the baseline *on this metric with these features*. That is a statement
about the harness, not a claim that a model is not worth building. On mask metrics
the literature says the opposite by 2–2.5×.

## What ships

`GET /api/growth?clusterId=` returns the observed advance for a cluster, both
baselines for the same cluster, and every held-out score behind them. `model` is
`null`, and `shipped` names `persistence`. The console prints the baseline score
beside any model claim so the reader can see which one is winning.

A number without its corpus is a number without its caveat, which is why
`GrowthScore` carries `corpus` and the response carries `shipped`.

## Known limits

- **The MedEU event set is loader-dependent.** The harness keeps a fire only when it
  has at least three usable states *and* polygon geometry, and it drops steps of more
  than 7 days. That gives 60 fires and 173 pairs. An independent pass that kept every
  fire with two states and no gap filter got 103 fires and 218 pairs, with
  persistence R²=0.7233 against the 0.7681 above. Same direction, same conclusion,
  different event set - so quote the loader rule with the number.

- **The MedEU rate is a drift, not a rate of advance.** It is the displacement of
  the centroid of a *growing* polygon, so it measures where the fire's mass moved,
  not how fast the front ran. The harness marks the corpus
  `rate_basis: 'centroid_drift'` and the server refuses to serve it as the constant
  rate of spread. Only PT-FireSprd's `ros_p` is a rate of frontal advance.
- **MedEU's geometry was previously in the wrong units, and that is now fixed.**
  The file is EPSG:3035 - projected metres - and the loader fed those numbers to a
  haversine that expects degrees, so every MedEU bearing and rate was wrong. The
  222 km/h mean rate this doc first reported was that error, not a property of
  centroid drift. Corrected: 0.017 km/h, and the bearing error moves from 97.5° to
  70.1°. The area scores were never affected - they come from the attribute table -
  which is why the defect survived every test written against the area target. The
  loader now reprojects to EPSG:4326, and `tools/model/test_harness.py` presents one
  fire in both CRSs and asserts the two give the same rate.
- **The all-pairs rows stay in `metrics.json` but are never served.** One 8738-hour
  pair drives constant-ROS to R²=−28.5. The gap-filtered row is the usable reading
  and the only one the server reads.
- **The fixture is the extracted series, not the corpora.** It is enough to
  recompute the scores; it is not a substitute for the source data.

## Reproduce

```bash
uv run --with geopandas --with pandas --with scikit-learn python tools/model/harness.py
bun run test
```

The harness reads `STREAM3_DATA_DIR` and defaults to the data-box path.
