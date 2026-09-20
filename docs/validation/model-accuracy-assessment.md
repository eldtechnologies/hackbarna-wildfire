# Is the model good enough?

**Recommendation: keep it as an explicitly experimental thermal-probability layer; do not replace the spread simulation or use it as the default predictor. The later [paired comparison](deepfire-paired/Measured%20comparison.md) also does not establish superiority to DeepFire.**

This audit found a real ranking improvement over fixed baselines on previously held-out geography, but the model misses most newly observed detections at ordinary probability thresholds. That is useful research evidence, not sufficient product accuracy.

## What was tested

The frozen next-run U-Net pilot, seed 0, epoch 10, selected on its original validation split and calibrated on separate geography. This is a different, corrected pipeline from the state-plus-relative-position benchmark in the screenshot. The model, calibration, dataset and horizons were not tuned during this audit.

All 252 nonempty test episodes and 4,021 issue times were evaluated, covering 10 geographic groups, August 1–September 17. Some episodes have no valid labels at a particular horizon. All test tensor hashes matched the frozen manifest. Local MPS inference reproduced the earlier whole-mask scores within 0.00003 AP; a 16-sample CPU/MPS check differed by at most 0.0000024 in probability.

**New detection** means a cell with no observed thermal detection in any of the six past bins (three hours), at least one observable past scan, and a valid future label. It does not establish previously unburned land, a spreading fire front or an independently confirmed wildfire. Past FRP and quality-fire indicators had zero contradictions in the test set.

## Accuracy on those new detections

| Horizon | Model AP | Distance baseline AP | Precision at 0.5 | Recall at 0.5 | 95% CI, paired event-AP gain over distance baseline |
| --- | ---: | ---: | ---: | ---: | --- |
| 1 h | 0.0863 | 0.0281 | 46.0% | 2.1% | [0.050, 0.190] |
| 3 h | 0.1023 | 0.0358 | 64.0% | 4.3% | [0.013, 0.128] |
| 6 h | 0.0795 | 0.0382 | 68.8% | 5.6% | [0.034, 0.109] |

AP measures ranking across thresholds; it is not a percentage of correct forecasts. The confidence intervals average episode AP within geography and bootstrap the 10 groups, with 2,000 draws and a fixed seed. They support improvement on this dataset, not physical independence of every episode or pixel. Paired episode-AP comparisons include 138, 144 and 146 positive-label episodes at 1, 3 and 6 hours respectively; all 252 episodes contribute to pooled error statistics when their cells are valid. A second fixed baseline based on all past detections also lost at every horizon.

At six hours, threshold 0.5 gives **293 correct alerts, 133 false alerts and 4,893 missed positive cell-issue pairs**: 68.8% precision, 5.6% recall. These are repeated cell/forecast pairs, not unique fires or hectares. At 0.1, recall rises to 16.4%, but precision falls to 7.9% (848 correct and 9,826 false alerts). These fixed thresholds were inspected in response to the product-accuracy question, not optimized on the holdout.

The six-hour novel-cell Brier score is 0.000747, slightly worse than predicting zero everywhere (0.000736). Rare positives make the zero baseline deceptively strong, but this still prevents a claim that the model’s probabilities are uniformly better. The low overall false-positive rate must not be read as high precision.

## Input leakage checks

- Zero shared event IDs, geographic groups or overlapping 64×64 patches between training, selection, calibration and test roles.
- Training/validation labels end by August 1; test issue times begin afterward. Zero boundary violations or samples preceding seed availability.
- Raw reconstruction in one deterministically selected episode from each of the 10 test groups reproduced frozen X/P exactly.
- Removing future observations, injecting extreme future FRP and replacing unavailable quality scans with fabricated fire did not alter those inputs. The unavailable-scan poisoning was exercised in every group.
- Inputs gate scan availability by the later of NetCDF creation time and an assumed 45-minute delay. Weather uses archived forecasts with a documented lead/publication allowance. Actual operational delivery logs are unavailable, so a universal “no possible leakage” claim would be too strong.

The full holdout had already been evaluated before this request. This is an exploratory re-audit, not a newly untouched test. Only one training seed was evaluated. The cohort consists of retrospectively defined thermal episodes, with a time window chosen around episodes; this does not measure continuous real-world fire detection or independent burned-area spread.

## Why the screenshot is insufficient

The legacy five-fold split holds out episode IDs but shares 16–25 spatial clusters per fold. Its crop center uses future episode observations: a counterexample changing only a later observation changed the earlier input grid and raster. Its current window includes [t,t+1 hour), and it lacks the newer publication/quality handling. This establishes a dependency problem, not a measured estimate of how much it inflated AP. The old 0.54 score should not be presented as proven leakage-free fire-spread accuracy.

## DeepFire comparison

[DeepFire’s documented simulation endpoint](https://docs.deepfire.co/api/fire-spread) supports ELMFIRE/ForeFire, point or cluster ignition, 1–24 hours and hourly spread polygons. Our model returns a 64×64 native-pixel probability raster for thermal detection within 1, 3 and 6 hours. These are different targets.

No matched DeepFire-versus-model benchmark was available for this initial audit. The subsequent [paired thermal comparison](deepfire-paired/Measured%20comparison.md) uses archived simulations on a common target and reports its limits. Starting a simulation now would not establish performance at the historical test issue time; the documented request does not expose a historical weather/issue-time parameter. To claim a winner we need matched issue times, available inputs and independent time-resolved perimeter/arrival labels, then score both predictions on the same spatial target. Neither the AP numbers above nor a plausible-looking simulation proves superiority.

## Visual output

[Accuracy summary](../../docs/screenshots/model-accuracy-summary.png) and [actual forecast examples](../../docs/screenshots/model-forecast-examples.png) show the result. Forecast examples include past observed cells, the six-hour model probability map, the fixed distance baseline and subsequently observed new detections. Gray cells are excluded/unknown; cyan circles locate observed positives. The rows use lower-quartile, median and upper-quartile episode AP, with the earliest maximum-positive frame inside each episode for legibility. Display crops do not affect model inputs or scores.

The probabilities can be rendered as a time-slider heatmap. They do not directly supply a validated perimeter, a fire arrival time, a confidence bound for a road, or an evacuation recommendation. No model was promoted or connected to those decisions during this work.

## Reproduction and evidence

The owned integration branch contains `tools/validation/novel_detection.py`, `input_audit.py`, unit tests and the frozen audit protocol. Run with the existing full-v1 directory, frozen checkpoint and the exact pinned trainer source specified in the protocol. [full-results.json](full-results.json) includes all event metrics and operating points; the accompanying input and legacy audit JSON files contain the checks above.


The original protocols remain unchanged. `trainer-source-lock.json` pins all source modules of the original trainer; audit commands copy only these verified bytes into a private import directory before running them. Both checkpoint paths use PyTorch's restricted weights loader. The paired command also checks its input adapter and the frozen case, weather and simulation inventory before inference.
