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

Measured on held-out fires, gap-filtered to steps of 7 days or less.

### Burned area at the next state

| Corpus | Predictor | R² | Median MAPE |
| --- | --- | ---: | ---: |
| PT-FireSprd | persistence | 0.9897 | 6.5 % |
| PT-FireSprd | constant ROS | 0.9856 | 9.5 % |
| FireSpread_MedEU | persistence | 0.7681 | 37.5 % |
| FireSpread_MedEU | constant ROS | 0.8026 | 48.5 % |

### Bearing and rate

| Corpus | Predictor | Median bearing error | Rate R² | Rate MAPE |
| --- | --- | ---: | ---: | ---: |
| PT-FireSprd | persistence | 42.6° | 0.087 | 56.6 % |
| PT-FireSprd | model | 56.2° | 0.119 | 73.7 % |
| FireSpread_MedEU | persistence | 97.5° | −1.257 | 81.2 % |
| FireSpread_MedEU | model | 99.1° | −0.053 | 58.2 % |

The model is gradient boosting over the only features these corpora carry: the
previous area, the previous rate, the elapsed time, and the previous bearing. That
is the honest ceiling of a tabular model here — **no wind, terrain, fuel or
moisture exists in either corpus**, which is exactly the input a spread model
actually needs.

## Three findings the numbers force

**1. The area result is a horizon effect, not a property of fire.** The plan's
headline R²=0.99 reproduces on PT-FireSprd — at a **1-hour median step**. At
MedEU's 24-hour cadence persistence falls to **0.77** and its median error goes
from 6.5 % to 37.5 %. Persistence looks strong because the next hour's perimeter is
nearly the current one. Quote 0.99 without naming the horizon and the number is
misleading.

**2. The direction target is where the baseline fails.** Persistence carries a
42.6° median bearing error on PT-FireSprd and 97.5° on MedEU. A direction that is
wrong by 40° is not a direction. This is the quantity the product claim depends on
— the arrow on the screen — and the baseline has little skill at it.

**3. The model loses on direction on both corpora.** It does not rescue finding 2.
It is marginally better on rate at MedEU (R² −0.05 against −1.26) and worse on
PT-FireSprd, but on the bearing target it is worse on both. **The baseline ships.**

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

- **The MedEU rate is not a rate.** A centroid displacement over a *growing*
  polygon reaches hundreds of km/h. The harness marks that corpus
  `rate_basis: 'centroid_drift'` and the server refuses to serve it as the constant
  rate of spread. Only PT-FireSprd's `ros_p` is a rate of frontal advance.
- **MedEU's bearing is weak for the same reason.** Treat the 97.5° as indicative.
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
