# Model and validation decision — 20 September 2026

**Keep the native-grid model as a thermal-forecast experiment. Do not promote it to
physical spread or evacuation timing on the evidence currently available.** The most
important gap is the target and its validation, not model size or another training run.

This replaces the earlier proposal's stale tables and its claim that scalar area
scores validate the served growth vector. Corrected historical corpus results remain
in [stream3-baselines.md](stream3-baselines.md). The implementation contract is
[forecast-contract.md](forecast-contract.md); the research gate is
[thermal-evaluation.md](thermal-evaluation.md).

## What the three deliverables now do

| Deliverable | Working implementation | Limit of the result |
|---|---|---|
| Validate what is served | Actual July capture through causal replay → production centroid estimator → future detection-motion comparison; fire-bootstrap error bars on the two separate corpus baselines | One development incident is a diagnostic; corpus scores do not validate the online estimator |
| Use the same evidence clock | Flat and recorded replay filtered by availability; clusters rebuilt from available members; growth uses the replay issue time and six-hour history | Delivery is partly assumed, cluster membership retrospective; no operational delivery reconstruction |
| Hand off a usable forecast | Shared training/inference input builder, native-grid exporter, acceptance gate, checksum-validated HTTP API, real archived example, coverage/fallback/uncertainty | Thermal target only; offline producer, no automatic road-cut conversion or live scheduler |

## Findings that change the plan

The existing centroid estimator could split the same overpass and divide by a
near-zero time difference. That produced enormous numerical speeds. It now splits
by time, excludes within-overpass separation, and computes weighted timestamps
relative to a common origin. Regression tests cover the failure.

After that correction, the actual serving diagnostic gives median direction errors
of **94.9°, 108.3°, and 100.9°** at 1, 3 and 6 hours, on only 14, 13 and 14 computable
comparisons. These are correlated windows from one incident, scored against future
detection movement, not front truth. They do not justify a useful directional
forecast. Keep this endpoint descriptive. Do not label it a validated spread model.

Offline baseline uncertainty is now reported with the fire, rather than each row,
as the resampling unit. PT persistence's mean per-fire direction error is 54.3°
(bootstrap 95% interval 48.3–60.5°). This is a different statistic from the previously
reported pooled median. Error bars on that corpus do not transfer to an evacuation
route or an online centroid vector.

## What we actually have

The frozen full-v1 manifest contains **72,230 examples from 4,072 thermal episodes**:
60,766 train / 3,712 selection / 3,731 calibration / 4,021 test. It has 86 channels,
64×64 native cells, three hours of observation history and 1/3/6-hour targets. The
roles contain 62 / 7 / 9 / 10 geographic groups. Episodes are not independently
confirmed wildfire incidents. Multiple examples from an episode are not independent
experiments. The tensor audit found finite values and disjoint assigned roles;
that establishes data integrity, not accuracy or real-world domain coverage.

The target is any observed MTG thermal detection during a future window. Negatives
require all scheduled quality flags to say clear; unknown/cloud states are censored.
At six hours only about 30% of training cells and 43% of test cells have usable labels.
This asymmetric observability rule can affect prevalence and calibration. Persistent
source exclusions reduce one confounder; they do not turn every remaining thermal
episode into a wildfire or fully represent fires with no seed detection.

Terrain and land cover supply useful context, but land cover is not measured fuel
moisture or a fire-behaviour fuel model. Weather uses archived day-1 forecasts plus
an assumed publication allowance; about 4.54% of humidity joins are missing and
masked. An explicit model-run/receipt-time archive would improve the next dataset.
Do not reinterpret the old retrospective POWER-wind experiment as evidence that
forecast weather adds no value to this corrected pipeline.

Eight real frames from four train/selection episodes were rebuilt from raw inputs.
Their input and persistence arrays matched frozen full-v1 **bit for bit**. This is a
focused equivalence check, not an exhaustive proof over 72,230 frames. Its report is
`data/model/input-parity.json`; the final test partition was not opened for this check.

PT-FireSprd (2015–2021) and FireSpread_MedEU (2017–2023) support historical progression
benchmarks. They cannot directly validate a 2026 MTG-input model without matching
historical input products or new contemporaneous references. DeepFire simulations
and satellite-derived perimeters are comparators, not independent physical truth.

## Is this the right architecture?

A spatial model over aligned observation, weather and terrain channels is a reasonable
research baseline. Published [Next Day Wildfire Spread](https://research.google/pubs/next-day-wildfire-spread-a-machine-learning-dataset-to-predict-wildfire-spreading-from-remote-sensing-data/)
uses aligned spatial environmental features and neural benchmarks. That supports the
experiment family; it does not establish this implementation's superiority. A vision
LLM inspecting image tiles would add another unvalidated observation layer and would
still need geolocation, timing, coverage and calibration. It does not resolve the
missing physical target.

The architecture should keep four distinct steps:

1. **Observe:** quality-aware native thermal observations and other sensor evidence.
2. **Forecast thermal activity:** a held-out, calibrated 1/3/6-hour research forecast
   which earns promotion against persistence and spatial dilation on the same labels.
3. **Estimate physical hazard:** independent time-resolved progression references,
   fuels/moisture/weather uncertainty and a separately validated spread/arrival model.
4. **Decide egress:** route exposure, traffic/clearance assumptions, safe destinations,
   uncertain travel time and authority review. This remains Daniel's integration domain.

A physical simulator is a plausible comparator for step 3, not a shortcut around
validation. [FARSITE's documented model](https://research.fs.usda.gov/treesearch/4617)
includes fuel, moisture, wind, topography and fire-behaviour processes absent from a
simple centroid extrapolation. Coarse thermal data alone cannot justify precise
road-cut times. An LLM may summarize evidence; it should not manufacture the hazard
field used for routing.

## Next contributions, in order

1. Finish the currently declared run unchanged and record its frozen checkpoint,
   selection/calibration results and final-test protocol. The new robustness policy
   is prospective; a seed-0 pilot must not be relabelled as a predeclared three-seed
   experiment. A new independent holdout is needed for confirmatory tuning after test access.
2. Audit thermal performance by geography, season, episode length, missing weather,
   observability and new detections; include background windows and independently
   verified wildfire/non-wildfire labels for a detection claim. Add repeated seeds
   and feature ablations under a protocol fixed before a fresh holdout is opened.
3. Obtain contemporaneous 2026 progression/arrival references with timestamps and
   positional uncertainty. Freeze the comparison against DeepFire, persistence and
   a physical baseline on the same incident/issue/horizon/coverage. Evaluate boundary
   displacement, physical arrival error, missed hazardous road exposure and interval
   coverage. No eligible independently labelled MTG physical-arrival benchmark is
   established by the current archive.
4. Build a coherent weather-run cache keyed by initialisation, valid time, location,
   model and observed receipt time for a new dataset version. The
   [Single Runs API](https://open-meteo.com/en/docs/single-runs-api) exposes individual
   initialisation times; confirm variable/archive coverage before replacing v1 inputs.

More parameters, more epochs, or a double-descent-shaped curve are not acceptance
criteria. We can make a stronger product by narrowing its claim until these tests
succeed. We have not established that the new model beats DeepFire.
