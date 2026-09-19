"""Regression tests for the scoring harness. Run with:

    uv run --with geopandas --with pandas --with scikit-learn python -m unittest test_harness -v

These are here because of a defect that shipped and hid: the MedEU corpus is in a
projected CRS, and its metre coordinates were fed to a haversine that expects
degrees. The area scores were unaffected (they come from the attribute table), so
every test written against the area target passed while the rate was wrong by about
four orders of magnitude.
"""

import json
import shutil
import sys
import tempfile
import unittest
import unittest.mock
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import harness  # noqa: E402
from harness import (  # noqa: E402
    MAX_GAP_HOURS,
    State,
    bearing_deg,
    haversine_km,
    load_medeu,
    score_corpus,
    score_model,
)

DATA = Path(__file__).resolve().parents[2] / "data" / "model"


def synthetic_medeu(path: Path, crs: str) -> None:
    """A three-step fire whose perimeter centre moves north by a known distance.

    Written in `crs`, so the same ground truth can be presented in degrees or in
    projected metres. The stored coordinates differ; the real distance does not.
    """
    import geopandas as gpd
    from shapely.geometry import Polygon

    def box(south: float) -> Polygon:
        return Polygon([(-2.0, south), (-1.99, south), (-1.99, south + 0.01), (-2.0, south + 0.01)])

    gdf = gpd.GeoDataFrame(
        [
            {
                "EFFIS_id": 1,
                "Acqu_date": f"2026-07-0{i + 1}",
                "Acqu_time": "12:00:00",
                "BA (ha)": 100.0 * (i + 1),
                "geometry": box(36.99 + 0.01 * i),
            }
            for i in range(3)
        ],
        crs=4326,
    )
    gdf.to_crs(crs).to_file(path)


class TestGeometry(unittest.TestCase):
    def test_haversine_matches_a_known_ground_distance(self):
        # 0.01 degrees of latitude is 1.110 km.
        d = haversine_km((-2.0, 37.00), (-2.0, 37.01))
        self.assertAlmostEqual(d, 1.110, places=2)

    def test_bearing_is_degrees_clockwise_from_north(self):
        self.assertAlmostEqual(bearing_deg((-2.0, 37.0), (-2.0, 37.01)), 0.0, places=3)
        self.assertAlmostEqual(bearing_deg((-2.0, 37.0), (-1.99, 37.0)), 90.0, places=1)


class TestMedeuCrs(unittest.TestCase):
    """The defect: projected metres read as degrees."""

    def setUp(self):
        # mkdtemp, not a fixed /tmp path: a pre-planted symlink at a shared path would
        # make this write the file it points at (CWE-377).
        self.tmp = Path(tempfile.mkdtemp())

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_a_projected_file_gives_the_same_rate_as_a_geographic_one(self):
        """The same fire in EPSG:3035 and in EPSG:4326 must give the same rate.

        This is the assertion that would have caught the bug: reading metres as
        degrees made the projected file's rate about 10,000x too large.
        """
        geo = self.tmp / "geo.gpkg"
        proj = self.tmp / "proj.gpkg"
        synthetic_medeu(geo, 4326)
        synthetic_medeu(proj, 3035)

        from_geo = load_medeu(str(geo))
        from_proj = load_medeu(str(proj))

        rates_geo = [s.rate_kmh for s in from_geo if s.rate_kmh is not None]
        rates_proj = [s.rate_kmh for s in from_proj if s.rate_kmh is not None]
        self.assertTrue(rates_geo, "the geographic fixture must carry a rate")
        self.assertTrue(rates_proj, "the projected fixture must carry a rate")
        self.assertAlmostEqual(
            float(np.mean(rates_geo)),
            float(np.mean(rates_proj)),
            places=3,
            msg=f"geographic {rates_geo} vs projected {rates_proj}",
        )

    def test_the_rate_is_physically_possible_for_a_wildfire(self):
        proj = self.tmp / "proj2.gpkg"
        synthetic_medeu(proj, 3035)
        rates = [s.rate_kmh for s in load_medeu(str(proj)) if s.rate_kmh is not None]
        self.assertTrue(rates)
        # A 1.11 km move in 24 h is about 0.046 km/h. Real fires run to ~10 km/h.
        self.assertLess(max(rates), 20.0, f"a fire cannot advance at {max(rates)} km/h")

    def test_the_bearing_points_north_for_a_northward_fire(self):
        proj = self.tmp / "proj3.gpkg"
        synthetic_medeu(proj, 3035)
        bearings = [s.bearing_deg for s in load_medeu(str(proj)) if s.bearing_deg is not None]
        self.assertTrue(bearings)
        for b in bearings:
            self.assertTrue(b < 1 or b > 359, f"a northward move read as {b} degrees")


class TestFixturesReproduceMetrics(unittest.TestCase):
    """The served numbers must re-derive from the committed fixtures.

    Nothing re-derived the artifact from the fixtures, which is exactly how the
    wrong-unit rate survived every test written against the area target. Scoring the
    fixtures with the committed MAX_GAP_HOURS pins the whole document.
    """

    def _states(self, label: str) -> list[State]:
        doc = json.loads((DATA / f"fixture-{label}.json").read_text())
        return [State(**s) for s in doc["states"]]

    def test_every_non_model_row_re_derives_from_its_fixture(self):
        for row in json.loads((DATA / "metrics.json").read_text())["rows"]:
            with self.subTest(corpus=row["corpus"], gap=row["gap_filter"]):
                states = self._states(row["corpus"])
                gap = None if row["gap_filter"] == "all pairs" else MAX_GAP_HOURS
                got = score_corpus(states, row["corpus"], gap, row["rate_basis"])
                expected = {k: v for k, v in row.items() if k != "model"}
                self.assertEqual(got, expected)


