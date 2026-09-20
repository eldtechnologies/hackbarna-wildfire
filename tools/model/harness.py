#!/usr/bin/env python3
"""Stream 3 harness: leave-one-fire-out scoring of the growth baselines.

Runs on the data box. The corpora stay here; only the small outputs are committed
under `data/model/`, so the numbers are checkable without the bulk data.

    uv run --with geopandas --with pyogrio --with pandas --with scikit-learn python tools/model/harness.py

Two corpora, reported separately because their cadence differs by an order of
magnitude, and because each carries a different usable signal:

  PT-FireSprd        ~1-2 h steps. L2_FireBehavior carries the observed spread
                     direction and rate of spread per period, so the direction
                     target needs no geometry. `area` is a per-period increment.
  FireSpread_MedEU   ~24 h steps. Cumulative burned area per usable acquisition;
                     direction and rate come from centroid displacement.

Two targets, because the area result and the product claim are different
quantities. Constant-ROS winning on area does not imply it wins on direction.

The split is always leave-one-FIRE-out. Holding out steps inside one fire leaks
the answer, because the model has seen how that fire behaves.
"""

from __future__ import annotations

import json
import math
import os
import statistics
import sys
from dataclasses import dataclass, asdict
from pathlib import Path

OUT = Path(__file__).resolve().parents[2] / "data" / "model"


def data_dir() -> Path:
    """The corpora live on the data box, not in this repo.

    A hardcoded default would silently fail on every machine but the data box and,
    before the write guard in main(), overwrite the committed artifact with an empty
    list. Requiring the variable makes that failure legible instead.
    """
    raw = os.environ.get("STREAM3_DATA_DIR")
    if not raw:
        raise RuntimeError(
            "STREAM3_DATA_DIR is not set; point it at the corpora "
            "(see docs/stream3-baselines.md)"
        )
    return Path(raw)


R_EARTH_KM = 6371.0088

# A pair whose gap exceeds this is a data gap, not a growth observation: the two
# states are not one continuous interval. Both readings are reported and neither
# is silently dropped - a single 8738 h pair otherwise dominates constant-ROS.
MAX_GAP_HOURS = 168.0

# In-file provenance, matching the other committed data artifacts (data/graph/*.json
# carry `source` and `fetched`). Named here so every output points back at its origin.
SOURCE = "PT-FireSprd (L2_FireBehavior) and FireSpread_MedEU; see docs/stream3-baselines.md"
GENERATOR = "tools/model/harness.py"


@dataclass
class State:
    fire: str
    t: float  # hours since this fire's first observation
    area_ha: float
    bearing_deg: float | None  # direction of advance, degrees clockwise from north
    rate_kmh: float | None  # rate of frontal advance


def haversine_km(a, b) -> float:
    dlat = math.radians(b[1] - a[1])
    dlon = math.radians(b[0] - a[0])
    h = math.sin(dlat / 2) ** 2 + math.cos(math.radians(a[1])) * math.cos(
        math.radians(b[1])
    ) * math.sin(dlon / 2) ** 2
    return 2 * R_EARTH_KM * math.asin(math.sqrt(h))


def bearing_deg(a, b) -> float:
    dlon = math.radians(b[0] - a[0])
    y = math.sin(dlon) * math.cos(math.radians(b[1]))
    x = math.cos(math.radians(a[1])) * math.sin(math.radians(b[1])) - math.sin(
        math.radians(a[1])
    ) * math.cos(math.radians(b[1])) * math.cos(dlon)
    return (math.degrees(math.atan2(y, x)) + 360) % 360


def circular_error_deg(observed: float, predicted: float) -> float:
    return abs((observed - predicted + 180) % 360 - 180)


