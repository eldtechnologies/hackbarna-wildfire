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
        rows = []
        for i in range(5):
            rows.append((f"2026-07-09T1{i}:00", -6.0, 37.5, 100.0))
            rows.append((f"2026-07-09T1{i}:00", -3.0, 41.0, 100.0))
        df = assign_episodes(obs_frame(rows), EpisodeParams())
        self.assertEqual(len(set(df[df.cluster >= 0].cluster)), 2, "5 km apart means separate fires")

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


class TestAccumulate(unittest.TestCase):
    def test_a_missing_frp_is_a_detection_and_not_zero_burn(self):
        """The archive's own trap: a detection with no measured FRP stays null. If it
        were summed as zero the cell would look unburnt while a sensor is looking at
        fire in it."""
        from frames import _accumulate

        rows = [("2026-07-09T10:05:00", -6.0, 37.5, np.nan), ("2026-07-09T10:15:00", -6.0, 37.5, 50.0)]
        df = obs_frame(rows)
        g = grid_around(-6.0, 37.5, 0.02, 8)
        out = _accumulate(df, g, pd.Timestamp("2026-07-09T10:00Z"), pd.Timestamp("2026-07-09T11:00Z"))
        self.assertEqual(out["frp"].sum(), 50.0, "the null FRP must not be added as zero")
        self.assertEqual(out["detections"].sum(), 2.0, "both detections must still be counted")

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


class TestSamples(unittest.TestCase):
    def test_only_steps_with_a_full_history_and_label_become_samples(self):
        """A sample needs `history` before t and `horizon` after it. Producing one
        that reaches past the end of the fire would label it with nothing and call
        that a prediction the fire stopped."""
        rows = [(f"2026-07-09T{h:02d}:00:00", -6.0, 37.5, 100.0) for h in range(6)]
        rows += []  # 6 hourly observations, a 5-hour span
        df = assign_episodes(obs_frame(rows), EpisodeParams())
        events = episode_ids(df, EpisodeParams(min_observations=1))
        p = FrameParams(step_minutes=60, horizon_hours=6, history_hours=3)
        samples = list(build_samples(df, events, p=p))
        self.assertEqual(len(samples), 0, "a 5-hour fire cannot carry a 3h+6h sample")

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


if __name__ == "__main__":
    unittest.main()
