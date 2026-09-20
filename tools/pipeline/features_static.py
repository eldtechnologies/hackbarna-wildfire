"""Build coarse terrain (slope/aspect) and fuel (land-cover) rasters over Iberia.

One mosaic each, at 0.005 deg (~500 m), covering the union of every sample grid.
`ap_harness.py` samples these at the sample cell centres, so the sample builder never
touches the 30 m tiles again.

Reads tiles from `tools/pipeline/tiles/dem/*.tif` (Copernicus DEM GLO-30, m) and
`tools/pipeline/tiles/wc/*.tif` (ESA WorldCover, class codes) and writes
`data/wildfire-spread/static_coarse.npz`. Neither tile directory is committed; see
`docs/growth-baselines-AP.md` for their sources.

Slope is computed from the DEM with numpy.gradient using true metre spacing, so a
steep sierra reads as steep. Aspect is the compass direction the slope faces
(0 = north, 90 = east).
"""
from __future__ import annotations

import glob
from pathlib import Path

import numpy as np
import rasterio
from rasterio.transform import from_origin
from rasterio.warp import reproject, Resampling

HERE = Path(__file__).resolve().parent
DATA = HERE.parent.parent / "data" / "wildfire-spread"
DEM_TILES = HERE / "tiles" / "dem" / "*.tif"
WC_TILES = HERE / "tiles" / "wc" / "*.tif"

RES = 0.005
LON0, LON1 = -11.0, 6.0
LAT0, LAT1 = 34.0, 45.0  # LAT0 = south


def mosaic(files, resampling, shape, transform):
    """Warp every tile into the coarse grid; later tiles fill only empty cells."""
    out = np.full(shape, np.nan, dtype=np.float32)
    for f in files:
        with rasterio.open(f) as src:
            tmp = np.full(shape, np.nan, dtype=np.float32)
            reproject(
                source=rasterio.band(src, 1),
                destination=tmp,
                dst_transform=transform,
                dst_crs=src.crs,
                resampling=resampling,
                dst_nodata=np.nan,
            )
            fill = np.isnan(out) & ~np.isnan(tmp)
            out[fill] = tmp[fill]
    return out


def main() -> int:
    W = int(round((LON1 - LON0) / RES))
    H = int(round((LAT1 - LAT0) / RES))
    transform = from_origin(LON0, LAT1, RES, RES)  # top-left origin (north-up)
    print(f"coarse grid {H} x {W} at {RES} deg")

    dem_files = sorted(glob.glob(str(DEM_TILES)))
    if not dem_files:
        raise SystemExit(f"no DEM tiles at {DEM_TILES}; see docs/growth-baselines-AP.md")
    dem = mosaic(dem_files, Resampling.bilinear, (H, W), transform)
    valid = float(np.isfinite(dem).mean())
    print(f"  DEM valid: {valid * 100:.1f}%")
    if valid == 0.0:
        # An all-NaN mosaic trains silently on missing terrain, so refuse to write it.
        raise SystemExit("DEM mosaic has 0% valid cells; refusing to write static_coarse.npz")

    # Slope/aspect from the coarse DEM in true metres.
    km_lat = RES * 110.54
    lat_centres = LAT1 - (np.arange(H) + 0.5) * RES
    km_lon = RES * 111.32 * np.cos(np.radians(lat_centres))
    dz_dy, dz_dx = np.gradient(dem)                    # per-row (north) and per-col (east)
    dz_dy = dz_dy / (km_lat * 1000.0)
    dz_dx = dz_dx / (km_lon[:, None] * 1000.0)
    slope = np.degrees(np.arctan(np.hypot(dz_dx, dz_dy)))
    # Aspect: compass bearing of the downslope direction.
    aspect = (np.degrees(np.arctan2(dz_dx, dz_dy)) + 180.0) % 360.0
    slope[~np.isfinite(dem)] = np.nan
    aspect[~np.isfinite(dem)] = np.nan

    wc_files = sorted(glob.glob(str(WC_TILES)))
    if not wc_files:
        raise SystemExit(f"no WorldCover tiles at {WC_TILES}; see docs/growth-baselines-AP.md")
    print("mosaicking WorldCover ...")
    wc = mosaic(wc_files, Resampling.nearest, (H, W), transform)
    print(f"  WC valid: {np.isfinite(wc).mean() * 100:.1f}%  classes: "
          f"{sorted(set(wc[np.isfinite(wc)].astype(int).tolist()))[:15]}")

    DATA.mkdir(parents=True, exist_ok=True)
    out_path = DATA / "static_coarse.npz"
    np.savez_compressed(
        out_path,
        dem=dem.astype(np.float32),
        slope=slope.astype(np.float32),
        aspect=aspect.astype(np.float32),
        wc=wc.astype(np.float32),
        meta=np.array([LON0, LAT1, RES, H, W], dtype=np.float64),
    )
    print(f"wrote {out_path}")
    print(f"slope p50={np.nanpercentile(slope, 50):.1f} p90={np.nanpercentile(slope, 90):.1f} "
          f"max={np.nanmax(slope):.1f} deg")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
