# Forecast handoff and causal replay

The delivered target is **a native MTG thermal detection somewhere within each future
1/3/6-hour window**. It is neither a physical fire perimeter nor a road-arrival time.
`shared/forecast.ts` is the typed handoff; `server/model/forecast.ts` validates every
artifact before serving it. The existing egress engine is not fed these grids.

## Produce and serve an artifact

Use the Python dependencies in `tools/next_run/requirements.txt`. From the repository root:

```bash
python -m tools.next_run.forecast \
  --data /path/to/full-v1 \
  --event f2236085fb7b93e9ff94261e --issue 2026-07-01T11:00:00Z \
  --out /path/to/forecast-store
FORECAST_DIR=/path/to/forecast-store npm run server
```

`GET /api/forecasts` lists prepared event/issue pairs.
`GET /api/forecasts?eventId=<id>&issue=<URL-encoded ISO timestamp>` returns exactly one
artifact. Missing pairs return 404; malformed requests 400; corrupt artifacts 502.
An unset `FORECAST_DIR` returns an empty list. Nothing silently falls back to a
forecast from a different issue time. This is an offline producer plus read-only
artifact API, not a deployed ingestion/scheduling service.

For a dependency-free serving demonstration, set `FORECAST_DIR=data/forecasts/example`.
The committed example is a real **selection-partition** input at the timestamp above,
exported with the persistence fallback. It is not a trained-model result, the July
Los Gallardos incident, or live data. Tests check the Python JSON through actual HTTP.

For fresh local data use `--frame-config config.json` instead of `--data`. The config
contains `event` (event_id, seed_row, seed_col, seed_scan_time, lon, lat), `archive`,
`extract`, `weather`, `static_cache`, optional `existing_tiles`, and the frozen
`training_manifest_sha256`. It uses the same `InputFrame.at(issue)` as dataset
construction and refuses remote terrain downloads. An operator must provide the
matching v1 inputs/caches; a manifest hash is provenance, not automatic detection of
a different satellite product or a changed weather source. Rebuilding with this
refactored builder creates a new dataset identity; do not resume the frozen full-v1.

Add `--checkpoint frozen.pt --acceptance decision.json` only for trusted local model
files after the prospective evaluation gate passes. Rejected or absent acceptance
keeps the explicitly labelled persistence fallback. Corrupt accepted weights fail
export instead of being served. Checkpoint loading is local PyTorch deserialization;
there is no public checkpoint upload endpoint. The trainer source hash must match
this inference runtime. One explicitly pinned compatibility mapping permits trainer
`08c7bbe` (SHA `83a42e47…`) with the current `55822415…` runtime: their sole change is
dataset checksum verification; model/calibration definitions are identical. Changing
either source requires renewed review. The full hash pair is in `forecast.py`.

## Interpretation for consumers

- `issuedAt` is the evidence cutoff; `generatedAt` is the export time. Horizons use
  `validUntil = issuedAt + hours`. All equivalent timestamps normalize to UTC.
- Grid dimensions are 64×64. Flattening is row-major north-to-south. `proj4` defines
  the projection, and `centreTransform` locates **pixel centres**, not corners, in
  projected metres. Native spacing is not constant ground resolution. Never treat
  this as a 64×64 km map or interpolate it into street-level certainty.
- Horizon probabilities are cumulative and monotonic. They describe future observed
  thermal detections under the evaluated observability regime. Cloud censoring makes
  them different from unconditional physical-fire probabilities or an arrival CDF.
- `coverage.observedFraction` is the mean fraction observed over the six past 30-minute
  bins. `latestObservableBin` bounds the latest scan time represented, not exact
  publication/receipt time. Weather masks and terrain coverage are separate. No future
  label mask is used in an exported forecast.
- No observable history returns `insufficient_observations` and null probability grids.
  A zero persistence cell with missing history is not an all-clear signal. Consumers
  must retain input coverage and fallback status with the displayed forecast.
- `identity` binds the dataset manifest, actual X/P input bytes plus event/grid/issue,
  checkpoint, checkpoint trainer, calibration, inference code bundle and acceptance
  file. The code bundle covers the shared feature builder and inference dependencies.
- `deployment=research_only`, `roadUse=unsupported` and the uncertainty fields travel
  with every response. Calibration is not epistemic uncertainty; no uncertainty ensemble
  is claimed. An accepted individual seed remains an individual model.

The producer is single-writer. Finish exporting its atomic files before switching the
server to the store. Use versioned store directories for releases; do not run concurrent
exporters against one index. This v1 handoff does not invent incident-to-native-event
association or dispatch evacuation messages.

## Shared replay clock

Both `/api/fires?at=<seconds>` and `/api/growth?clusterId=<id>&at=<seconds>` use the
same `asOf`. A flat historical capture now has a timeline too. Detections only appear
when their recorded or assumed delivery time passes. Cluster geometry is recomputed
from available members. Perimeters require computation and observation times no later
than the cursor; spread polygons additionally require an explicit issue time.

DeepFire capture latencies are the existing engine assumptions (MTG 17 minutes;
VIIRS/MODIS 3 hours; Sentinel-3 6 hours), unless `available_at` is recorded. Native
training uses a different explicit policy: max(product creation, scan +45 minutes).
Neither reconstructs real network delivery. Cluster associations remain retrospective
upstream metadata; perimeter computation time is a publication lower bound. Therefore
this is a **causal evidence replay under declared assumptions**, not proof of what a
real operator actually received. Legacy accelerated mock recordings whose observation
clock runs ahead of their recording clock now lose future observations by design.

Motion uses only the past six hours, splits at a temporal midpoint, keeps equal-time
observations together, and requires 30 minutes between weighted time centroids.
`validation=diagnostic_only` and `roadUse=unsupported` distinguish it from a validated
physical forecast. The July diagnostic is in `data/model/serving-replay-validation.json`.
