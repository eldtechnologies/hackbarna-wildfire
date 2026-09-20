"""Deterministic episode catalogue and geographically separated evaluation groups.

Spatial components are evaluation groups, not independently verified incidents.
They never supply the patch centre: that comes from the episode's first detection.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.cluster import DBSCAN

from .common import digest, write_json, SIZE, TAIL_HOURS, HORIZONS, validation_role


def catalogue(df, gap_hours=24, min_observations=4):
    df = df.sort_values(["observed_at", "ABS_LINE", "ABS_SAMP"]).copy()
    if df.observed_at.isna().any():
        raise ValueError("Missing timestamps must be fixed at extraction, not dropped")
    # Unique native pixels make clustering independent of repetition count and
    # prevent quadratic memory growth on industrial sources with 100k detections.
    pixels = df.groupby(["ABS_LINE", "ABS_SAMP"], sort=True).agg(
        lat=("LATITUDE", "first"), lon=("LONGITUDE", "first")).reset_index()
    c = DBSCAN(eps=5 / 6371.0088, min_samples=1, metric="haversine", algorithm="ball_tree").fit_predict(
        np.radians(pixels[["lat", "lon"]].to_numpy()))
    pixels["component"] = c
    df = df.merge(pixels[["ABS_LINE", "ABS_SAMP", "component"]], on=["ABS_LINE", "ABS_SAMP"], validate="many_to_one")
    df = df.sort_values(["observed_at", "ABS_LINE", "ABS_SAMP"])
    rows = []
    for _, g in df.groupby("component", sort=True):
        locations = sorted(set(zip(g.ABS_LINE.tolist(), g.ABS_SAMP.tolist())))
        # Hold out contiguous regions, rather than scattering held-out sites
        # throughout every training patch. All episodes in a component stay together.
        native = np.asarray(locations)
        group = f"native256-{int(np.median(native[:,0]))//256}-{int(np.median(native[:,1]))//256}"
        episode = g.observed_at.diff().dt.total_seconds().gt(gap_hours * 3600).cumsum()
        for _, event in g.groupby(episode):
            if len(event) < min_observations:
                continue
            first = event.iloc[0]
            event_id = digest([str(first.observed_at), int(first.ABS_LINE), int(first.ABS_SAMP)])[:24]
            # Long-lived sources are kept explicitly; do not call them wildfires.
            # Their later daily recurrence is not used to erase early observations.
            rows.append(dict(event_id=event_id, spatial_group=group,
                             start=str(first.observed_at), end=str(event.observed_at.max()),
                             seed_scan_time=str(first.scan_time),
                             seed_row=int(first.ABS_LINE), seed_col=int(first.ABS_SAMP),
                             lon=float(first.lon), lat=float(first.lat), observations=len(event),
                             duration_hours=(event.observed_at.max()-first.observed_at).total_seconds()/3600,
                             source_kind="unverified_thermal_episode"))
    return pd.DataFrame(rows)


def split_for(group, start, end, cutoff="2026-08-01T00:00:00Z", validation_start="2026-07-01T00:00:00Z"):
    bucket = int(digest(["split-v1", group])[:8], 16) % 100
    start, end = pd.Timestamp(start), pd.Timestamp(end)
    cut, val = pd.Timestamp(cutoff), pd.Timestamp(validation_start)
    if bucket < 70 and end < cut:
        return "train"
    if 70 <= bucket < 85 and start >= val and end < cut:
        return "validation"
    if bucket >= 85 and start >= cut:
        return "test"
    return "reserved"


def purge_overlaps(events):
    events=events.copy()
    events["role"]=[validation_role(r.spatial_group) if r.split=="validation" else r.split
                    for r in events.itertuples()]
    purged=0
    for role,protected in [("calibration",["test"]), ("selection",["calibration","test"]),
                           ("train",["selection","calibration","test"])]:
        ref=events[events.role.isin(protected)][["seed_row","seed_col"]].to_numpy()
        for i,r in events[events.role==role].iterrows():
            if len(ref) and ((np.abs(ref[:,0]-r.seed_row)<SIZE)&(np.abs(ref[:,1]-r.seed_col)<SIZE)).any():
                events.loc[i,["split","role"]]="reserved"
                purged+=1
    return events,purged


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--extract", type=Path, required=True)
    ap.add_argument("--out", type=Path, required=True)
    a = ap.parse_args()
    a.out.mkdir(parents=True, exist_ok=True)
    df = pd.read_parquet(a.extract / "observations.parquet")
    extraction = json.loads((a.extract / "extraction.json").read_text())
    # A fixed, pre-training warm-up period supplies a persistent-heat exclusion.
    # Never inspect later/test recurrence to decide whether an earlier cell is fire.
    warm = df[df.observed_at < pd.Timestamp("2026-04-01T00:00:00Z")].copy()
    warm["day"] = warm.observed_at.dt.floor("D")
    recurring = warm.groupby(["ABS_LINE", "ABS_SAMP"]).day.nunique()
    persistent = recurring[recurring >= 20].index.tolist()
    excluded = {(r+dr,c+dc) for r,c in persistent for dr in [-1,0,1] for dc in [-1,0,1]}
    write_json(a.out / "persistent_prior.json", dict(cutoff="2026-04-01T00:00:00Z",
               minimum_days=20, cells=sorted(excluded),
               use="Fixed training-period label exclusion only; not an input feature or claimed live service",
               limitation="Heuristic persistent heat, not authoritative incident labels; early product publication times unavailable"))
    df = df[df.observed_at >= pd.Timestamp("2026-04-01T00:00:00Z")].copy()
    df = df[~pd.MultiIndex.from_frame(df[["ABS_LINE", "ABS_SAMP"]]).isin(excluded)]
    events = catalogue(df)
    # Include six hours after the last detection; tail labels are a requirement,
    # not a condition based on whether there is future fire.
    events["sample_end"] = pd.to_datetime(events.end, utc=True) + pd.Timedelta(hours=TAIL_HOURS)
    events["split"] = [split_for(r.spatial_group, r.start, pd.Timestamp(r.sample_end)+pd.Timedelta(hours=max(HORIZONS)))
                       for r in events.itertuples()]
    # A 64x64 native-pixel patch must not overlap another split's patch, even if
    # DBSCAN assigned nearby detections to different spatial components.
    events,purged=purge_overlaps(events)
    events.to_parquet(a.out / "events.parquet", index=False)
    report = dict(dataset_id=extraction["dataset_id"], events=len(events),
                  spatial_groups=events.spatial_group.nunique(),
                  split_counts=events.split.value_counts().to_dict(),
                  role_counts=events.role.value_counts().to_dict(),
                  grouping_radius_km=5, gap_hours=24, overlap_purged=purged,
                  patch_pixels=SIZE, geographic_block_native_pixels=256, persistent_prior_cells=len(excluded),
                  temporal_cutoff="2026-08-01T00:00:00Z",
                  label="future MTG thermal detection, not burned area or confirmed wildfire")
    write_json(a.out / "catalogue.json", report)
    print(report, flush=True)


if __name__ == "__main__":
    main()