class TestDegenerateCorpora(unittest.TestCase):
    def test_one_fire_does_not_publish_a_constant_ros_score(self):
        # With one fire there are no other fires to fit against, so the leave-one-out
        # rate is zero and constant-ROS collapses to persistence. That number must not
        # be published as if it were fitted.
        one = [
            State(fire="a", t=float(i), area_ha=100.0 * (i + 1), bearing_deg=0.0, rate_kmh=1.0)
            for i in range(6)
        ]
        row = score_corpus(one, "one", MAX_GAP_HOURS, "frontal")
        self.assertEqual(row["burned_area"]["constant_ros"]["computed"], False)
        self.assertNotIn("r2", row["burned_area"]["constant_ros"])

        two = one + [
            State(fire="b", t=float(i), area_ha=200.0 * (i + 1), bearing_deg=0.0, rate_kmh=2.0)
            for i in range(6)
        ]
        row2 = score_corpus(two, "two", MAX_GAP_HOURS, "frontal")
        self.assertIn("r2", row2["burned_area"]["constant_ros"])


class TestModelSmallSample(unittest.TestCase):
    def test_no_trained_fold_is_not_computed(self):
        # One fire of 25 states gives 24 pairs, but the only leave-one-fire fold has an
        # empty training split, so every prediction stays the zero placeholder. That
        # must be reported as not computed, not scored.
        states = [
            State(fire="a", t=float(i), area_ha=100.0 * (i + 1), bearing_deg=10.0, rate_kmh=0.5 + 0.1 * i)
            for i in range(25)
        ]
        self.assertEqual(score_model(states, MAX_GAP_HOURS)["computed"], False)


class TestWriteGuard(unittest.TestCase):
    """main() must never overwrite the committed artifact with a partial run."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self._out = harness.OUT
        harness.OUT = self.tmp

    def tearDown(self):
        harness.OUT = self._out
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_a_failed_corpus_writes_nothing_and_exits_nonzero(self):
        def boom() -> list[State]:
            raise RuntimeError("no data on this machine")

        with unittest.mock.patch.object(harness, "load_pt_firesprd", boom), unittest.mock.patch.object(
            harness, "load_medeu", boom
        ):
            rc = harness.main()
        self.assertEqual(rc, 1)
        self.assertEqual(list(self.tmp.iterdir()), [], "a failed run must leave no artifact")

    def test_a_nan_score_writes_nothing_and_exits_nonzero(self):
        # A constant observed column leaves R2 undefined (NaN), which is not JSON.
        # The generator must refuse rather than ship an artifact JSON.parse rejects.
        def flat() -> list[State]:
            return [
                State(fire=f"f{i % 2}", t=float(i), area_ha=100.0, bearing_deg=0.0, rate_kmh=1.0)
                for i in range(4)
            ]

        with unittest.mock.patch.object(harness, "load_pt_firesprd", flat), unittest.mock.patch.object(
            harness, "load_medeu", flat
        ), unittest.mock.patch.object(
            harness, "score_model", lambda *a, **k: {"computed": False, "reason": "stubbed"}
        ):
            rc = harness.main()
        self.assertEqual(rc, 1)
        self.assertEqual(list(self.tmp.iterdir()), [], "a NaN run must leave no artifact")

    def test_a_full_run_writes_both_fixtures_and_the_metrics(self):
        def states() -> list[State]:
            return [
                State(
                    fire=f"f{i % 4}",
                    t=float(i),
                    area_ha=100.0 * (i + 1) + 3.0 * i,
                    bearing_deg=5.0 + i,
                    rate_kmh=0.5 + 0.1 * i,
                )
                for i in range(12)
            ]

        stubbed = {"computed": False, "reason": "stubbed"}
        with unittest.mock.patch.object(
            harness, "load_pt_firesprd", states
        ), unittest.mock.patch.object(harness, "load_medeu", states), unittest.mock.patch.object(
            harness, "score_model", lambda *a, **k: stubbed
        ):
            rc = harness.main()
        self.assertEqual(rc, 0)
        self.assertEqual(
            sorted(p.name for p in self.tmp.iterdir()),
            ["fixture-FireSpread_MedEU.json", "fixture-PT-FireSprd.json", "metrics.json"],
        )
        # The served format is the provenance wrapper and the server reads `.rows`; a
        # bare array here would ship an artifact neither it nor this suite can read.
        metrics = json.loads((self.tmp / "metrics.json").read_text())
        self.assertEqual(metrics["generator"], harness.GENERATOR)
        self.assertEqual({r["corpus"] for r in metrics["rows"]}, {"PT-FireSprd", "FireSpread_MedEU"})
        fixture = json.loads((self.tmp / "fixture-PT-FireSprd.json").read_text())
        self.assertEqual(fixture["generator"], harness.GENERATOR)
        self.assertTrue(fixture["states"], "the fixture must carry the extracted series")


if __name__ == "__main__":
    unittest.main()