def load_pt_firesprd() -> list[State]:
    """L2 with `area` cumulated in time order.

    L1 holds the progression polygons but cannot be read with geometry on this box
    (invalid rings raise a GEOSException), and L2 carries the same series with a
    usable time key plus the observed direction and rate, so L2 is the source.
    """
    import pyogrio

    path = (
        data_dir()
        / "ptfiresprd/extracted/PT-FireSprd_v0.08/L2_FireBehavior/PT-FireSprd_L2_FireBehavior.shp"
    )
    df = pyogrio.read_dataframe(path, read_geometry=False)
    out: list[State] = []
    for fire, g in df.groupby("fname"):
        rows = g[(g.type == "p") & (g.enddoy > 0) & (g.area > 0)].sort_values("enddoy")
        if len(rows) < 3:
            continue
        t0 = float(rows.enddoy.min())
        cum = 0.0
        for _, r in rows.iterrows():
            cum += float(r.area)
            spdir = float(r.spdir_p)
            ros = float(r.ros_p)
            out.append(
                State(
                    fire=str(fire),
                    t=(float(r.enddoy) - t0) * 24.0,
                    area_ha=cum,
                    bearing_deg=spdir if 0 <= spdir <= 360 else None,
                    rate_kmh=ros / 1000.0 if ros > 0 else None,  # PT-FireSprd Table A5: m/h -> km/h
                )
            )
    return out


def load_medeu(path: str | None = None) -> list[State]:
    """One cumulative burned-area state per usable acquisition.

    A step with a missing area is a gap where no usable imagery existed; it drops
    that state, never the fire.

    `path` is a parameter so the CRS rule below can be tested against a synthetic
    projected file. It reads the real shapefile by default.
    """
    import geopandas as gpd
    import pandas as pd

    g = gpd.read_file(path or data_dir() / "medeu/FireSpread_MedEU.shp")
    # The file is EPSG:3035 - projected metres, not degrees. Feeding those numbers
    # to a haversine that expects lon/lat gives a distance that is meaningless and a
    # rate about four orders of magnitude too large. The area numbers are unaffected
    # (they come from the attribute table), which is why this hid for so long.
    g = g.to_crs(4326)
    out: list[State] = []
    for fire, grp in g.groupby("EFFIS_id"):
        rows = grp[grp["BA (ha)"].notna() & grp.geometry.notna()].copy()
        if len(rows) < 3:
            continue
        rows["when"] = pd.to_datetime(
            rows["Acqu_date"].astype(str) + " " + rows["Acqu_time"].astype(str), errors="coerce"
        )
        rows = rows[rows["when"].notna()].sort_values("when")
        if len(rows) < 3:
            continue
        t0 = rows["when"].min()
        prev = None
        for _, r in rows.iterrows():
            c = r.geometry.representative_point()
            point = (float(c.x), float(c.y))
            t = (r["when"] - t0).total_seconds() / 3600.0
            bearing = rate = None
            if prev is not None and t > prev[1] and (t - prev[1]) <= MAX_GAP_HOURS:
                dt = t - prev[1]
                bearing = bearing_deg(prev[0], point)
                rate = haversine_km(prev[0], point) / dt
            out.append(
                State(
                    fire=f"medeu-{fire}",
                    t=t,
                    area_ha=float(r["BA (ha)"]),
                    bearing_deg=bearing,
                    rate_kmh=rate,
                )
            )
            prev = (point, t)
    return out


def pairs_of(states: list[State], max_gap: float | None):
    by_fire: dict[str, list[State]] = {}
    for s in states:
        by_fire.setdefault(s.fire, []).append(s)
    pairs = []
    for seq in by_fire.values():
        seq.sort(key=lambda s: s.t)
        for a, b in zip(seq, seq[1:]):
            dt = b.t - a.t
            if dt > 0 and (max_gap is None or dt <= max_gap):
                pairs.append((a, b))
    return pairs


def r2_mape(observed: list[float], predicted: list[float]) -> tuple[float, float]:
    if len(observed) < 2:
        return float("nan"), float("nan")
    mean = statistics.fmean(observed)
    ss_tot = sum((o - mean) ** 2 for o in observed)
    ss_res = sum((o - p) ** 2 for o, p in zip(observed, predicted))
    r2 = 1 - ss_res / ss_tot if ss_tot > 0 else float("nan")
    apes = [abs((p - o) / o) * 100 for o, p in zip(observed, predicted) if o > 0]
    return r2, statistics.median(apes) if apes else float("nan")


def held_out_mean_rates(pairs) -> dict[str, float]:
    """Mean observed area-growth rate per fire, for the leave-one-out fit."""
    per_fire: dict[str, list[float]] = {}
    for a, b in pairs:
        per_fire.setdefault(a.fire, []).append((b.area_ha - a.area_ha) / (b.t - a.t))
    return {f: statistics.fmean(v) for f, v in per_fire.items()}


