"""One past-only feature implementation for training and inference. No labels are read."""
from __future__ import annotations
import numpy as np
import pandas as pd
from .common import SIZE, CHANNELS, HORIZONS
from .quality import lonlat

def update_observed_state(state, flags):
    for q in flags:
        state=np.where(np.isin(q,[0,1,2]),np.isin(q,[1,2]),state)
    return state.astype(np.float32)


def observed_offsets(fire,lon,lat):
    total=fire.sum()
    if total<=0:return np.zeros((4,*fire.shape),np.float32)
    center_lon=float((fire*lon).sum()/total);center_lat=float((fire*lat).sum()/total)
    east=(lon-center_lon)*111.32*np.cos(np.radians(lat))/50
    north=(lat-center_lat)*110.54/50
    return np.stack([east,north,np.hypot(east,north),np.ones_like(east)]).astype(np.float32)


class InputFrame:
    def __init__(self, event, quality, weather, terrain, observations):
        self.event=event; self.quality=quality; self.weather=weather
        self.row0=int(event["seed_row"])-SIZE//2; self.col0=int(event["seed_col"])-SIZE//2
        self.longitude,self.latitude=lonlat(self.row0,self.col0,SIZE)
        self.static,self.static_valid=terrain.sample(self.longitude,self.latitude)
        self.obs=observations[observations.ABS_LINE.between(self.row0,self.row0+SIZE-1) & observations.ABS_SAMP.between(self.col0,self.col0+SIZE-1)]

    def at(self, issue):
        issue=pd.Timestamp(issue)
        if issue.tzinfo is None:raise ValueError("Issue time must include timezone")
        issue=issue.tz_convert('UTC')
        if issue != issue.floor("h"):raise ValueError("v1 inputs require an hourly issue time")
        available=self.quality.availability(self.event["seed_scan_time"])
        if available is None or available>issue:raise ValueError("Seed not available at issue time")
        bins=[];recent_fire=np.zeros((SIZE,SIZE),np.float32)
        for b in range(6):
            start=issue-pd.Timedelta(minutes=(6-b)*30);end=start+pd.Timedelta(minutes=30)
            flags=self.quality.sequence(start,end,self.row0,self.col0,SIZE,available_by=issue)
            fire=np.isin(flags,[1,2]).mean(axis=0).astype(np.float32)
            observable=np.isin(flags,[0,1,2]).mean(axis=0).astype(np.float32)
            frp=np.zeros((SIZE,SIZE),np.float32);measured=frp.copy()
            d=self.obs[(self.obs.observed_at>=start)&(self.obs.observed_at<end)&self.obs.FRP.notna()]
            # Creation timestamp as well as conservative latency must pass.
            for scan,g in d.groupby("scan_time"):
                _,available=self.quality.patch(str(scan),self.row0,self.col0,SIZE)
                if available is None or available>issue:continue
                rr=g.ABS_LINE.to_numpy()-self.row0;cc=g.ABS_SAMP.to_numpy()-self.col0
                np.add.at(frp,(rr,cc),g.FRP.to_numpy(dtype=np.float32))
                np.add.at(measured,(rr,cc),1)
            bins.extend([np.log1p(frp/3)/5,fire,observable,measured/3])
            # Last observed state, retaining older observations through clouds.
            recent_fire=update_observed_state(recent_fire,flags)
        dynamic=np.stack(bins).astype(np.float32)
        weather=[]
        for h in [0,*HORIZONS]:
            v,valid=self.weather.features(self.event["lon"],self.event["lat"],issue,issue+pd.Timedelta(hours=h))
            v=v/np.array([20,20,50,100,10],np.float32)
            weather.extend(np.full((SIZE,SIZE),z,np.float32) for z in np.r_[v,valid])
        offsets=observed_offsets(recent_fire,self.longitude,self.latitude)
        phase=2*np.pi*(issue.hour+issue.minute/60)/24
        x=np.concatenate([dynamic,self.static,np.stack(weather),offsets,
                          np.full((1,SIZE,SIZE),np.sin(phase)),np.full((1,SIZE,SIZE),np.cos(phase))]).astype(np.float32)
        if x.shape[0]!=len(CHANNELS) or not np.isfinite(x).all():
            raise ValueError(f"Invalid input tensor: {self.event['event_id']} {issue}")
        x=x.astype(np.float16)
        if not np.isfinite(x).all():raise ValueError("float16 overflow")
        return x,recent_fire.astype(np.float16)
