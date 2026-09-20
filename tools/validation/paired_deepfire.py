"""Frozen-model / archived DeepFire comparison on a common native thermal target."""

from pathlib import Path
import argparse, importlib.util, json, math, time
import numpy as np
import pandas as pd
import torch
from scipy.ndimage import distance_transform_edt
from rasterio.features import rasterize
from affine import Affine
from shapely.geometry import shape, mapping
from shapely.ops import transform, unary_union

if __package__:
    from .frozen_inputs import frozen_trainer, paired_inputs, checked_bytes, EVIDENCE, load_checkpoint
else:
    from frozen_inputs import frozen_trainer, paired_inputs, checked_bytes, EVIDENCE, load_checkpoint


def counts(y, alert):
    y = np.asarray(y, bool)
    alert = np.asarray(alert, bool)
    tp = int((y & alert).sum())
    fp = int((~y & alert).sum())
    fn = int((y & ~alert).sum())
    tn = int((~y & ~alert).sum())
    return {
        "tp": tp,
        "fp": fp,
        "fn": fn,
        "tn": tn,
        "precision": tp / (tp + fp) if tp + fp else None,
        "recall": tp / (tp + fn) if tp + fn else None,
        "f1": 2 * tp / (2 * tp + fp + fn) if 2 * tp + fp + fn else None,
        "csi": tp / (tp + fp + fn) if tp + fp + fn else None,
        "predicted_cells": tp + fp,
    }

