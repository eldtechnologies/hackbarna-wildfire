# Corrected next-run pipeline

This is an isolated replacement data/training path. It does not modify the older
`tools/pipeline` implementation, the active RunPod experiment, or its checkpoints.
Existing legacy NPZ shards are incompatible with this schema and must not be mixed in.

## Target and limits

Predict **an observed MTG thermal detection in each native pixel within 1, 3 and 6 hours**,
conditioned on a known thermal episode. This is not verified wildfire classification,
burned area, a fire-front arrival time, or evidence that evacuation roads are safe.
It cannot establish superiority to DeepFire without a common independently labelled
benchmark and matching inputs, dates and task definition.

The catalogue contains unverified thermal episodes. A fixed January–March recurrence
heuristic excludes persistent heat from the loss, without relabelling it as no fire.
That prior is a training-period label filter, not an operational detection service;
early products lack publication metadata. Other industrial sources can remain.
Events are defined retrospectively and the dataset does not measure the false-alarm
rate of a continuous, region-wide incident detector. Include independently labelled
non-fire locations before making that claim.

## Corrections

- Extract only native ListProduct scans. Parse `ACQTIME` with its exact UTC format,
  retain scan identity and native coordinates, and reject bad timestamps/duplicates.
  Analysis CSVs cannot be ingested as extra observations.
- Use the native quality grid for labels: flags 1/2 are thermal detections; a negative
  requires every scheduled scan to be flag 0. Cloud, absent scans, unprocessed pixels,
  water and other unknown states are excluded from loss. Missing FRP is not no fire.
- Use the episode's first detection as the fixed crop centre. Gate its inclusion and
  every past observation on `max(product creation, scan start + 45 minutes)`.
  Products without creation times are unavailable as causal inputs. Late seeds can
  eliminate an episode. Delivery time is still an assumption, not a recovered log.
- Keep six-hour tails, including all-negative futures. Cap episodes without choosing
  samples according to future positive labels. Persistence follows the latest
  observable scan, retaining the previous state through cloud.
- Join archived ECMWF IFS forecasts by quantized location, model, valid time and
  request interval. Use Open-Meteo's 24-hour-lead archived forecasts with a six-hour
  publication allowance. Never join weather by a transient episode ID or substitute
  retrospectively measured POWER values as if they were live forecasts.
- Represent missing weather values with explicit validity channels. Missing locations,
  hours, model identities or future-unavailable forecasts are hard errors. Masked
  humidity does not erase valid wind. Meteorological wind bearings become signed
  east/north velocities.
- Use measured terrain with validity, correct north-up/rotated-grid gradients, and
  categorical WorldCover. Do not invent an ordinal fuel map. Terrain and forecasts
  remain coarse; sub-kilometre fuel moisture, spotting and suppression are absent.
- Separate training, checkpoint selection, calibration and final-test geography.
  Purge overlapping 64×64 patches between **all four** roles. Training/validation
  labels end no later than August 1; test issues start August 1 or later.
- Balance training contribution by episode. Use finite checks, masked stable loss,
  monotonic horizons, independent calibration, and a frozen final test. Confident
  false alarms retain gradients. No failed prediction is replaced with zero.
- Use sample-addressable NPY memory maps and streaming checkpoint selection.
  Event output is atomic. Explicit resume verifies source/config/code identity and
  artifact hashes. Missing downloads and transport errors cannot silently become data.

## Data and tensor contract

64×64 **native** FCI pixels, with ground footprint varying by location. Do not assume
each pixel is one kilometre on the ground in Europe.

86 input channels: 24 past-observation channels (six half-hour bins), 16 terrain and
land-cover channels, 40 weather values/validity channels (issue time and 1/3/6 hours),
four offsets from the observed fire state, and two UTC hour encodings.

Each event directory contains `X.npy` (float16), `Y.npy` (uint8), `M.npy` (bool),
`P.npy` (latest observed binary state), `issue.npy`, and checksummed `event.json`.
Only labels with `M=1` enter loss or metrics. `Y` describes observations, not physical
absence behind cloud. The output manifest freezes channel order and horizon semantics.
NetCDF provenance records paths, sizes and mtimes rather than hashing the entire raw
archive; output tensors and weather records have content hashes. Preserve the archive.

## Prepare a new dataset

Use Python 3.12 and install `requirements.txt` in an isolated environment. On RunPod,
install the PyTorch wheel appropriate for its CUDA environment. The tested local
library versions are recorded in the accompanying handoff, not a GPU lockfile.

Run from the repository root. Set `WF_ARCHIVE` to the downloaded 2026 archive and
`WF_DATA` to a **new** staging directory outside any active training dataset.

