"""Tests for the dataset assembler. Run with:

    cd tools/pipeline
    uv run --with pandas --with numpy --with scikit-learn python -m unittest test_pipeline -v

These pin the rules that decide what the dataset contains. Every one of them was a
real decision at some point, and each is silent when it goes wrong: a grid that
ignores latitude gives plausible slopes, and a missing FRP counted as zero gives a
plausible fire.
"""

import unittest

import numpy as np
import pandas as pd

from events import EpisodeParams, assign_episodes, episode_ids
from frames import FrameParams, Grid, build_samples, grid_around


def obs_frame(rows):
    """Minimal archive-shaped frame: what the assembler actually reads."""
    return pd.DataFrame(
        [
            {
                "t": pd.Timestamp(t, tz="UTC"),
                "lon": lon,
                "lat": lat,
                "FRP": frp,
                "FIRE_CONFIDENCE": 0.8,
                "pixel_km2": 1.5,
            }
            for t, lon, lat, frp in rows
        ]
    )


class TestGrid(unittest.TestCase):
    def test_row_zero_is_the_northern_edge(self):
        g = Grid(lon0=-3.0, lat0=36.0, cell_deg=0.1, height=10, width=10)
        row, col = g.cell_of(np.array([-2.95]), np.array([36.95]))
        self.assertEqual((int(row[0]), int(col[0])), (0, 0), "north-west cell is row 0, col 0")
        row, col = g.cell_of(np.array([-3.05]), np.array([36.05]))
        self.assertEqual((int(row[0]), int(col[0])), (9, -1), "west of the grid is out of range")

    def test_contains_rejects_outside_cells(self):
        g = Grid(lon0=-3.0, lat0=36.0, cell_deg=0.1, height=10, width=10)
        row, col = g.cell_of(np.array([-2.5, -3.5]), np.array([36.5, 36.5]))
        self.assertEqual(list(g.contains(row, col)), [True, False])

    def test_cell_area_shrinks_towards_the_north(self):
        """The whole reason area is a column vector and not a scalar: a cell at 44 N
        is smaller than one at 36 N, and treating them as equal overstates burned
        area in the north."""
        g = Grid(lon0=-3.0, lat0=36.0, cell_deg=0.1, height=80, width=10)
        area = g.area_km2().ravel()
        self.assertEqual(area.shape, (80,))
        # Row 0 is the north edge, so the SOUTHERN row is the last one and the larger.
        self.assertGreater(area[-1], area[0], "southern row must be the larger cell")
        # 0.1 deg of longitude is about 8.0 km at 44 N and about 8.9 km at 36 N.
        self.assertTrue(84.0 < area[0] < 90.0, area[0])
        self.assertTrue(97.0 < area[-1] < 101.0, area[-1])

    def test_grid_around_is_centred(self):
        g = grid_around(lon=-2.0, lat=37.0, cell_deg=0.02, cells=8)
        row, col = g.cell_of(np.array([-2.0]), np.array([37.0]))
        self.assertEqual((int(row[0]), int(col[0])), (4, 4))