def loo_mean_rate(rates: dict[str, float], fire: str) -> float:
    """The other fires' mean growth rate: the constant-ROS fit for a held-out fire.

    Callers guard on at least two fires; with one there is nothing to fit against.
    """
    return statistics.fmean(r for f, r in rates.items() if f != fire)


def score_corpus(
    states: list[State], label: str, max_gap: float | None, rate_basis: str
) -> dict:
    pairs = pairs_of(states, max_gap)
    rates = held_out_mean_rates(pairs)
    fires = len(rates)

    obs = [b.area_ha for _, b in pairs]
    pers = [a.area_ha for a, _ in pairs]
    r2_p, mape_p = r2_mape(obs, pers)

    # Constant-ROS is fitted on the OTHER fires. With one fire there are none, the
    # fit collapses to persistence, and publishing that as a scored predictor would
    # dress a placeholder as a result. Publish it only with at least two fires.
    constant_ros_ok = len(rates) >= 2
    if constant_ros_ok:
        cros = [
            max(0.0, a.area_ha + loo_mean_rate(rates, a.fire) * (b.t - a.t))
            for a, b in pairs
        ]
        r2_c, mape_c = r2_mape(obs, cros)

    # Pooled R2 across all held-out pairs is dominated by the few largest fires: a
    # fire that grows through three orders of magnitude owns most of the variance.
    # The per-fire median answers a different question - how the typical fire does -
    # and it is much lower. Both are reported because either alone misleads.
    def per_fire_median_r2(predict) -> float | None:
        scores = []
        by_fire: dict[str, list[tuple[float, float]]] = {}
        for a, b in pairs:
            by_fire.setdefault(a.fire, []).append((b.area_ha, predict(a, b)))
        for vals in by_fire.values():
            if len(vals) > 1:
                o = [v[0] for v in vals]
                pr = [v[1] for v in vals]
                scores.append(r2_mape(o, pr)[0])
        finite = [x for x in scores if math.isfinite(x)]
        return round(statistics.median(finite), 4) if finite else None

    def persistence_pred(a, b):
        return a.area_ha

    def constant_ros_pred(a, b):
        return max(0.0, a.area_ha + loo_mean_rate(rates, a.fire) * (b.t - a.t))

    median_p = per_fire_median_r2(persistence_pred)
    median_c = per_fire_median_r2(constant_ros_pred) if constant_ros_ok else None

    berr, r_obs, r_pred = [], [], []
    for a, b in pairs:
        if a.bearing_deg is not None and b.bearing_deg is not None:
            berr.append(circular_error_deg(b.bearing_deg, a.bearing_deg))
        if a.rate_kmh is not None and b.rate_kmh is not None:
            r_obs.append(b.rate_kmh)
            r_pred.append(a.rate_kmh)
    r2_r, mape_r = r2_mape(r_obs, r_pred)

    dts = [b.t - a.t for a, b in pairs]
    rates_kmh = [b.rate_kmh for a, b in pairs if a.rate_kmh is not None and b.rate_kmh is not None]
    return {
        "corpus": label,
        "gap_filter": "all pairs" if max_gap is None else f"dt <= {max_gap:g} h",
        # The all-pairs row documents the outlier effect; the gap-filtered row is
        # the usable reading. Only one may be served, or the same key carries two
        # different numbers.
        "primary": max_gap is not None,
        # The constant-ROS baseline holds this rate for every fire, so it needs to
        # travel with the scores rather than be recomputed at serve time.
        "mean_rate_kmh": round(statistics.fmean(rates_kmh), 4) if rates_kmh else None,
        "rate_basis": rate_basis,
        "fires": fires,
        "states": len(states),
        "pairs": len(pairs),
        "dt_hours": {
            "median": round(statistics.median(dts), 2) if dts else None,
            "min": round(min(dts), 2) if dts else None,
            "max": round(max(dts), 2) if dts else None,
        },
        "burned_area": {
            # "r2" is pooled across all held-out pairs. "median_r2_per_fire" is the
            # typical fire. They differ by a lot and both travel with the number.
            "persistence": {
                "r2": round(r2_p, 4),
                "median_r2_per_fire": median_p,
                "median_mape": round(mape_p, 2),
            },
            "constant_ros": (
                {
                    "r2": round(r2_c, 4),
                    "median_r2_per_fire": median_c,
                    "median_mape": round(mape_c, 2),
                }
                if constant_ros_ok
                else {
                    "computed": False,
                    "reason": f"only {fires} fire(s); constant-ROS is fitted on the other fires",
                }
            ),
        },
        "bearing_rate": {
            "rate_fires": len({a.fire for a,b in pairs if a.rate_kmh is not None and b.rate_kmh is not None}),
            "direction_fires": len({a.fire for a,b in pairs if a.bearing_deg is not None and b.bearing_deg is not None}),
            "pairs_with_direction": len(berr),
            "persistence": {
                "median_bearing_error_deg": round(statistics.median(berr), 2) if berr else None,
                "rate_r2": round(r2_r, 4),
                "rate_median_mape": round(mape_r, 2),
            },
        },
    }


