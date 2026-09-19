#!/usr/bin/env python3
"""Score the next-state fire mask with average precision, leave-one-fire-out.

Reads the shards from tools/pipeline/out and, when present, static_coarse.npz
(built by features_static.py) for the geography control.

    uv run --with numpy --with scikit-learn python ap_harness.py

The target is the mask `label_frp > 0` at a 6 h horizon. This prints the table in
docs/growth-baselines-AP.md fold by fold, so a reader can reproduce it rather than
trust it.

A cell-level split would leak the fire's identity and inflate every number, so the
split is by event.
"""
from __future__ import annotations

import argparse
import glob
from pathlib import Path

import numpy as np
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.model_selection import GroupKFold
from sklearn.metrics import average_precision_score

HERE = Path(__file__).resolve().parent

RES = 0.005
LON0, LAT1 = -11.0, 45.0
FUEL = {10: 2, 20: 3, 30: 4, 40: 2, 50: 0, 60: 0, 70: 0, 80: 0, 90: 1, 95: 1, 100: 1}

# Drift persistence extrapolates the last DRIFT_HISTORY_H of centroid motion over
# DRIFT_FORWARD_H, i.e. by DRIFT_FORWARD_H / DRIFT_HISTORY_H.
DRIFT_HISTORY_H = 3
DRIFT_FORWARD_H = 9

# One model variant per row of the results table: the feature blocks it may read.
# `fire` and `offset` are computed from the sample's own input; `static` is the
# DEM/fuel control, used to show the model reads the fire and not the map.
VARIANTS = (
    ("model — observed fire state only", ("fire",)),
    ("model + relative position (direction)", ("fire", "offset")),
    ("terrain + fuel only", ("static",)),
)


def load_static(static_path: Path):
    """The coarse DEM/fuel mosaics, or None when the control is not available."""
    if not static_path.exists():
        return None
    s = np.load(static_path)
    _, _, _, hc, wc = s["meta"]
    return s["slope"], s["aspect"], s["wc"], int(hc), int(wc)


def sample_static(slope_c, aspect_c, wc_c, hc, wc, lon0, lat0, cell_deg, cells=128):
    lat_top = lat0 + cells * cell_deg
    lat = lat_top - (np.arange(cells) + 0.5) * cell_deg
    lon = lon0 + (np.arange(cells) + 0.5) * cell_deg
    cr = np.clip(((LAT1 - lat) / RES).astype(int), 0, hc - 1)
    cc = np.clip(((lon - LON0) / RES).astype(int), 0, wc - 1)
    sl = slope_c[np.ix_(cr, cc)]
    asp = aspect_c[np.ix_(cr, cc)]
    cls = wc_c[np.ix_(cr, cc)]
    fuel = np.full_like(cls, np.nan)
    for k, v in FUEL.items():
        fuel[cls == k] = v
    return sl, asp, fuel


def centroids(mask):
    """FRP-weighted (row, col) centroid per sample, zero where the sample is empty."""
    n, h, w = mask.shape
    rr, cc = np.mgrid[0:h, 0:w].astype(np.float32)
    tot = mask.sum(axis=(1, 2))
    safe = np.where(tot > 0, tot, 1.0)
    return (mask * rr).sum(axis=(1, 2)) / safe, (mask * cc).sum(axis=(1, 2)) / safe


def cell_offsets(cur, cell_km=2.2):
    """Each cell's offset from the fire's own centroid, and the distance."""
    n, h, w = cur.shape
    rr, cc = np.mgrid[0:h, 0:w].astype(np.float32)
    cr, cc_ = centroids(cur)
    dr = rr[None] - cr[:, None, None]
    dc = cc[None] - cc_[:, None, None]
    return dr, dc, np.hypot(dr, dc) * cell_km


def drift_mask(cur, hist, factor=DRIFT_FORWARD_H / DRIFT_HISTORY_H):
    """Persistence extrapolated: shift the current mask by the centroid velocity.

    The velocity is the history-to-current centroid displacement, treated as the
    last DRIFT_HISTORY_H of motion and carried forward DRIFT_FORWARD_H.
    """
    n, h, w = cur.shape
    cr, cc = centroids(cur)
    hr, hc = centroids(hist)
    vr, vc = cr - hr, cc - hc
    out = np.empty_like(cur)
    for i in range(n):
        out[i] = np.roll(np.roll(cur[i], int(round(vr[i] * factor)), axis=0),
                         int(round(vc[i] * factor)), axis=1)
    return out