class TestEpisodes(unittest.TestCase):
    def test_two_fires_far_apart_are_two_clusters(self):
        """~6 km apart, just outside the 5 km eps, so they must not merge."""
        rows = []
        for i in range(5):
            rows.append((f"2026-07-09T1{i}:00", -6.0, 37.5, 100.0))
            rows.append((f"2026-07-09T1{i}:00", -5.93, 37.5, 100.0))  # ~6 km east
        df = assign_episodes(obs_frame(rows), EpisodeParams(eps_km=5.0))
        self.assertEqual(len(set(df[df.cluster >= 0].cluster)), 2, "6 km apart, eps 5 km")

    def test_fires_inside_eps_are_one_cluster(self):
        rows = []
        for i in range(5):
            rows.append((f"2026-07-09T1{i}:00", -6.0, 37.5, 100.0))
            rows.append((f"2026-07-09T1{i}:00", -5.965, 37.5, 100.0))  # ~3 km east
        df = assign_episodes(obs_frame(rows), EpisodeParams(eps_km=5.0))
        self.assertEqual(len(set(df[df.cluster >= 0].cluster)), 1, "3 km apart, eps 5 km")

    def test_a_long_gap_splits_one_place_into_two_episodes(self):
        """A gap is not evidence the fire stopped, but two burns a week apart are
        not one fire either. The split is at the gap, not at a fixed offset."""
        rows = [(f"2026-07-09T{h:02d}:00", -6.0, 37.5, 100.0) for h in range(4)]
        rows += [(f"2026-07-20T{h:02d}:00", -6.0, 37.5, 100.0) for h in range(4)]
        df = assign_episodes(obs_frame(rows), EpisodeParams(gap_hours=6.0))
        self.assertEqual(df[df.cluster >= 0].episode.nunique(), 2)

    def test_a_short_gap_stays_one_episode(self):
        rows = [(f"2026-07-09T{h:02d}:00", -6.0, 37.5, 100.0) for h in range(4)]
        rows += [(f"2026-07-09T{h + 8:02d}:00", -6.0, 37.5, 100.0) for h in range(4)]
        df = assign_episodes(obs_frame(rows), EpisodeParams(gap_hours=6.0))
        self.assertEqual(df[df.cluster >= 0].episode.nunique(), 1)

    def test_noise_gets_episode_minus_one_and_is_not_an_event(self):
        rows = [(f"2026-07-09T{h:02d}:00", -6.0, 37.5, 100.0) for h in range(4)]
        df = assign_episodes(obs_frame(rows), EpisodeParams(min_samples=5))
        self.assertTrue((df.episode == -1).all(), "a lone detection with min_samples 5 is noise")
        self.assertEqual(len(episode_ids(df, EpisodeParams(min_samples=5))), 0)

    def test_episode_ids_reports_the_bounding_box_and_the_area(self):
        base = pd.Timestamp("2026-07-09T00:00Z")
        rows = [(str(base + pd.Timedelta(minutes=30 * h)), -6.0 + h * 0.01, 37.5, 100.0) for h in range(40)]
        df = assign_episodes(obs_frame(rows), EpisodeParams())
        events = episode_ids(df, EpisodeParams(min_observations=30))
        self.assertEqual(len(events), 1)
        ev = events.iloc[0]
        self.assertEqual(ev.observations, 40)
        self.assertAlmostEqual(ev.lon_max - ev.lon_min, 0.39, places=6)  # 39 steps of 0.01
        self.assertAlmostEqual(ev.observations_area_km2, 60.0, places=6)

    def test_min_observations_is_the_event_filter(self):
        """`min_observations` decides the event set, so its boundary must be pinned:
        a 29-observation episode is out at 30, in at 29."""
        base = pd.Timestamp("2026-07-09T00:00Z")
        rows = [(str(base + pd.Timedelta(minutes=30 * h)), -6.0, 37.5, 100.0) for h in range(29)]
        df = assign_episodes(obs_frame(rows), EpisodeParams())
        self.assertEqual(len(episode_ids(df, EpisodeParams(min_observations=30))), 0)
        self.assertEqual(len(episode_ids(df, EpisodeParams(min_observations=29))), 1)


