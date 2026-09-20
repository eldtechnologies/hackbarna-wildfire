# Growth baselines and their evaluation scope

`GET /api/growth?clusterId=...` exposes observed detection-centroid motion, two
baseline vectors and offline corpus scores. Its `scoreScope` is
`offline_corpus_baselines`: those scores do **not** validate this online centroid
estimator or establish a safe evacuation route. The response labels each vector's
`rateBasis` to distinguish detection-centroid drift from a frontal corpus mean.

## Corpora and corrected units

| Corpus | Area fires / pairs | Direction-rate fires / pairs | Median step |
|---|---:|---:|---:|
| PT-FireSprd v0.08 | 72 / 593 | 69 / 421 | 1.00 h |
| FireSpread_MedEU | 60 / 173 | 59 / 113 | 24.37 h |

The primary rows exclude gaps longer than seven days. The loader also requires
three usable states. These are properties of the selected event set; a different
loader can produce different counts and scores.

PT-FireSprd L2 `ros_p` is **metres per hour**, documented in Table A5 of the
[published dataset paper](https://essd.copernicus.org/articles/15/3791/2023/).
Divide by 1,000 to obtain km/h. The earlier `/100` conversion overstated all PT rates
tenfold. The corrected mean served as `constant_ros` is **0.9569 km/h**, replacing
9.5688 km/h. The committed fixture and metrics were regenerated from raw shapefiles.

MedEU geometry is projected in EPSG:3035 and must be reprojected before applying a
longitude/latitude distance calculation. Its measured representative-point drift
averages **0.0173 km/h**. It is not frontal advance and is never used as the served
constant rate. The former 222 km/h value was a CRS error, not a fire-behaviour result.

## Offline results

| Corpus | Area predictor | Pooled R² | Median per-fire R² | Median MAPE |
|---|---|---:|---:|---:|
| PT-FireSprd | persistence | 0.9897 | 0.5720 | 6.47% |
| PT-FireSprd | constant growth | 0.9856 | -0.0800 | 9.46% |
| FireSpread_MedEU | persistence | 0.7681 | -3.4177 | 37.48% |
| FireSpread_MedEU | constant growth | 0.8026 | -10.9490 | 48.49% |

The historical key `constant_ros` in the **area** scores means a fixed **area-growth
rate** fitted from other fires, in hectares/hour. That predictor differs from the
API vector using a fixed frontal speed in km/h. Do not interpret the area score as
validation of the served frontal speed.

| Corpus | Direction/rate predictor | Median bearing error | Rate R² | Rate MAPE |
|---|---|---:|---:|---:|
| PT-FireSprd | persistence | 42.55° | 0.0870 | 56.61% |
| PT-FireSprd | learned model | 56.18° | 0.1192 | 73.67% |
| FireSpread_MedEU | persistence | 70.09° | -1.0431 | 88.41% |
| FireSpread_MedEU | learned model | 86.90° | -0.0833 | 83.84% |

The model uses previous area, previous rate, interval duration and previous bearing
with an availability flag. It has no weather, terrain or fuel inputs. Each fire is
held out in turn. Missing directions are not encoded as northward targets, and
untrained folds are excluded from scores. Counts describe the eligible events for
the target, rather than copying the larger corpus count.

The model improves rate R² but worsens bearing error in both corpora, so the API's
model slot remains null. This does not establish that a physical-input model cannot
beat persistence. High pooled scalar-area R² at short horizons also does not imply
accurate fire-front location; persistence does not win by construction. A 45°
quantization step in another dataset is not a 45° lower bound on bearing error here.

## Serving and failure behaviour

Detection motion uses chronological halves sorted by parsed UTC instants. Position
and time centroids use identical FRP weights. Invalid timestamps are excluded from
both calculations. Sparse or coincident observations return a null direction/rate.
This remains a sensor-dependent motion estimate, not a measured advancing fire front.

The API returns 400 for absent or non-string cluster IDs, 404 for an unknown cluster,
and 502 for a corrupt metrics file. Missing metrics files and valid `computed:false`
model/constant-rate blocks preserve available baseline results. The executable checks
its recommendation ledger before creating the app or accepting requests.

## Reproduce

Point `STREAM3_DATA_DIR` at a directory containing the `ptfiresprd/` and `medeu/`
source layouts described in `harness.py`. Then, from the repository root:

```bash
uv run --with geopandas --with pyogrio --with pandas --with scikit-learn python tools/model/harness.py
uv run --with geopandas --with pyogrio --with pandas --with scikit-learn python -m pytest tools/model/test_harness.py -q
npm ci
npm run typecheck
npm test
npm run build
```

Generation refuses incomplete or non-JSON results before replacing artifacts.
Tests reproduce the baseline metrics from committed fixtures and exercise unit
conversion, CRS equivalence, missing data, fold eligibility, HTTP errors and startup.
The raw corpora remain external; the compact derived fixtures and scores are committed
under `data/model/`. The console has not yet wired this endpoint into its display.
