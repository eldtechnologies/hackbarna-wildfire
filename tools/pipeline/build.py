#!/usr/bin/env python3
"""Assemble the fire-spread training dataset from the MTG FRP archive.

    cd tools/pipeline
    uv run --with pandas --with numpy --with scikit-learn python build.py --archive /path/to/LSA_SAF_MTFRPPixel_2026

Streams samples to `.npz` shards. Nothing holds the whole dataset in memory: 783
events at 128x128 float32 is tens of gigabytes, and a run that dies at event 700
because of RAM is a run that produced nothing.

Writes to `data/wildfire-spread/`: `events.csv`, `shard-XXXX.npz`, `report.json`. The
report carries the numbers the shards imply *and* a provenance block (git revision, the
resolved archive path, every parameter), so a reader can check the artifacts against
what produced them rather than trusting either.

Getting the archive
-------------------
The 77 GB archive is not in this repo. It is the **LSA SAF MTG FRP-Pixel**
product (`MTFRPPIXEL`), free and key-less, from the LSA SAF portal:

    https://lsa-saf.eumetsat.int/     (Fire Products -> FRP)

`build.py` reads one file from it:

    <archive>/analysis/iberia_bbox_hotspots.csv.gz

That extract is the product's pixel table filtered to the Iberia bbox and gzipped.
It must carry these columns, which `events.load_hotspots` reads:

    observed_at_utc, LONGITUDE_PARALLAX, LATITUDE_PARALLAX, FRP,
    FIRE_CONFIDENCE, PIXEL_SIZE

Point `--archive` at the extracted directory, or set `WF_ARCHIVE`. See
`docs/DATA_SOURCES.md` for what the archive holds and why each column is used.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import time
from pathlib import Path

import numpy as np

from events import EpisodeParams, assign_episodes, episode_ids, load_hotspots
from frames import DEFAULT_CELL_DEG, FrameParams, build_samples

ROOT = Path(__file__).resolve().parent.parent.parent
DEFAULT_OUT = ROOT / "data" / "wildfire-spread"

# No personal path here. The archive is external and named on the command line
# (or in WF_ARCHIVE); see "Getting the archive" above.
DEFAULT_ARCHIVE = Path(os.environ.get("WF_ARCHIVE", "archive/LSA_SAF_MTFRPPixel_2026"))

SHARD_SAMPLES = 512


class Stats:
    """Running totals, so the report does not need the samples again."""

    def __init__(self) -> None:
        self.samples = 0
        self.events: set[str] = set()
        self.frp_sum: list[float] = []
        self.label_sum: list[float] = []
        self.fires_that_stop = 0
        self.no_detection = 0

    def add(self, s: dict) -> None:
        cur = float(s["current_frp"].sum())
        lab = float(s["label_frp"].sum())
        self.samples += 1
        self.events.add(s["event_id"])
        self.frp_sum.append(cur)
        self.label_sum.append(lab)
        if cur > 0 and lab == 0:
            self.fires_that_stop += 1
        if cur == 0:
            self.no_detection += 1

    def as_dict(self) -> dict:
        frp = np.array(self.frp_sum) if self.frp_sum else np.zeros(1)
        lab = np.array(self.label_sum) if self.label_sum else np.zeros(1)
        return {
            "samples": self.samples,
            "events_with_samples": len(self.events),
            "samples_with_fire_in_window": int((frp > 0).sum()),
            "samples_with_fire_in_label": int((lab > 0).sum()),
            "samples_with_no_detection": self.no_detection,
            "samples_with_fire_that_stops": self.fires_that_stop,
            "current_frp_mw": {
                "p50": float(np.percentile(frp, 50)),
                "p90": float(np.percentile(frp, 90)),
                "max": float(frp.max()),
            },
        }


def write_shard(path: Path, batch: list[dict]) -> None:
    """One shard holds whole samples.

    The grid origin differs per sample, so the origin travels with each one instead
    of being assumed from the shard. A reader that assumes a shared grid would place
    every fire but the first in the wrong place, and place them plausibly.

    Written to a temporary name and renamed, so an interrupted run never leaves a
    half-written shard for a globbing reader to pick up.
    """
    tmp = path.with_suffix(".part")
    with open(tmp, "wb") as fh:
        np.savez_compressed(
            fh,
            event_id=np.array([s["event_id"] for s in batch]),
            t=np.array([str(s["t"]) for s in batch]),
            history_frp=np.stack([s["history_frp"] for s in batch]),
            history_detections=np.stack([s["history_detections"] for s in batch]),
            current_frp=np.stack([s["current_frp"] for s in batch]),
            current_detections=np.stack([s["current_detections"] for s in batch]),
            label_frp=np.stack([s["label_frp"] for s in batch]),
            label_detections=np.stack([s["label_detections"] for s in batch]),
            cell_area_km2=np.stack([s["cell_area_km2"] for s in batch]),
            lon0=np.array([s["grid"].lon0 for s in batch]),
            lat0=np.array([s["grid"].lat0 for s in batch]),
            cell_deg=np.array([s["grid"].cell_deg for s in batch]),
        )
    tmp.replace(path)


def flush(out: Path, batch: list[dict], shards: list[dict], stats: Stats,
          per_event: dict) -> None:
    name = f"shard-{len(shards):04d}.npz"
    write_shard(out / name, batch)
    shards.append({"file": name, "samples": len(batch)})
    for s in batch:
        stats.add(s)
        per_event[s["event_id"]] = per_event.get(s["event_id"], 0) + 1


def revision(out: Path) -> dict:
    """The git state that produced the artifacts, so a stale tree is visible.

    The output directory is excluded from the dirty check: on the first run the
    artifacts it writes are themselves untracked, and counting them would report
    every build as dirty.
    """
    try:
        head = subprocess.run(["git", "rev-parse", "HEAD"], cwd=ROOT,
                              capture_output=True, text=True, check=True).stdout.strip()
        rel = out.resolve().relative_to(ROOT.resolve())
        dirty = bool(subprocess.run(
            ["git", "status", "--porcelain", "--", ".", f":(exclude){rel}"],
            cwd=ROOT, capture_output=True, text=True).stdout.strip())
    except (subprocess.CalledProcessError, FileNotFoundError, ValueError):
        head, dirty = "unknown", None
    return {"git_revision": head, "git_dirty": dirty}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--legacy-reproduction", action="store_true",
                    help="Explicitly reproduce historical, unmasked shards; use tools.next_run for training")
    ap.add_argument("--archive", type=Path, default=DEFAULT_ARCHIVE)
    ap.add_argument("--out", type=Path, default=DEFAULT_OUT)
    ap.add_argument("--cell-deg", type=float, default=DEFAULT_CELL_DEG)
    ap.add_argument("--horizon-hours", type=int, default=6)
    ap.add_argument("--step-minutes", type=int, default=60)
    ap.add_argument("--history-hours", type=int, default=3)
    ap.add_argument("--min-observations", type=int, default=30)
    ap.add_argument("--max-events", type=int, default=0, help="0 means all")
    ap.add_argument("--force", action="store_true",
                    help="clear existing shards in --out instead of refusing")
    args = ap.parse_args()
    if not args.legacy_reproduction:
        ap.error("Historical builder disabled by default. Use tools.next_run (tools/next_run/README.md), or --legacy-reproduction to reproduce the old experiment.")

    args.out.mkdir(parents=True, exist_ok=True)
    stale = sorted(args.out.glob("shard-*.npz"))
    if stale:
        # Shards are named by index, so a run that makes fewer would leave the tail
        # of a previous run behind and a globbing reader would score the mixture.
        if not args.force:
            raise SystemExit(
                f"{args.out} already holds {len(stale)} shard(s); refusing to mix them "
                "with a new run. Pass --force to clear them, or use a fresh --out."
            )
        for f in stale:
            f.unlink()

    csv = args.archive / "analysis" / "iberia_bbox_hotspots.csv.gz"
    if not csv.exists():
        raise SystemExit(
            f"no hotspot table at {csv}\n"
            "Point --archive at an extracted LSA SAF MTG FRP-Pixel directory "
            "(or set WF_ARCHIVE); see the module docstring for how to get it."
        )

    started = time.time()
    obs = load_hotspots(str(csv))
    dropped = int(obs.attrs.get("rows_dropped_no_timestamp", 0))
    print(f"observation rows: {len(obs)}" + (f" (+{dropped} dropped, no timestamp)" if dropped else ""))

    p = EpisodeParams(min_observations=args.min_observations)
    obs = assign_episodes(obs, p)
    events = episode_ids(obs, p)
    covered = events["observations"].sum()
    print(f"episodes >= {p.min_observations} obs: {len(events)} "
          f"({covered} rows, {100 * covered / len(obs):.1f}% of the archive)")
    if args.max_events:
        events = events.head(args.max_events)

    stats = Stats()
    batch: list[dict] = []
    shards: list[dict] = []
    per_event: dict[str, int] = {}
    frame_params = FrameParams(
        horizon_hours=args.horizon_hours,
        step_minutes=args.step_minutes,
        history_hours=args.history_hours,
    )
    for sample in build_samples(obs, events, cell_deg=args.cell_deg, p=frame_params):
        batch.append(sample)
        if len(batch) >= SHARD_SAMPLES:
            flush(args.out, batch, shards, stats, per_event)
            batch = []
    if batch:
        flush(args.out, batch, shards, stats, per_event)

    # The manifest carries each event's sample count, so an event that yields none
    # is visible in the artifact instead of only as a gap between two totals.
    events = events.assign(samples=events["event_id"].map(per_event).fillna(0).astype(int))
    events.to_csv(args.out / "events.csv", index=False)
    report = stats.as_dict()
    report.update(
        {
            "archive_rows": int(len(obs)),
            "rows_dropped_no_timestamp": dropped,
            "observations_span": [str(obs["t"].min()), str(obs["t"].max())],
            "observations_in_events": int(covered),
            "events": int(len(events)),
            "events_without_samples": int((events["samples"] == 0).sum()),
            "cell_deg": args.cell_deg,
            "horizon_hours": frame_params.horizon_hours,
            "history_hours": frame_params.history_hours,
            "step_minutes": frame_params.step_minutes,
            "episode_params": {
                "eps_km": p.eps_km,
                "min_samples": p.min_samples,
                "gap_hours": p.gap_hours,
                "min_observations": p.min_observations,
            },
            "shard_samples": SHARD_SAMPLES,
            "shards": shards,
            "archive": str(csv.resolve()),
            "seconds": round(time.time() - started, 1),
            **revision(args.out),
        }
    )
    (args.out / "report.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps({k: v for k, v in report.items() if k != "shards"}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
