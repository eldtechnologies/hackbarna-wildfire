"""Fire episodes from the MTG FRP archive.

The archive is a stream of active-fire pixels at 10-minute cadence. An episode is
one fire: pixels that are close in space and continuous in time. Both halves of a
training sample come from here - the observed state is the input, and the fire's own
later state is the label - so the archive is self-contained.

Two knobs decide the event set and both are stated in the output, because a
different eps or gap gives a different number of fires:

  eps_km    how far apart two pixels may be and still be one fire
  gap_hours how long the fire may go undetected and still be one fire

A gap is not evidence the fire stopped: cloud causes gaps in a geostationary
product. So the gap is generous, and the episode keeps the gap as data rather than
splitting on it silently.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import pandas as pd

# Degrees to km. Longitude shrinks with latitude; Iberia spans roughly 36-44 N, so
# the mid-latitude factor is used and the resulting distortion is stated, not hidden.
KM_PER_DEG_LAT = 110.54
KM_PER_DEG_LON_AT_40N = 111.32 * np.cos(np.radians(40.0))

# The archive's own nominal cadence is 10 minutes; an hour is the working step.
NOMINAL_STEP_MIN = 10


@dataclass(frozen=True)
class EpisodeParams:
    eps_km: float = 5.0
    min_samples: int = 4
    gap_hours: float = 6.0
    min_observations: int = 30


def load_hotspots(csv_gz_path: str) -> pd.DataFrame:
    """Read an Iberia hotspot table and give it a parsed UTC time.

    Uses the parallax-corrected position: the raw longitude/latitude are where the
    satellite saw the pixel, and over Iberia at a 40 degree view angle the parallax
    is kilometres - enough to move a detection across the road it is closing.
    """
    df = pd.read_csv(csv_gz_path)
    df["t"] = pd.to_datetime(df["observed_at_utc"], utc=True)
    df["lon"] = df["LONGITUDE_PARALLAX"]
    df["lat"] = df["LATITUDE_PARALLAX"]
    # PIXEL_SIZE is an area in km2, not a length. Summing it double-counts repeat
    # observations of one pixel, so it is used per-observation only.
    df["pixel_km2"] = df["PIXEL_SIZE"]
    return df.sort_values("t").reset_index(drop=True)


def assign_episodes(df: pd.DataFrame, p: EpisodeParams) -> pd.DataFrame:
    """Label every detection with (cluster, episode).

    Spatial clustering first, then a split on time gaps inside each cluster. The
    two are separate because re-running one should not silently change the other.
    """
    from sklearn.cluster import DBSCAN

    x = np.c_[df["lon"].values * KM_PER_DEG_LON_AT_40N, df["lat"].values * KM_PER_DEG_LAT]
    cluster = DBSCAN(eps=p.eps_km, min_samples=p.min_samples).fit_predict(x)

    out = df.copy()
    out["cluster"] = cluster
    out["gap_h"] = (
        out.groupby("cluster")["t"].diff().dt.total_seconds().div(3600).fillna(0.0)
    )
    # cumsum over a boolean would count cluster -1 rows together; they are dropped.
    out["episode"] = (
        (out["gap_h"] > p.gap_hours).groupby(out["cluster"]).cumsum().astype(int)
    )
    out.loc[out["cluster"] < 0, "episode"] = -1
    return out


def episode_ids(df: pd.DataFrame, p: EpisodeParams) -> pd.DataFrame:
    """One row per episode that is long enough to train on."""
    grouped = df[df["cluster"] >= 0].groupby(["cluster", "episode"])
    keep = grouped.size()
    keep = keep[keep >= p.min_observations].index
    rows = []
    for cluster, episode in keep:
        g = df[(df["cluster"] == cluster) & (df["episode"] == episode)]
        rows.append(
            {
                "cluster": int(cluster),
                "episode": int(episode),
                "event_id": f"c{int(cluster):04d}e{int(episode):02d}",
                "observations": int(len(g)),
                "start": g["t"].min(),
                "end": g["t"].max(),
                "span_hours": (g["t"].max() - g["t"].min()).total_seconds() / 3600.0,
                "lon": float(g["lon"].mean()),
                "lat": float(g["lat"].mean()),
                "lon_min": float(g["lon"].min()),
                "lon_max": float(g["lon"].max()),
                "lat_min": float(g["lat"].min()),
                "lat_max": float(g["lat"].max()),
                "frp_max_mw": float(g["FRP"].max()),
                "observations_area_km2": float(g["pixel_km2"].sum()),
            }
        )
    columns = [
        "cluster", "episode", "event_id", "observations", "start", "end", "span_hours",
        "lon", "lat", "lon_min", "lon_max", "lat_min", "lat_max", "frp_max_mw",
        "observations_area_km2",
    ]
    if not rows:
        # No episode long enough is a valid answer. Returning a frame without its
        # columns would move the failure to the caller's next line.
        return pd.DataFrame(columns=columns)
    return pd.DataFrame(rows).sort_values("observations", ascending=False).reset_index(drop=True)