class TestAccumulate(unittest.TestCase):
    def test_a_missing_frp_is_a_detection_and_not_zero_burn(self):
        """The archive's own trap: a detection with no measured FRP stays null. The
        cell must still count the detection and keep its FRP finite - summing the raw
        NaN would poison the cell, and dropping the row would lose the detection."""
        from frames import _accumulate

        rows = [("2026-07-09T10:05:00", -6.0, 37.5, np.nan), ("2026-07-09T10:15:00", -6.0, 37.5, 50.0)]
        df = obs_frame(rows)
        g = grid_around(-6.0, 37.5, 0.02, 8)
        out = _accumulate(df, g, pd.Timestamp("2026-07-09T10:00Z"), pd.Timestamp("2026-07-09T11:00Z"))
        self.assertEqual(float(out["detections"].max()), 2.0, "both detections must be counted")
        self.assertTrue(np.isfinite(out["frp"]).all(), "a null FRP must not poison the cell")
        self.assertEqual(float(out["frp"].max()), 50.0, "only the measured FRP is summed")

    def test_detections_outside_the_window_are_not_counted(self):
        from frames import _accumulate

        rows = [("2026-07-09T09:00:00", -6.0, 37.5, 50.0), ("2026-07-09T11:00:00", -6.0, 37.5, 50.0)]
        df = obs_frame(rows)
        g = grid_around(-6.0, 37.5, 0.02, 8)
        out = _accumulate(df, g, pd.Timestamp("2026-07-09T10:00Z"), pd.Timestamp("2026-07-09T11:00Z"))
        self.assertEqual(out["detections"].sum(), 0.0, "the window is half-open [from, to)")

    def test_detections_outside_the_patch_are_dropped(self):
        from frames import _accumulate

        rows = [("2026-07-09T10:30:00", -6.0, 37.5, 50.0), ("2026-07-09T10:30:00", -20.0, 37.5, 50.0)]
        df = obs_frame(rows)
        g = grid_around(-6.0, 37.5, 0.02, 8)
        out = _accumulate(df, g, pd.Timestamp("2026-07-09T10:00Z"), pd.Timestamp("2026-07-09T11:00Z"))
        self.assertEqual(out["detections"].sum(), 1.0)

    def test_a_window_with_no_detection_in_the_patch_is_empty(self):
        from frames import _accumulate

        rows = [("2026-07-09T10:30:00", -20.0, 37.5, 50.0)]
        df = obs_frame(rows)
        g = grid_around(-6.0, 37.5, 0.02, 8)
        out = _accumulate(df, g, pd.Timestamp("2026-07-09T10:00Z"), pd.Timestamp("2026-07-09T11:00Z"))
        self.assertEqual(float(out["detections"].sum()), 0.0)
        self.assertEqual(float(out["frp"].sum()), 0.0)


class TestSamples(unittest.TestCase):
    def test_only_steps_with_a_full_history_and_label_become_samples(self):
        """A sample needs `history` before t and `horizon` after it. Producing one
        that reaches past the end of the fire would label it with nothing and call
        that a prediction the fire stopped."""
        rows = [(f"2026-07-09T{h:02d}:00:00", -6.0, 37.5, 100.0) for h in range(6)]  # a 5-hour span
        df = assign_episodes(obs_frame(rows), EpisodeParams())
        events = episode_ids(df, EpisodeParams(min_observations=1))
        p = FrameParams(step_minutes=60, horizon_hours=6, history_hours=3)
        samples = list(build_samples(df, events, p=p))
        self.assertEqual(len(samples), 0, "a 5-hour fire cannot carry a 3h+6h sample")

    def test_the_label_window_boundary_decides_the_sample_count(self):
        """The loop needs `step + horizon` of headroom, so a 20 h hourly fire yields
        exactly 10 samples and an 11 h one exactly 1. Dropping `step` from the
        condition (the stale shards' bug) changes both, and only this test pins it."""
        p = FrameParams(step_minutes=60, horizon_hours=6, history_hours=3)
        for hours, expected in ((20, 10), (11, 1)):
            rows = [(f"2026-07-09T{h:02d}:00:00", -6.0, 37.5, 100.0) for h in range(hours)]
            df = assign_episodes(obs_frame(rows), EpisodeParams())
            events = episode_ids(df, EpisodeParams(min_observations=1))
            samples = list(build_samples(df, events, p=p))
            self.assertEqual(len(samples), expected, f"a {hours} h fire")
        # The last sample starts exactly step+horizon before the fire ends.
        self.assertEqual(samples[-1]["t"], df["t"].max() - pd.Timedelta(hours=7))

    def test_a_one_observation_event_yields_nothing(self):
        rows = [("2026-07-09T10:00:00", -6.0, 37.5, 100.0)]
        df = assign_episodes(obs_frame(rows), EpisodeParams(min_samples=1))
        events = episode_ids(df, EpisodeParams(min_samples=1, min_observations=1))
        self.assertEqual(list(build_samples(df, events, p=FrameParams())), [])

    def test_a_step_with_no_detection_is_skipped(self):
        """A gap shorter than `gap_hours` stays one episode, but a step whose whole
        history and current window are empty is skipped, not emitted as zeros."""
        rows = [(f"2026-07-09T{h:02d}:00:00", -6.0, 37.5, 100.0) for h in range(4)]
        rows += [(f"2026-07-09T{h:02d}:00:00", -6.0, 37.5, 100.0) for h in range(8, 21)]
        df = assign_episodes(obs_frame(rows), EpisodeParams(gap_hours=6.0))
        events = episode_ids(df, EpisodeParams(min_observations=1))
        p = FrameParams(step_minutes=60, horizon_hours=6, history_hours=3)
        samples = list(build_samples(df, events, p=p))
        # t runs 3..13 (11 steps); t=7 has no detection in [4, 8) and is skipped.
        self.assertEqual(len(samples), 10)

    def test_a_long_enough_fire_yields_samples_and_a_label(self):
        rows = [(f"2026-07-09T{h:02d}:00:00", -6.0, 37.5, 100.0) for h in range(20)]
        df = assign_episodes(obs_frame(rows), EpisodeParams())
        events = episode_ids(df, EpisodeParams(min_observations=1))
        p = FrameParams(step_minutes=60, horizon_hours=6, history_hours=3)
        samples = list(build_samples(df, events, p=p))
        self.assertGreater(len(samples), 0)
        s = samples[0]
        # history is [t-3h, t): three hourly observations.
        self.assertEqual(s["history_detections"].sum(), 3.0, "3 hours of history at 1 hour steps")
        # the label is a full 6 hours starting after the current window.
        self.assertEqual(s["label_detections"].sum(), 6.0, "6 hours of label")
        self.assertEqual(s["current_detections"].sum(), 1.0, "the current window is one step")
        self.assertEqual(s["cell_area_km2"].shape, (128, 1))


