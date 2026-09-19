"""Regression tests for the scoring harness. Run with:

    uv run --with geopandas --with pandas python -m unittest test_harness -v

These are here because of a defect that shipped and hid: the MedEU corpus is in a
projected CRS, and its metre coordinates were fed to a haversine that expects
degrees. The area scores were unaffected (they come from the attribute table), so
every test written against the area target passed while the rate was wrong by about
four orders of magnitude.
"""

import sys
import unittest
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent))
from harness import bearing_deg, haversine_km, load_medeu  # noqa: E402


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
        self.tmp = Path("/tmp/medeu-crs-test")
        self.tmp.mkdir(exist_ok=True)

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


if __name__ == "__main__":
    unittest.main()
