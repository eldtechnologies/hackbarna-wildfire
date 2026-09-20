"""Gridding the fire archive into frames and training samples.

One sample is: what the fire looked like up to time t, plus what it looked like
afterwards. Both come from the same archive, so the dataset needs no external label
source - but it does mean the label inherits every gap and every missed detection,
which is why the detection count travels with each sample.

The label horizon is a parameter, not a constant. The harness measured that the
naive predictors' area score collapses as the horizon grows, so a dataset that hard
codes one horizon would bake in one answer.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

# The archive's own grid is about 1.5 km at nadir over Iberia. A 0.02 degree cell is
# about 2.2 km north-south and 1.7 km east-west at 40 N - close to one archive pixel -
# which keeps a patch of 128 cells at roughly 220-280 km, wider than any fire here.
DEFAULT_CELL_DEG = 0.02


@dataclass(frozen=True)
class Grid:
    """A regular lat/lon grid. Row 0 is the northern edge."""

    lon0: float
    lat0: float
    cell_deg: float
    height: int
    width: int

    @property
    def lat_top(self) -> float:
        return self.lat0 + self.height * self.cell_deg

    # A coordinate exactly on a cell boundary must land in the cell it opens, not
    # the one before it. Without this the quotient for index 4 can evaluate to
    # 3.9999999999999996 and floor to 3, so half the patch edges shift by one cell -
    # silently, and only for some float values.
    _BOUNDARY_EPS = 1e-9

    def cell_of(self, lon: np.ndarray, lat: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        col = np.floor((np.asarray(lon) - self.lon0) / self.cell_deg + self._BOUNDARY_EPS).astype(int)
        row = np.floor((self.lat_top - np.asarray(lat)) / self.cell_deg + self._BOUNDARY_EPS).astype(int)
        return row, col

    def contains(self, row: np.ndarray, col: np.ndarray) -> np.ndarray:
        return (row >= 0) & (row < self.height) & (col >= 0) & (col < self.width)

    def area_km2(self) -> np.ndarray:
        """Per-cell area. Longitude spacing shrinks with latitude, so this is a
        column vector: one area per row, not one number for the grid."""
        lat_centres = self.lat_top - (np.arange(self.height) + 0.5) * self.cell_deg
        km_lat = self.cell_deg * 110.54
        km_lon = self.cell_deg * 111.32 * np.cos(np.radians(lat_centres))
        return (km_lat * km_lon).reshape(-1, 1)


def grid_around(lon: float, lat: float, cell_deg: float = DEFAULT_CELL_DEG, cells: int = 128) -> Grid:
    half = cells // 2
    return Grid(
        lon0=lon - half * cell_deg,
        lat0=lat - half * cell_deg,
        cell_deg=cell_deg,
        height=cells,
        width=cells,
    )


@dataclass(frozen=True)
class FrameParams:
    step_minutes: int = 60
    horizon_hours: int = 6
    history_hours: int = 3


def _accumulate(obs, grid: Grid, t_from, t_to) -> dict[str, np.ndarray]:
    """Sum FRP, FIRMS-style count and detection count into grid cells.

    A missing FRP stays missing: it counts as a detection and contributes nothing to
    the FRP sum, so a sensor that reports no power cannot make a cell look burnt.
    """
    frp = np.zeros((grid.height, grid.width), dtype=np.float32)
    count = np.zeros((grid.height, grid.width), dtype=np.float32)

    window = obs[(obs["t"] >= t_from) & (obs["t"] < t_to)]
    if len(window) == 0:
        return {"frp": frp, "detections": count}

    row, col = grid.cell_of(window["lon"].values, window["lat"].values)
    inside = grid.contains(row, col)
    row, col = row[inside], col[inside]
    if len(row) == 0:
        return {"frp": frp, "detections": count}

    frp_values = window["FRP"].values[inside]
    measured = np.isfinite(frp_values) & (frp_values > 0)

    np.add.at(frp, (row[measured], col[measured]), frp_values[measured])
    np.add.at(count, (row, col), 1.0)
    return {"frp": frp, "detections": count}


def build_samples(
    obs,
    events,
    cell_deg: float = DEFAULT_CELL_DEG,
    cells: int = 128,
    p: FrameParams = FrameParams(),
):
    """Yield one training sample per event per step that has both history and a label.

    A generator, not a list: 783 events at 128x128 float32 is tens of gigabytes if it
    is all held at once, and nothing here needs two samples in memory at a time.
    """
    import pandas as pd

    step = pd.Timedelta(minutes=p.step_minutes)
    for ev in events.itertuples(index=False):
        g = obs[(obs["cluster"] == ev.cluster) & (obs["episode"] == ev.episode)]
        if len(g) < 2:
            continue
        grid = grid_around(ev.lon, ev.lat, cell_deg, cells)
        t0, t1 = g["t"].min(), g["t"].max()

        t = t0 + pd.Timedelta(hours=p.history_hours)
        horizon = pd.Timedelta(hours=p.horizon_hours)
        # The label is a full `horizon` wide and starts after the current window.
        # Ending it at t+horizon instead would make it horizon-step wide, so
        # horizon_hours=6 would silently label five hours of burn.
        while t + step + horizon <= t1:
            history = _accumulate(g, grid, t - pd.Timedelta(hours=p.history_hours), t)
            window = _accumulate(g, grid, t, t + step)
            label = _accumulate(g, grid, t + step, t + step + horizon)
            seen = (history["detections"] > 0) | (window["detections"] > 0)
            if not seen.any():
                # Nothing observed near t: the sample would be all zeros with a
                # label from a fire we never saw start. Skipped.
                t += step
                continue
            yield (
                {
                    "event_id": ev.event_id,
                    "t": t,
                    "history_frp": history["frp"],
                    "history_detections": history["detections"],
                    "current_frp": window["frp"],
                    "current_detections": window["detections"],
                    "label_frp": label["frp"],
                    "label_detections": label["detections"],
                    "cell_area_km2": grid.area_km2(),
                    "grid": grid,
                }
            )
            t += step