class TestLoadHotspots(unittest.TestCase):
    def test_rows_without_a_timestamp_are_dropped_and_counted(self):
        """A blank timestamp becomes NaT, sorts to the end, then compares False
        against every window - it vanishes while still counting as an observation.
        It must be dropped at load and reported, not carried."""
        import gzip
        import os
        import tempfile

        from events import load_hotspots

        header = "observed_at_utc,LONGITUDE_PARALLAX,LATITUDE_PARALLAX,FRP,FIRE_CONFIDENCE,PIXEL_SIZE\n"
        body = ("2026-07-09T10:00:00Z,-6.0,37.5,100,0.8,1.5\n"
                ",-6.1,37.6,50,0.8,1.5\n")
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "hotspots.csv.gz")
            with gzip.open(path, "wt") as fh:
                fh.write(header + body)
            df = load_hotspots(path)
        self.assertEqual(len(df), 1)
        self.assertEqual(df.attrs["rows_dropped_no_timestamp"], 1)


class TestDriftBaseline(unittest.TestCase):
    def test_drift_carries_the_centroid_velocity_forward(self):
        """The drift baseline is the current mask shifted by the history->current
        centroid displacement, scaled by forward/history (9h/3h = 3)."""
        from ap_harness import drift_mask

        cur = np.zeros((1, 12, 12), np.float32)
        cur[0, 4, 4] = 1.0          # current centroid at row 4
        hist = np.zeros((1, 12, 12), np.float32)
        hist[0, 3, 4] = 1.0         # history centroid at row 3 -> velocity +1 row
        out = drift_mask(cur, hist)
        # +1 row/window carried over 3 windows = +3 rows: 4 -> 7
        found = np.argwhere(out[0] > 0)
        self.assertEqual(float(out[0].sum()), 1.0, "the mask must not gain or lose cells")
        self.assertEqual(tuple(int(i) for i in found[0]), (7, 4))

    def test_drift_of_an_empty_fire_is_empty(self):
        from ap_harness import drift_mask

        z = np.zeros((1, 8, 8), np.float32)
        self.assertEqual(float(drift_mask(z, z).sum()), 0.0)


if __name__ == "__main__":
    unittest.main()
