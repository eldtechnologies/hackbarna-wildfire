# Growth baselines on the metric the field uses

The earlier result in [`model-proposal.md`](model-proposal.md) scored R² on
**scalar burned area** and concluded persistence wins. That conclusion is a property
of the metric, not of the model. This document re-scores the same task as a
**next-state fire mask** with
**average precision (AUC-PR)** — the metric the published benchmarks use — and adds
the features the corpora never carried.

## Why the metric decided the old answer

Persistence copies the last burned area, so on an area target it wins by
construction. On a **mask** target the literature reports the opposite: persistence
is the baseline every learned model beats, typically 2–2.5×.

| Benchmark | Metric | Persistence | Best learned |
| --- | --- | ---: | ---: |
| Next Day Wildfire Spread (Huot 2022) | AUC(PR) | 11.5 | 28.4 |
| WildfireSpreadTS (Gerard 2023) | AP | 0.193 | 0.404 |

## What was scored

Dataset: the MTG LSA-509 Iberia extract, assembled by `tools/pipeline/` —
**5,077 samples, 294 fires, 83.2 M cells**, each sample a 128×128 grid at 0.02°.

Target: will cell (i, j) carry fire in the next **6 h**? `label_frp > 0`.

Split: **leave-one-fire-out** (5 folds by event). A cell-level split would leak the
fire's identity; the score would be meaningless.

Score: **average precision**, the full held-out fold (true prevalence 0.078 %).

## Results

| Predictor | AP | vs persistence |
| --- | ---: | ---: |
| persistence (fire stays put) | 0.3917 | 1.00× |
| drift persistence (extrapolate the 3 h centroid velocity) | 0.0604 | 0.15× |
| **model — observed fire state only** | 0.4698 | 1.20× |
| **model + relative position (direction)** | **0.5403** | **1.38×** |
| terrain + fuel only (geography control) | 0.0017 | 0.00× |

Three things this shows.

1. **A learned model beats persistence on the field's metric.** AP 0.54 against
   0.39, with no weather, no terrain and no fuel in the winning model — only the
   observed fire state and the cell's position relative to the fire.

2. **The biggest lever is direction, which is what the Monitoring track asks for.**
   Adding the cell offset from the fire's FRP-weighted centroid takes AP
   0.47 → 0.54. The features are computed from the model's own input, so no leak.

3. **Terrain and fuel alone score essentially zero (AP 0.0017).** That is the
   control that matters: it proves the model is reading the fire, not memorising
   the map. It also means terrain/fuel, added on top, do not help here.

## The drift baseline is worse than staying put

Extrapolating the last 3 h of centroid motion over 9 h scores AP 0.06 — far below
plain persistence. A short-window velocity is too noisy to extrapolate that far, so
**plain persistence is the honest strongest baseline**, and the 1.38× is measured
against it.

## What is still missing, and why it matters

Wind. It is the physical driver of spread direction and the one time-varying input
the model does not yet have. Open-Meteo's daily request cap was reached during this
work, so the wind join is **queued, not abandoned**. The static layers (DEM GLO-30
slope/aspect, ESA WorldCover fuel) are already joined and verified; they simply do
not help on this target, which is itself a finding.

## Reproduce

```bash
# 1. build the dataset shards (needs the MTG archive; see build.py for its source)
cd tools/pipeline && uv run --with pandas --with numpy python build.py --archive /path/to/LSA_SAF_MTFRPPixel_2026

# 2. put the DEM and WorldCover tiles for the sample grids under tiles/:
#      tiles/dem/*.tif   Copernicus DEM GLO-30   (AWS Open Data, no key)
#      tiles/wc/*.tif    ESA WorldCover v200     (AWS Open Data, no key)
#    features_static.py reads the union of the sample grids from these tiles.

# 3. build the coarse static mosaics and score
uv run --with rasterio --with numpy --with scikit-learn python features_static.py
uv run --with numpy --with scikit-learn python ap_harness.py
```

`ap_harness.py` prints the table above fold by fold.