def load(shards, static):
    """Read every shard into flat feature blocks and labels.

    Group ids are re-coded to ints, in sorted event_id order, before they are
    repeated across 128x128 cells. Strings would balloon memory, and coding in
    shard order would move the fold boundaries and shift the table.
    """
    events = sorted({e for f in shards for e in np.load(f)["event_id"].tolist()})
    code = {e: i for i, e in enumerate(events)}

    blocks = {"fire": [], "offset": [], "static": []}
    ys, gs, pers, drift = [], [], [], []
    for f in shards:
        d = np.load(f)
        cur, curd = d["current_frp"], d["current_detections"]
        hist, histd = d["history_frp"], d["history_detections"]
        lab = d["label_frp"]
        n, h, w = cur.shape
        dr, dc, dist = cell_offsets(cur)
        blocks["fire"].append(np.stack([cur, curd, hist, histd], -1).astype(np.float32).reshape(n * h * w, 4))
        blocks["offset"].append(np.stack([dr, dc, dist], -1).astype(np.float32).reshape(n * h * w, 3))
        if static is not None:
            slope_c, aspect_c, wc_c, hc, wc = static
            st = np.empty((n, h, w, 4), dtype=np.float32)
            for i in range(n):
                sl, asp, fuel = sample_static(slope_c, aspect_c, wc_c, hc, wc,
                                              d["lon0"][i], d["lat0"][i], d["cell_deg"][i])
                ar = np.radians(asp)
                st[i, :, :, 0] = sl
                st[i, :, :, 1] = np.sin(ar)
                st[i, :, :, 2] = np.cos(ar)
                st[i, :, :, 3] = fuel
            blocks["static"].append(st.reshape(n * h * w, 4))
        ys.append((lab.reshape(n, -1) > 0).astype(np.int8).reshape(-1))
        gs.append(np.array([code[e] for e in d["event_id"]], dtype=np.int32).repeat(h * w))
        pers.append(cur.reshape(-1).astype(np.float32))
        drift.append(drift_mask(cur, hist).reshape(-1))
    X = {k: (np.concatenate(v) if v else None) for k, v in blocks.items()}
    return (X, np.concatenate(ys), np.concatenate(gs),
            np.concatenate(pers), np.concatenate(drift))


def score_variants(X, y, g, pers, drift, rng):
    """Average precision per fold for both baselines and each model variant."""
    base, drift_ap = [], []
    scores = {name: [] for name, _ in VARIANTS}
    for tr, te in GroupKFold(n_splits=5).split(X["fire"], y, g):
        base.append(average_precision_score(y[te], pers[te]))
        drift_ap.append(average_precision_score(y[te], drift[te]))
        pos = tr[y[tr] == 1]
        neg = rng.choice(tr[y[tr] == 0],
                         size=min(int((y[tr] == 0).sum()), len(pos) * 10), replace=False)
        sub = np.concatenate([pos, neg])
        for name, keys in VARIANTS:
            if any(X[k] is None for k in keys):
                continue
            feats = X[keys[0]] if len(keys) == 1 else np.concatenate([X[k] for k in keys], axis=1)
            clf = HistGradientBoostingClassifier(max_iter=200, learning_rate=0.08,
                                                 class_weight="balanced", random_state=0)
            clf.fit(feats[sub], y[sub])
            scores[name].append(average_precision_score(y[te], clf.predict_proba(feats[te])[:, 1]))
    return base, drift_ap, scores


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--shards", default=str(HERE / "out" / "shard-*.npz"))
    ap.add_argument("--static", type=Path, default=HERE / "static_coarse.npz")
    args = ap.parse_args()

    shards = sorted(glob.glob(args.shards))
    if not shards:
        raise SystemExit(f"no shards at {args.shards}; run build.py first")
    static = load_static(args.static)
    if static is None:
        print(f"note: {args.static} absent — skipping the 'terrain + fuel only' row\n")

    X, y, g, pers, drift = load(shards, static)
    print(f"cells={len(y):,}  positives={int(y.sum()):,}  "
          f"prevalence={100 * y.mean():.4f}%  events={len(np.unique(g))}\n")

    base, drift_ap, scores = score_variants(X, y, g, pers, drift, np.random.default_rng(0))
    persist = float(np.mean(base))

    print("per fold")
    series = [("persistence", base), ("drift", drift_ap)]
    series += [(name, scores[name]) for name, _ in VARIANTS if scores[name]]
    for i in range(len(base)):
        print("  fold %d:  %s" % (i, "  ".join(f"{n}={v[i]:.4f}" for n, v in series)))

    def line(label, value):
        print(f"  {label:<54} AP {value:.4f}   {value / persist:.2f}x")

    print("\nbaselines")
    line("persistence (fire stays put)", persist)
    line("drift persistence (extrapolate the centroid velocity)", float(np.mean(drift_ap)))
    print("models (ratio is against persistence)")
    for name, _ in VARIANTS:
        if name == "terrain + fuel only" and X["static"] is None:
            print(f"  {name:<54} skipped (no static mosaics)")
            continue
        line(name, float(np.mean(scores[name])))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
