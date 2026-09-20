"""Native FCI geometry and quality labels, with explicit unknown observations."""
from __future__ import annotations

from functools import lru_cache
from pathlib import Path

import h5py
import numpy as np
import pandas as pd
from pyproj import Proj
from .common import LATENCY_MINUTES

GEOS = Proj(proj="geos", h=35786400, lon_0=0, a=6378137, b=6356752.31414, sweep="y")


def lonlat(row0, col0, size=64):
    rr,cc=np.mgrid[row0:row0+size,col0:col0+size]
    return GEOS((cc-5567.5)*1000,(5567.5-rr)*1000,inverse=True)


def labels(flags, persistent=None):
    """Positive=observed thermal detection; negative=every scheduled scan clear.

    No scan, cloud, bad background, unprocessed, water and unknown codes are not
    no-fire observations. A positive is usable even if other scans are cloudy.
    """
    fire=np.isin(flags,[1,2]).any(axis=0)
    clear=(flags==0).all(axis=0)
    mask=fire|clear
    if persistent is not None:
        mask &= ~persistent
    return fire.astype(np.float32),mask


class Quality:
    def __init__(self, archive, latency_minutes=LATENCY_MINUTES):
        self.archive=Path(archive)
        self.latency_minutes=latency_minutes
        self.files={}
        for path in sorted(self.archive.glob("*/*/*.nc")):
            stamp=path.stem[-12:]
            if not stamp.isdigit():continue
            if stamp in self.files:raise ValueError(f"Ambiguous quality product {stamp}")
            self.files[stamp]=path

    @lru_cache(maxsize=65536)
    def availability(self, stamp):
        t=pd.Timestamp(stamp)
        path=self.files.get(t.strftime("%Y%m%d%H%M"))
        if path is None:return None
        with h5py.File(path,"r") as f:
            created=f.attrs.get("date_created")
        if created is None:return None  # Old products lack creation metadata: no causal input claim.
        if isinstance(created,bytes):created=created.decode()
        created=pd.Timestamp(str(created))
        if created.tzinfo is None:raise ValueError("Creation time lacks timezone")
        return max(created,t+pd.Timedelta(minutes=self.latency_minutes))

    @lru_cache(maxsize=2048)
    def patch(self, stamp, row0, col0, size=64):
        t=pd.Timestamp(stamp)
        suffix=t.strftime("%Y%m%d%H%M")
        path=self.files.get(suffix)
        q=np.full((size,size),255,dtype=np.uint8)
        if path is None: return q,None
        with h5py.File(path,"r") as f:
            ds=f["QualityProduct/qualityflag"] if "QualityProduct/qualityflag" in f else f["qualityflag"]
            if ds.shape!=(11136,11136): raise ValueError("Unexpected quality grid")
            r0,c0=max(row0,0),max(col0,0);r1,c1=min(row0+size,11136),min(col0+size,11136)
            if r1>r0 and c1>c0:q[r0-row0:r1-row0,c0-col0:c1-col0]=ds[r0:r1,c0:c1]
        # Explicit retrospective latency assumption; creation time is only a lower
        # bound on publication. Never feed an observation before it existed.
        available=self.availability(str(t))
        return q,available

    def sequence(self,start,end,row0,col0,size=64,available_by=None):
        scans=pd.date_range(pd.Timestamp(start),pd.Timestamp(end),freq="10min",inclusive="left")
        out=[]
        for t in scans:
            q,available=self.patch(str(t),row0,col0,size)
            if available_by is not None and (available is None or available>available_by):
                q=np.full((size,size),255,np.uint8)
            out.append(q)
        return np.stack(out) if out else np.empty((0,size,size),np.uint8)