def score_model(states: list[State], max_gap: float | None) -> dict:
    """HistGradientBoosting over the features the corpora actually carry.

    Only the previous state and the elapsed time are available here: wind, terrain
    and land cover are not in either corpus, so this measures what a model can do
    WITHOUT them, not what a model could do with them. The plan names those
    features; adding them is the next step if this shows promise.
    """
    import numpy as np
    from sklearn.ensemble import HistGradientBoostingRegressor

    pairs = [p for p in pairs_of(states, max_gap) if p[0].rate_kmh is not None and p[1].rate_kmh is not None]
    if len(pairs) < 20:
        return {"computed": False, "reason": f"only {len(pairs)} pairs carry a rate"}

    features = np.array([
        [a.area_ha, a.rate_kmh, b.t-a.t,
         math.sin(math.radians(a.bearing_deg)) if a.bearing_deg is not None else 0.0,
         math.cos(math.radians(a.bearing_deg)) if a.bearing_deg is not None else 0.0,
         float(a.bearing_deg is not None)] for a,b in pairs
    ])
    rate_t = np.array([b.rate_kmh for _,b in pairs])
    fires = np.array([a.fire for a,_ in pairs])
    direction_known = np.array([b.bearing_deg is not None for _,b in pairs])
    target_bearing = np.array([b.bearing_deg if b.bearing_deg is not None else 0 for _,b in pairs])
    pred_rate = np.full(len(pairs), np.nan)
    pred_sin = np.full(len(pairs), np.nan)
    pred_cos = np.full(len(pairs), np.nan)
    folds_trained = 0
    for held in sorted(set(fires)):
        train = fires != held
        test = ~train
        if train.sum() < 10:
            continue
        folds_trained += 1
        model = HistGradientBoostingRegressor(max_iter=120, random_state=0)
        model.fit(features[train], rate_t[train])
        pred_rate[test] = model.predict(features[test])
        direction_train = train & direction_known
        if direction_train.sum() < 10:
            continue
        for target, out in ((np.sin(np.radians(target_bearing)),pred_sin),
                            (np.cos(np.radians(target_bearing)),pred_cos)):
            model = HistGradientBoostingRegressor(max_iter=120, random_state=0)
            model.fit(features[direction_train], target[direction_train])
            out[test] = model.predict(features[test])

    # Score only predictions a fold actually produced. An untrained fold is not a
    # zero prediction; a missing direction target is not a due-north observation.
    valid_rate = np.isfinite(pred_rate)
    if not valid_rate.any():
        return {"computed": False, "reason": "no fold had a training split of 10 pairs",
                "pairs": 0, "fires": 0, "folds_trained": 0}
    previous_rate = np.array([a.rate_kmh for a,_ in pairs])
    r2_p, mape_p = r2_mape(list(rate_t[valid_rate]),list(previous_rate[valid_rate]))
    r2_m, mape_m = r2_mape(list(rate_t[valid_rate]),list(pred_rate[valid_rate]))
    result = {
        "computed": True,
        "pairs": int(valid_rate.sum()),
        "fires": len(set(fires[valid_rate])),
        "folds_trained": folds_trained,
        "rate": {
            "persistence": {"r2": round(r2_p,4), "median_mape": round(mape_p,2)},
            "model": {"r2": round(r2_m,4), "median_mape": round(mape_m,2)},
        },
        "features": "previous area, previous rate, dt, previous bearing (sin/cos/valid) - no wind, terrain or land cover",
    }
    previous_known = np.array([a.bearing_deg is not None for a,_ in pairs])
    valid_direction = direction_known & previous_known & np.isfinite(pred_sin) & np.isfinite(pred_cos)
    if valid_direction.any():
        previous = np.array([a.bearing_deg if a.bearing_deg is not None else 0 for a,_ in pairs])
        prediction = np.degrees(np.arctan2(pred_sin,pred_cos)) % 360
        err_pers = np.abs((target_bearing[valid_direction]-previous[valid_direction]+180)%360-180)
        err_model = np.abs((target_bearing[valid_direction]-prediction[valid_direction]+180)%360-180)
        result["bearing"] = {
            "pairs": int(valid_direction.sum()), "fires": len(set(fires[valid_direction])),
            "persistence_median_error_deg": round(float(np.median(err_pers)),2),
            "model_median_error_deg": round(float(np.median(err_model)),2),
        }
    return result


