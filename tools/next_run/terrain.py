"""COG overview sampling with geographic cache keys and explicit coverage.

WorldCover is represented as land-cover categories, not an invented fuel ordinal.
DEM and WorldCover are static context; neither is a measured fuel-moisture model.
"""
from __future__ import annotations

from functools import lru_cache
from pathlib import Path
import os

import numpy as np
import rasterio
from rasterio.enums import Resampling

from .common import CLASSES


def aspect_from_gradient(dz_south,dz_east):
    # North-up rasters increase their row index SOUTH, not north.
    return np.mod(np.arctan2(-dz_east,dz_south),2*np.pi)


def tile_name(kind,lat,lon):
    ns=f"{'N' if lat>=0 else 'S'}{abs(lat):02d}"
    ew=f"{'E' if lon>=0 else 'W'}{abs(lon):03d}"
    if kind=="dem":
        base=f"Copernicus_DSM_COG_10_{ns}_00_{ew}_00_DEM"
        return base+".tif",f"https://copernicus-dem-30m.s3.eu-central-1.amazonaws.com/{base}/{base}.tif"
    name=f"ESA_WorldCover_10m_2021_v200_{ns}{ew}_Map.tif"
    return name,f"https://esa-worldcover.s3.eu-central-1.amazonaws.com/v200/2021/map/{name}"


class Terrain:
    def __init__(self,cache,existing=None,allow_remote=True):
        self.cache=Path(cache);self.cache.mkdir(parents=True,exist_ok=True)
        self.existing=Path(existing) if existing else None
        self.allow_remote=allow_remote

    @lru_cache(maxsize=128)
    def tile(self,kind,lat,lon):
        name,url=tile_name(kind,lat,lon)
        cache=self.cache/(name+".npz")
        if cache.exists():
            with np.load(cache) as d:return d["data"],d["meta"]
        local=self.existing/kind/name if self.existing else None
        source=str(local) if local and local.exists() else url
        if source==url and not self.allow_remote:raise ValueError(f"Static tile missing: {name}")
        # Reading the COG overview avoids downloading the full 10m/30m tile.
        with rasterio.Env(GDAL_DISABLE_READDIR_ON_OPEN="EMPTY_DIR",CPL_VSIL_CURL_ALLOWED_EXTENSIONS=".tif",
                          GDAL_HTTP_TIMEOUT="30",GDAL_HTTP_MAX_RETRY="2"):
            try:
                with rasterio.open(source) as src:
                    n=180 if kind=="dem" else 300
                    data=src.read(1,out_shape=(n,n),resampling=Resampling.average if kind=="dem" else Resampling.nearest,
                                  masked=True).astype(np.float32).filled(np.nan)
                    b=src.bounds;meta=np.array([b.left,b.bottom,b.right,b.top])
            except rasterio.errors.RasterioIOError as e:
                # Ocean tiles may not exist. Network failures are not water.
                if "404" not in str(e):raise
                n=180 if kind=="dem" else 300;size=1 if kind=="dem" else 3
                data=np.full((n,n),np.nan,np.float32);meta=np.array([lon,lat,lon+size,lat+size])
        tmp=cache.with_suffix(f".{os.getpid()}.partial.npz");np.savez_compressed(tmp,data=data,meta=meta);tmp.replace(cache)
        return data,meta

    def sample(self,lon,lat):
        shape=lon.shape
        dem=np.full(shape,np.nan,np.float32);wc=dem.copy()
        for kind,target,size in [("dem",dem,1),("wc",wc,3)]:
            rows=np.floor(lat/size).astype(int)*size;cols=np.floor(lon/size).astype(int)*size
            for la,lo in sorted(set(zip(rows.ravel(),cols.ravel()))):
                inside=(rows==la)&(cols==lo)
                data,(west,south,east,north)=self.tile(kind,int(la),int(lo))
                r=np.floor((north-lat[inside])/(north-south)*len(data)).astype(int)
                c=np.floor((lon[inside]-west)/(east-west)*data.shape[1]).astype(int)
                good=(r>=0)&(r<data.shape[0])&(c>=0)&(c<data.shape[1])
                values=np.full(r.shape,np.nan,np.float32);values[good]=data[r[good],c[good]]
                target[inside]=values
        # Distances between neighbouring native-grid pixel centres on the ground.
        north_r,north_c=np.gradient(lat*110540)
        lon_r,lon_c=np.gradient(lon)
        east_r=lon_r*111320*np.cos(np.radians(lat));east_c=lon_c*111320*np.cos(np.radians(lat))
        dz_r,dz_c=np.gradient(dem)
        det=north_r*east_c-east_r*north_c
        north=(dz_r*east_c-dz_c*east_r)/det
        east=(north_r*dz_c-north_c*dz_r)/det
        slope=np.arctan(np.hypot(north,east));aspect=aspect_from_gradient(-north,east)
        valid=np.isfinite(dem)&np.isfinite(slope)&np.isin(wc,CLASSES)
        channels=[dem/3000,slope,np.sin(aspect),np.cos(aspect),valid.astype(float)]
        channels += [(wc==code).astype(float) for code in CLASSES]
        x=np.stack(channels).astype(np.float32)
        return np.where(np.isfinite(x),x,0),valid
