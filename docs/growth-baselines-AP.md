# Historical MTG baseline experiment

This records the older `tools/pipeline/` experiment. For new training use
[`tools/next_run/README.md`](../tools/next_run/README.md). The old scores do not
validate the corrected pipeline or establish superiority to DeepFire.

## Recorded experiment

The committed Iberian dataset contains 4,789 samples from 260 thermal episodes,
with 128×128 cells at 0.02°. Its target is `label_frp > 0` within the next six-hour
window, not independently verified fire spread. The harness uses **five-fold
GroupKFold by episode**, not leave-one-fire-out. Reported AP is the arithmetic mean
of the five fold APs; average precision is not identical to trapezoidal PR area.

| Historical predictor | Mean fold AP |
|---|---:|
| Persistence | 0.3659 |
| Drift persistence | 0.0569 |
| Observed-state model | 0.4435 |
| Observed state plus relative position | 0.4470 |
| Static geography control | 0.0017 |

These are archived measurements, not a current acceptance benchmark. No new model
score is claimed by adding the corrected next-run pipeline.

## Why these numbers are insufficient

- Missing/cloud-covered observations become negative labels in this old dataset.
  It lacks the native quality masks and publication-time gating of `tools/next_run`.
- Crop centres use full-episode information. Episode splits alone do not protect
  against neighbouring patches or later episodes sharing geography.
- The observation-conditioned sampling truncates quiet tails. FRP greater than
  zero also differs from detecting thermal activity with a missing FRP estimate.
- The legacy terrain pipeline has a north-up aspect sign error, edge-clamped
  geographic lookup and an unvalidated ordinal land-cover-to-fuel mapping.
- Drift uses wrapped `np.roll` and fixed timing assumptions. Beating that specific
  baseline does not establish that plain persistence is the strongest baseline.
- A weak static-only control does not prove freedom from geographic leakage or
  establish that terrain/fuel add no useful information.
- Scalar-area persistence can score highly at short horizons; it does not win by
  construction. Results on different targets/corpora are not directly comparable.

The new pipeline addresses extraction, masking, causality, weather availability,
terrain representation and evaluation separation. Independent wildfire labels and
an operational benchmark are still needed for fire-front and evacuation claims.

## Reproduce the historical experiment only

The old builder consumes the derived `analysis/iberia_bbox_hotspots.csv.gz` table,
not raw native scans. The static-control row additionally requires external
Copernicus DEM GLO-30 and ESA WorldCover v200 tiles, which are not bundled.

```bash
cd tools/pipeline
uv run --with-requirements requirements.txt python build.py --legacy-reproduction --archive /path/to/LSA_SAF_MTFRPPixel_2026 --out /path/to/new/historical-output
# Optional external tiles under tools/pipeline/tiles/{dem,wc}/ are needed for:
uv run --with-requirements requirements.txt python features_static.py
# Scores the committed historical shard set by default:
uv run --with-requirements requirements.txt python ap_harness.py --legacy-reproduction
```

Retain the historical artifacts unchanged so earlier claims can be traced. Build a
new dataset with `tools/next_run` for the next RunPod experiment.
