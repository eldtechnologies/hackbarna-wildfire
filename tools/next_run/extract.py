"""Extract only native ListProduct scans; never re-ingest an analysis export.

CSV ACQTIME is YYYYMMDDHHMMSS, not the NetCDF's seconds-since encoding.
Parsing errors fail the build. Native pixel identity is retained for quality joins.
"""
from __future__ import annotations

import argparse
from concurrent.futures import ProcessPoolExecutor
import os
from pathlib import Path
import re

import numpy as np
import pandas as pd
import pyarrow as pa
import pyarrow.parquet as pq

from .common import SCHEMA, digest, write_json

SCAN = re.compile(r"^LSA-509_MTG_MTFRPPIXEL-ListProduct_MTG-FD_(\d{12})\.csv\.gz$")
COLS = ["ACQTIME", "ABS_LINE", "ABS_SAMP", "LONGITUDE", "LATITUDE",
        "LONGITUDE_PARALLAX", "LATITUDE_PARALLAX", "FRP", "FRP_UNCERTAINTY",
        "FIRE_CONFIDENCE", "PIXEL_SIZE"]


def raw_scans(root):
    paths = sorted(p for p in Path(root).glob("*/*/*.csv.gz") if SCAN.fullmatch(p.name))
    names = [p.name for p in paths]
    if len(names) != len(set(names)):
        raise ValueError("Duplicate native scan names")
    if not paths:
        raise ValueError("No native ListProduct scans found")
    return paths


def parse_frame(df, path, bbox):
    match = SCAN.fullmatch(Path(path).name)
    if not match:
        raise ValueError(f"Not a native scan: {path}")
    nominal = pd.to_datetime(match[1], format="%Y%m%d%H%M", utc=True)
    lo, la = df.LONGITUDE_PARALLAX, df.LATITUDE_PARALLAX
    west, south, east, north = bbox
    df = df.loc[lo.between(west, east) & la.between(south, north)].copy()
    # Exact format; no coercion of bad/missing times into silently dropped NaT.
    df["observed_at"] = pd.to_datetime(df.ACQTIME.astype(str), format="%Y%m%d%H%M%S", utc=True)
    if df.observed_at.isna().any():
        raise ValueError(f"Missing acquisition time: {path}")
    if ((df.observed_at < nominal) | (df.observed_at >= nominal + pd.Timedelta(minutes=11))).any():
        raise ValueError(f"Acquisition time outside scan: {path}")
    df["scan_time"] = nominal
    df["scan_id"] = match[1]
    df["source_file"] = "/".join(Path(path).parts[-3:])
    df = df.rename(columns={"LONGITUDE_PARALLAX": "lon", "LATITUDE_PARALLAX": "lat"})
    for c in ["ABS_LINE", "ABS_SAMP"]:
        if (~df[c].between(0, 11135)).any() or (df[c] % 1 != 0).any():
            raise ValueError(f"Invalid native coordinate: {path}")
        df[c] = df[c].astype("int32")
    if df.duplicated(["ABS_LINE", "ABS_SAMP"]).any():
        raise ValueError(f"Duplicate native pixels in {path}")
    for c in ["FRP", "FRP_UNCERTAINTY"]:
        df.loc[~np.isfinite(df[c]) | (df[c] < 0), c] = np.nan
    return df.drop(columns="ACQTIME")


def one(args):
    path, bbox = args
    df = pd.read_csv(path, usecols=COLS, dtype={"ACQTIME": str})
    return parse_frame(df, path, bbox), len(df)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--archive", type=Path, required=True)
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--bbox", type=float, nargs=4, default=[-12, 28, 32, 48])
    ap.add_argument("--workers", type=int, default=8)
    a = ap.parse_args()
    if a.out.exists():
        raise FileExistsError(f"Refusing to overwrite {a.out}")
    a.out.mkdir(parents=True)
    files = raw_scans(a.archive)
    manifest = [{"path": str(p.relative_to(a.archive)), "bytes": p.stat().st_size,
                 "mtime_ns": p.stat().st_mtime_ns} for p in files]
    config = {"schema": SCHEMA, "bbox": a.bbox, "files": manifest}
    writer = None
    total = kept = 0
    temp = a.out / "observations.parquet.partial"
    try:
        with ProcessPoolExecutor(max_workers=a.workers) as pool:
            for i, (df, rows) in enumerate(pool.map(one, ((str(p), a.bbox) for p in files), chunksize=32)):
                total += rows
                if len(df):
                    table = pa.Table.from_pandas(df, preserve_index=False)
                    if writer is None:
                        writer = pq.ParquetWriter(temp, table.schema, compression="zstd")
                    writer.write_table(table)
                    kept += len(df)
                if (i + 1) % 2000 == 0:
                    print(f"scans={i+1}/{len(files)} selected_rows={kept:,}", flush=True)
    finally:
        if writer:
            writer.close()
    if not kept:
        raise ValueError("No selected observations")
    os.replace(temp, a.out / "observations.parquet")
    report = {"schema": SCHEMA, "dataset_id": digest(config), "bbox": a.bbox,
              "scan_count": len(files), "raw_rows": total, "selected_rows": kept,
              "invalid_times": 0, "aggregate_exports_included": 0,
              "archive": str(a.archive.resolve()), "files": manifest}
    write_json(a.out / "extraction.json", report)
    print({k: v for k, v in report.items() if k != "files"}, flush=True)


if __name__ == "__main__":
    main()