def raster(sim, h, row0, col0, geos, size):
    geometries = []
    for f in sim["result"]["features"]:
        if float(f["properties"]["hour"]) <= h:
            geom = shape(f["geometry"])
            if not geom.is_valid:
                raise ValueError("Invalid DeepFire geometry")
            geometries.append(transform(geos, geom))
    if not geometries:
        return np.zeros((size, size), bool)
    trans = Affine(1000, 0, (col0 - 5568) * 1000, 0, -1000, (5568 - row0) * 1000)
    return rasterize(
        [(mapping(g), 1) for g in geometries],
        out_shape=(size, size),
        transform=trans,
        all_touched=True,
        dtype="uint8",
    ).astype(bool)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data-work-root", type=Path, required=True)
    parser.add_argument("--run-directory", type=Path, required=True)
    parser.add_argument("--archive-directory", type=Path, required=True)
    args = parser.parse_args()
    BASE = args.data_work_root.resolve()
    OUT = args.run_directory.resolve()
    ARCH = args.archive_directory.resolve()
    TRAINER = BASE / "next-run-pipeline"
    REPO = Path(__file__).resolve().parents[2]
    if (OUT / "frames").exists():
        raise FileExistsError(
            "Use a fresh run directory with protocol.json, eligible.json and weather/, so predictions cannot silently be reused."
        )
    PROTOCOL, rows = paired_inputs(OUT, ARCH)
    checked_bytes(REPO / 'tools/next_run/inputs.py',
                  json.loads((EVIDENCE / 'paired-input-source-lock.json').read_text())['inputs.py'])
    with frozen_trainer(TRAINER) as namespace:
        quality = importlib.import_module(namespace + '.quality')
        GEOS, Quality, labels, lonlat = quality.GEOS, quality.Quality, quality.labels, quality.lonlat
        Weather = importlib.import_module(namespace + '.weather').Weather
        terrain_module = importlib.import_module(namespace + '.terrain')
        Terrain, tile_name = terrain_module.Terrain, terrain_module.tile_name
        common = importlib.import_module(namespace + '.common')
        CHANNELS, HORIZONS, SIZE, file_hash = common.CHANNELS, common.HORIZONS, common.SIZE, common.file_hash
        trainer = importlib.import_module(namespace + '.train')
        UNet, calibrate = trainer.UNet, trainer.calibrate

        spec = importlib.util.spec_from_file_location(
            namespace + ".paired_inputs", REPO / "tools/next_run/inputs.py"
        )
        inputs = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(inputs)
        InputFrame = inputs.InputFrame

        class CachedTerrain(Terrain):
            def tile(self, kind, lat, lon):
                name, _ = tile_name(kind, lat, lon)
                p = Path(CFG["static_cache"]) / (name + ".npz")
                if p.exists():
                    with np.load(p) as d:
                        return d["data"], d["meta"]
                return super().tile(kind, lat, lon)

        def save(path, value):
            path.write_text(json.dumps(value, indent=2) + "\n")

        DATA = BASE / "next-run-data/full-v1"
        MANIFEST = json.loads((DATA / "manifest.json").read_text())
        CFG = MANIFEST["config"]
        for path, key in [
            (DATA / "manifest.json", "manifest_sha256"),
            (BASE / "next-run-data/run-001/frozen.pt", "checkpoint_sha256"),
            (TRAINER / "tools/next_run/train.py", "trainer_sha256"),
        ]:
            if file_hash(path) != PROTOCOL[key]:
                raise ValueError("Frozen identity mismatch: " + key)
        q = Quality(CFG["archive"])
        w = Weather(OUT / "weather")
        terrain = CachedTerrain(
            OUT / "static", CFG.get("existing_tiles"), allow_remote=True
        )
        persistent = set(
            map(
                tuple,
                json.loads((Path(CFG["catalogue"]) / "persistent_prior.json").read_text())[
                    "cells"
                ],
            )
        )
        torch.set_num_threads(2)
        saved = load_checkpoint(BASE / "next-run-data/run-001/frozen.pt")
        model = UNet(len(CHANNELS), saved["base"]).eval()
        model.load_state_dict(saved["state"])
        (OUT / "frames").mkdir(exist_ok=True)
        prepared = []
        excluded = []
        started = time.monotonic()
        # Reproduce one original held-out input with this InputFrame implementation before new inference.
        e = next(e for e in MANIFEST["events"] if e["role"] == "test" and e["samples"])
        cat = pd.read_parquet(Path(CFG["catalogue"]) / "events.parquet").set_index(
            "event_id"
        )
        event = cat.loc[e["event_id"]].to_dict()
        event["event_id"] = e["event_id"]
        issue = pd.Timestamp(str(np.load(DATA / e["file"] / "issue.npy")[0]))
        r0 = int(event["seed_row"]) - 32
        c0 = int(event["seed_col"]) - 32
        obs = pd.read_parquet(
            Path(CFG["extract"]) / "observations.parquet",
            columns=["ABS_LINE", "ABS_SAMP", "observed_at", "scan_time", "FRP"],
            filters=[
                ("ABS_LINE", ">=", r0),
                ("ABS_LINE", "<", r0 + 64),
                ("ABS_SAMP", ">=", c0),
                ("ABS_SAMP", "<", c0 + 64),
                ("observed_at", ">=", issue - pd.Timedelta(hours=3)),
                ("observed_at", "<", issue),
            ],
        )
        x, p = InputFrame(event, q, Weather(CFG["weather"]), terrain, obs).at(issue)
        parity = {
            "event": e["event_id"],
            "x_equal": bool(
                np.array_equal(x, np.load(DATA / e["file"] / "X.npy", mmap_mode="r")[0])
            ),
            "p_equal": bool(
                np.array_equal(p, np.load(DATA / e["file"] / "P.npy", mmap_mode="r")[0])
            ),
        }
        if not parity["x_equal"] or not parity["p_equal"]:
            raise ValueError("Original input reconstruction failed")
        save(OUT / "input-parity.json", parity)
        print(json.dumps({"input_parity": parity}), flush=True)
        for i, row in enumerate(rows):
            sid = row["id"]
            path = OUT / "frames" / (sid + ".npz")
            issue = pd.Timestamp(row["model_issue"])
            r0 = row["row"] - 32
            c0 = row["col"] - 32
            try:
                if not path.exists():
                    anchors = [
                        t
                        for t in pd.date_range(
                            issue - pd.Timedelta(hours=3),
                            issue,
                            freq="10min",
                            inclusive="left",
                        )
                        if (a := q.availability(str(t))) is not None and a <= issue
                    ]
                    if not anchors:
                        raise ValueError("No available quality product in input history")
                    # This is an on-demand prediction at a saved ignition location, not a newly detected native episode.
                    # seed_scan_time is an availability anchor only; it does not claim a fire was detected there.
                    event = {
                        "event_id": "deepfire-" + sid,
                        "seed_row": row["row"],
                        "seed_col": row["col"],
                        "seed_scan_time": str(anchors[0]),
                        "lon": row["lon"],
                        "lat": row["lat"],
                    }
                    obs = pd.read_parquet(
                        Path(CFG["extract"]) / "observations.parquet",
                        columns=["ABS_LINE", "ABS_SAMP", "observed_at", "scan_time", "FRP"],
                        filters=[
                            ("ABS_LINE", ">=", r0),
                            ("ABS_LINE", "<", r0 + 64),
                            ("ABS_SAMP", ">=", c0),
                            ("ABS_SAMP", "<", c0 + 64),
                            ("observed_at", ">=", issue - pd.Timedelta(hours=3)),
                            ("observed_at", "<", issue),
                        ],
                    )
                    frame = InputFrame(event, q, w, terrain, obs)
                    x, p = frame.at(issue)
                    if not x[
                        [
                            i
                            for i, n in enumerate(CHANNELS)
                            if n.endswith("observable_fraction")
                        ]
                    ].any():
                        raise ValueError("No observable model history")
                    with torch.inference_mode():
                        pred = calibrate(
                            model(torch.from_numpy(x.astype(np.float32))[None])[0].numpy(),
                            saved["calibration"],
                        )
                    if not np.isfinite(pred).all():
                        raise ValueError("Non-finite prediction")
                    np.savez_compressed(
                        path, x=x, p=p, pred=pred, lon=frame.longitude, lat=frame.latitude
                    )
                prepared.append(row)
                print(
                    json.dumps(
                        {
                            "prepared": i + 1,
                            "total": len(rows),
                            "id": sid,
                            "seconds": round(time.monotonic() - started, 1),
                        }
                    ),
                    flush=True,
                )
            except Exception as exc:
                excluded.append(
                    {"id": sid, "reason": str(exc), "error_type": type(exc).__name__}
                )
                print(json.dumps({"excluded": excluded[-1]}), flush=True)
        save(
            OUT / "preparation.json",
            {
                "prepared": prepared,
                "excluded": excluded,
                "input_parity": parity,
                "inputs_source_sha256": file_hash(REPO / "tools/next_run/inputs.py"),
            },
        )
        # All model predictions are now fixed before any future label values are opened.
        results = []
        for row in prepared:
            sid = row["id"]
            frame = np.load(OUT / "frames" / (sid + ".npz"))
            x = frame["x"]
            pred = frame["pred"]
            old = frame["p"]
            issue = pd.Timestamp(row["model_issue"])
            deepfire_issue = pd.Timestamp(row["deepfire_issue"])
            start = deepfire_issue.ceil("10min")
            r0 = row["row"] - 32
            c0 = row["col"] - 32
            sim = json.loads((ARCH / (sid + "-simulation.json")).read_text())["data"]
            known = (
                x[
                    [i for i, n in enumerate(CHANNELS) if n.endswith("observable_fraction")]
                ].max(axis=0)
                > 0
            )
            history = q.sequence(issue - pd.Timedelta(hours=3), start, r0, c0, SIZE)
            past = np.isin(history, [1, 2]).any(axis=0)
            frozen_past = (
                x[[i for i, n in enumerate(CHANNELS) if n.endswith("fire_fraction")]].max(
                    axis=0
                )
                > 0
            )
            prior = np.array(
                [
                    [(r, c) in persistent for c in range(c0, c0 + SIZE)]
                    for r in range(r0, r0 + SIZE)
                ]
            )
            distance_km = np.hypot(
                (frame["lat"] - row["lat"]) * 111.2,
                (frame["lon"] - row["lon"]) * 111.2 * np.cos(np.radians(row["lat"])),
            )
            dist = (
                distance_transform_edt(~(old > 0))
                if old.any()
                else np.full(old.shape, np.inf)
            )
            for hi, h in [(1, 3), (2, 6)]:
                end = issue + pd.Timedelta(hours=h)
                relative = (end - deepfire_issue).total_seconds() / 3600
                if relative > sim["durationHours"]:
                    continue
                flags = q.sequence(start, end, r0, c0, SIZE)
                y, valid = labels(flags, prior)
                lo = math.floor(relative)
                high = math.ceil(relative)
                dlow = raster(sim, lo, r0, c0, GEOS, SIZE)
                dhigh = raster(sim, high, r0, c0, GEOS, SIZE)
                predictions = {
                    "model_0.1": pred[hi] >= 0.1,
                    "model_0.25": pred[hi] >= 0.25,
                    "model_0.5": pred[hi] >= 0.5,
                    "deepfire_earlier": dlow,
                    "deepfire_later": dhigh,
                    "persistence": old > 0,
                    "dilation_2px": dist <= 2,
                }
                for radius in [20, 10]:
                    for maskname, mask in [
                        ("novel", known & ~past & ~frozen_past),
                        ("all", known),
                    ]:
                        use = mask & valid & (distance_km <= radius)
                        yy = y[use].astype(bool)
                        scores = {k: counts(yy, v[use]) for k, v in predictions.items()}
                        results.append(
                            {
                                "simulation_id": sid,
                                "cluster_id": row["cluster_id"],
                                "name": row["name"],
                                "model_issue": issue.isoformat(),
                                "deepfire_issue": deepfire_issue.isoformat(),
                                "input_age_minutes": (
                                    deepfire_issue - issue
                                ).total_seconds()
                                / 60,
                                "label_start": start.isoformat(),
                                "label_end": end.isoformat(),
                                "horizon": h,
                                "deepfire_hours": [lo, high],
                                "roi_km": radius,
                                "mask": maskname,
                                "cells": int(use.sum()),
                                "positive_cells": int(yy.sum()),
                                "train_geography_overlap": "train" in row["group_roles"]
                                or "train" in row["overlap_roles"],
                                "scores": scores,
                            }
                        )
                np.savez_compressed(
                    OUT / "frames" / (sid + f"-h{h}-labels.npz"),
                    y=y,
                    valid=valid,
                    known=known,
                    novel=known & ~past & ~frozen_past,
                    roi=distance_km <= 20,
                    deepfire_earlier=dlow,
                    deepfire_later=dhigh,
                )
        save(
            OUT / "results.json",
            {
                "protocol": PROTOCOL,
                "preparation_exclusions": excluded,
                "cases": results,
                "seconds": round(time.monotonic() - started, 1),
            },
        )
        summary = []
        for radius in [20, 10]:
            for maskname in ["novel", "all"]:
                for h in [3, 6]:
                    rr = [
                        r
                        for r in results
                        if r["roi_km"] == radius
                        and r["mask"] == maskname
                        and r["horizon"] == h
                    ]
                    totals = {}
                    for name in [
                        "model_0.1",
                        "model_0.25",
                        "model_0.5",
                        "deepfire_earlier",
                        "deepfire_later",
                        "persistence",
                        "dilation_2px",
                    ]:
                        c = {
                            k: sum(r["scores"][name][k] for r in rr)
                            for k in ["tp", "fp", "fn", "tn"]
                        }
                        tp, fp, fn, tn = [c[k] for k in ["tp", "fp", "fn", "tn"]]
                        c.update(
                            precision=tp / (tp + fp) if tp + fp else None,
                            recall=tp / (tp + fn) if tp + fn else None,
                            f1=2 * tp / (2 * tp + fp + fn) if 2 * tp + fp + fn else None,
                            csi=tp / (tp + fp + fn) if tp + fp + fn else None,
                        )
                        totals[name] = c
                    summary.append(
                        {
                            "roi_km": radius,
                            "mask": maskname,
                            "horizon": h,
                            "forecasts": len(rr),
                            "clusters": len({r["cluster_id"] for r in rr}),
                            "positive_forecasts": sum(r["positive_cells"] > 0 for r in rr),
                            "cells": sum(r["cells"] for r in rr),
                            "positive_cells": sum(r["positive_cells"] for r in rr),
                            "scores": totals,
                        }
                    )
        save(OUT / "summary.json", summary)
        print(
            json.dumps(
                {
                    "complete": True,
                    "prepared": len(prepared),
                    "excluded": len(excluded),
                    "summary": [
                        r for r in summary if r["roi_km"] == 20 and r["mask"] == "novel"
                    ],
                }
            ),
            flush=True,
        )


if __name__ == "__main__":
    main()
