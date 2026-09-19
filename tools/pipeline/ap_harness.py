#!/usr/bin/env python3
"""Score the next-state fire mask with average precision, leave-one-fire-out.

Reads the shards from tools/pipeline/out and the coarse static mosaics from the
working directory (static_coarse.npz, built by features_static.py).

    uv run --with numpy --with scikit-learn python ap_harness.py

The target is the mask `label_frp > 0` at a 6 h horizon. Persistence is the honest
strongest baseline: the fire stays where it is. The model is gradient boosting over
the observed fire state plus each cell's position relative to the fire.

A cell-level split would leak the fire's identity and inflate every number, so the
split is by event.
"""
from __future__ import annotations

import glob
from pathlib import Path

import numpy as np
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.model_selection import GroupKFold
from sklearn.metrics import average_precision_score

HERE = Path(__file__).resolve().parent
SHARDS = sorted(glob.glob(str(HERE / "out" / "shard-*.npz"))) or \
    sorted(glob.glob("/tmp/df/wfpipeline/tools/pipeline/out/shard-*.npz"))

RES = 0.005
LON0, LAT1 = -11.0, 45.0
FUEL = {10: 2, 20: 3, 30: 4, 40: 2, 50: 0, 60: 0, 70: 0, 80: 0, 90: 1, 95: 1, 100: 1}


def load_static():
    s = np.load(HERE / "static_coarse.npz")
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


def cell_offsets(cur, cell_km=2.2):
    n, h, w = cur.shape
    rr, cc = np.mgrid[0:h, 0:w].astype(np.float32)
    tot = cur.sum(axis=(1, 2))
    safe = np.where(tot > 0, tot, 1.0)
    cr = (cur * rr).sum(axis=(1, 2)) / safe
    cc_ = (cur * cc).sum(axis=(1, 2)) / safe
    dr = rr[None] - cr[:, None, None]
    dc = cc[None] - cc_[:, None, None]
    return dr, dc, np.hypot(dr, dc) * cell_km


def build(use_static=True):
    slope_c, aspect_c, wc_c, hc, wc = load_static()
    Xs, ys, gs, ps = [], [], [], []
    for f in SHARDS:
        d = np.load(f)
        cur, curd = d["current_frp"], d["current_detections"]
        hist, histd = d["history_frp"], d["history_detections"]
        lab = d["label_frp"]
        n, h, w = cur.shape[0], cur.shape[1], cur.shape[2]
        dr, dc, dist = cell_offsets(cur)
        blocks = [
            np.stack([cur, curd, hist, histd], axis=-1).astype(np.float32),
            np.stack([dr, dc, dist], axis=-1).astype(np.float32),
        ]
        if use_static:
            st = np.empty((n, h, w, 4), dtype=np.float32)
            for i in range(n):
                sl, asp, fuel = sample_static(slope_c, aspect_c, wc_c, hc, wc,
                                              d["lon0"][i], d["lat0"][i], d["cell_deg"][i])
                ar = np.radians(asp)
                st[i, :, :, 0] = sl
                st[i, :, :, 1] = np.sin(ar)
                st[i, :, :, 2] = np.cos(ar)
                st[i, :, :, 3] = fuel
            blocks.append(st)
        X = np.concatenate(blocks, axis=-1).reshape(-1, sum(b.shape[-1] for b in blocks))
        Xs.append(X)
        ys.append((lab.reshape(n, -1) > 0).astype(np.int8).reshape(-1))
        gs.append(np.repeat(d["event_id"], h * w))
        ps.append(cur.reshape(n, -1).astype(np.float32).reshape(-1))
    return (np.concatenate(Xs), np.concatenate(ys),
            np.concatenate(gs), np.concatenate(ps))


def main():
    X, y, g, p = build()
    print(f"cells={len(X):,}  positives={int(y.sum()):,}  events={len(set(g))}")
    rng = np.random.default_rng(0)
    base, model = [], []
    gkf = GroupKFold(n_splits=5)
    for i, (tr, te) in enumerate(gkf.split(X, y, g)):
        b = average_precision_score(y[te], p[te])
        pos = tr[y[tr] == 1]
        neg = rng.choice(tr[y[tr] == 0], size=min((y[tr] == 0).sum(), len(pos) * 10), replace=False)
        sub = np.concatenate([pos, neg])
        clf = HistGradientBoostingClassifier(max_iter=200, learning_rate=0.08,
                                             class_weight="balanced", random_state=0)
        clf.fit(X[sub], y[sub])
        m = average_precision_score(y[te], clf.predict_proba(X[te])[:, 1])
        base.append(b); model.append(m)
        print(f"  fold {i}: persistence={b:.4f}  model={m:.4f}")
    print(f"\npersistence AP {np.mean(base):.4f}")
    print(f"model       AP {np.mean(model):.4f}   ratio {np.mean(model)/np.mean(base):.2f}x")


if __name__ == "__main__":
    main()