def main() -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    results = []
    fixtures: dict[str, str] = {}
    failed: list[str] = []
    # PT-FireSprd carries an observed rate of frontal advance. MedEU does not, so
    # its "rate" is the displacement of the centroid of a growing polygon over the
    # gap - a drift measure rather than frontal advance.
    corpora = (
        ("PT-FireSprd", load_pt_firesprd, "frontal"),
        ("FireSpread_MedEU", load_medeu, "centroid_drift"),
    )
    for label, loader, rate_basis in corpora:
        try:
            states = loader()
        except Exception as exc:
            print(f"{label}: NOT COMPUTED ({exc})", file=sys.stderr)
            failed.append(label)
            continue
        # The gap-filtered row (primary) is the one the server reads, so the model
        # block attaches to it explicitly rather than to whatever the loop left behind.
        all_pairs = score_corpus(states, label, None, rate_basis)
        primary = score_corpus(states, label, MAX_GAP_HOURS, rate_basis)
        results.extend((all_pairs, primary))
        # Stdout traces only; the artifact below is what must be JSON-clean.
        print(json.dumps(all_pairs, indent=2))
        print(json.dumps(primary, indent=2))
        try:
            primary["model"] = score_model(states, MAX_GAP_HOURS)
        except Exception as exc:
            print(f"{label}: model NOT COMPUTED ({exc})", file=sys.stderr)
            primary["model"] = {"computed": False, "reason": str(exc)}
        print(json.dumps(primary["model"], indent=2))
        fixtures[label] = (
            json.dumps(
                {"source": SOURCE, "generator": GENERATOR, "states": [asdict(x) for x in states]},
                separators=(",", ":"),
            )
            + "\n"
        )

    # Write nothing until every corpus scored. A loader that fails on this machine -
    # every machine but the data box - must not overwrite the committed artifact with
    # an empty list and report success; the reader following the docs would destroy
    # the numbers the docs describe.
    expected = {label for label, _, _ in corpora}
    scored = {r["corpus"] for r in results}
    missing = sorted(expected - scored)
    if failed or missing:
        print(
            f"refusing to write {OUT / 'metrics.json'}: "
            f"scored {sorted(scored)}; failed {sorted(failed)}; missing {missing}",
            file=sys.stderr,
        )
        return 1

    # allow_nan=False: a NaN is not JSON. Emitting one would ship an artifact that
    # JSON.parse rejects, and the server would serve it as "the harness has no scores".
    # The wrapper carries the provenance the other data/ artifacts carry.
    try:
        metrics_text = (
            json.dumps(
                {"source": SOURCE, "generator": GENERATOR, "rows": results},
                indent=2,
                allow_nan=False,
            )
            + "\n"
        )
    except ValueError as exc:
        print(f"refusing to write {OUT / 'metrics.json'}: {exc}", file=sys.stderr)
        return 1

    # Write to a temp path and rename, so an interrupted run cannot leave a partial
    # artifact behind the committed name.
    for label, text in fixtures.items():
        _write_atomic(OUT / f"fixture-{label}.json", text)
    _write_atomic(OUT / "metrics.json", metrics_text)
    print(f"\nwrote {OUT/'metrics.json'}")
    return 0


def _write_atomic(path: Path, text: str) -> None:
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(text)
    tmp.replace(path)


if __name__ == "__main__":
    raise SystemExit(main())