```bash
python -m tools.next_run.extract --archive "$WF_ARCHIVE" --out "$WF_DATA/extract" --workers 8
python -m tools.next_run.index --extract "$WF_DATA/extract" --out "$WF_DATA/catalogue"
python -m tools.next_run.weather --events "$WF_DATA/catalogue/events.parquet" --out "$WF_DATA/weather"
python -m tools.next_run.audit preflight --extract "$WF_DATA/extract" --catalogue "$WF_DATA/catalogue" --weather "$WF_DATA/weather" --out "$WF_DATA/preflight.json"
python -m tools.next_run.build --extract "$WF_DATA/extract" --catalogue "$WF_DATA/catalogue" --weather "$WF_DATA/weather" --static-cache "$WF_DATA/static" --out "$WF_DATA/full" --workers 4
python -m tools.next_run.audit tensors --data "$WF_DATA/full" --out "$WF_DATA/tensor-audit.json"
python -m tools.next_run.train smoke --data "$WF_DATA/full" --out "$WF_DATA/smoke.json"
```

`weather` reuses identical cached requests. It throttles requests and retries transient
failures; daily quotas fail rather than looping indefinitely. Resume on a later run.
`build` accepts `--existing-tiles /path/to/tiles` to read existing `dem/` and `wc/`
COGs, and `--offline-static` to disallow downloads. It never edits those source tiles.
If interrupted, rerun the identical build command with `--resume`. Source/config/code
changes require a new output directory. Successful resume preserves manifest identity.
The full audited plan needs roughly **54 GB** of uncompressed tensor storage, plus
source/cache files. A `--limit-events 8 --max-samples 8` build is explicitly marked
as a smoke dataset and cannot be used for a real training/test result.

## Train and evaluate

Transfer the complete immutable dataset, including manifests and all event files, to
the next pod. Keep the current experiment intact. Rerun the tensor audit after transfer.

```bash
python -m pytest tools/next_run/test_next_run.py tools/pipeline -q
python -m tools.next_run.train train --data "$WF_DATA/full" --out "$WF_DATA/run-001" --device cuda --epochs 30 --patience 8 --batch-size 16
```

For a predeclared long-run/double-descent experiment, set the epoch budget in advance
and use `--patience 0`; record that protocol before opening the final test. Selection
curves may be inspected. The test split must not select epoch count, architecture,
features, thresholds, or the next experiment.

Training writes `run.json`, a selection curve, an uncalibrated best checkpoint, and
`frozen.pt` calibrated using independent validation regions. It never loads test tensors.
After decisions are frozen, evaluate once:

```bash
python -m tools.next_run.train test --data "$WF_DATA/full" --checkpoint "$WF_DATA/run-001/frozen.pt" --out "$WF_DATA/run-001/final-test.json" --device cuda --unlock-final-test
```

Report pooled and per-event AP, persistence/distance-decay baselines, geographic
bootstrap uncertainty, novel observable-detection AP, Brier scores, calibration bins
and negative-cell false alarms for every horizon. No-positive events remain in Brier
and false-alarm metrics even though AP is undefined for them. Checkpoint selection
uses mean six-hour AP over positive events, so that score alone is insufficient.

Before calling the model improved, require reproducible improvement over the fixed
baselines on held-out geography, an interval supporting the improvement, no hidden
short-horizon/calibration regression, and confirmation across declared training seeds.
The small number of independent held-out regions limits certainty. More epochs,
more data rows or a bigger model do not establish superiority by themselves.

For a route-safety model, the next separate milestone is independent time-resolved
perimeter/arrival labels and a time-dependent road exposure benchmark. This thermal
forecast must not be treated as a road-clearance oracle.

## Sources

- LSA SAF MTFRPPIXEL product manual, Table 2, in the accompanying downloaded
  documentation: acquisition encoding, native geometry and quality-flag definitions.
- [Open-Meteo Previous Runs API](https://open-meteo.com/en/docs/previous-runs-api):
  archived fixed-lead forecasts and supported weather variables.
- [Copernicus DEM](https://registry.opendata.aws/copernicus-dem/) and
  [ESA WorldCover](https://esa-worldcover.org/en): static context, not fuel moisture.

## Forecast handoff and validation

`inputs.py` is the shared past-only feature builder. `forecast.py` exports a native-grid
research artifact from archived X/P inputs or fresh local input caches; `acceptance.py`
consumes completed evaluation reports without opening test tensors. The server serves
checksum-validated artifacts through `/api/forecasts`. See
[the integration contract](../../docs/forecast-contract.md) and
[the prospective evaluation policy](../../docs/thermal-evaluation.md).

The existing frozen full-v1 dataset and active training code are not rewritten by
these additions. New builds have a different source identity; use a new output
directory. `check_inputs.py` can compare raw train/selection inputs against v1 without
reading future labels or the test partition.
