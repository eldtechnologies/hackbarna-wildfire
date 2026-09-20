"""Coordinate/time/model-keyed forecast cache, never keyed by a transient event ID.

Use a 24h-lead archived forecast rather than retrospectively observed POWER wind.
Provider describes previous_day1 as a prediction 24h before valid time. A 6h
publication allowance is conservative for this 1/3/6h task; actual delivery is not
reconstructed. Cache records this assumption explicitly.
"""
from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor
import json
from pathlib import Path
import time
import threading

import numpy as np
import pandas as pd
import requests

from .common import digest, write_json

MODEL = "ecmwf_ifs025"
VARIABLES = ["wind_speed_10m", "wind_direction_10m", "temperature_2m",
             "relative_humidity_2m", "precipitation"]
URL = "https://previous-runs-api.open-meteo.com/v1/forecast"
RATE_LOCK=threading.Lock()
NEXT_REQUEST=0.0


def throttle():
    global NEXT_REQUEST
    with RATE_LOCK:
        delay=max(0,NEXT_REQUEST-time.monotonic())
        if delay:time.sleep(delay)
        NEXT_REQUEST=time.monotonic()+0.35


def location(lon, lat):
    return round(float(lon)*4)/4, round(float(lat)*4)/4


def cache_key(lon, lat, start, end):
    return digest(["previous_day1-v1", MODEL, *location(lon, lat), str(start), str(end), VARIABLES])


def clean_values(v):
    v = np.asarray(v, dtype=float)
    valid = np.isfinite(v)
    # Missing sentinels and impossible physical ranges must not become values.
    low = np.array([0, 0, -90, 0, 0])
    high = np.array([120, 360, 65, 100, 1000])
    valid &= (v >= low) & (v <= high)
    return np.where(valid, v, 0).astype(np.float32), valid.astype(np.float32)


def fetch_one(args):
    lon, lat, start, end, cache = args
    lon, lat = location(lon, lat)
    key = cache_key(lon, lat, start, end)
    path = Path(cache) / f"{key}.json"
    if path.exists():
        record = json.loads(path.read_text())
        if record["key"] != key:
            raise ValueError("Weather cache identity mismatch")
        return key, path.name
    params = dict(longitude=lon, latitude=lat, start_date=start, end_date=end,
                  hourly=",".join(v+"_previous_day1" for v in VARIABLES),
                  models=MODEL, timezone="UTC", wind_speed_unit="ms")
    for attempt in range(7):
        throttle()
        try:
            response = requests.get(URL, params=params, timeout=45)
        except (requests.Timeout,requests.ConnectionError):
            if attempt==6:raise
            time.sleep(min(30,2**attempt))
            continue
        if response.status_code == 200:
            break
        if response.status_code not in (429, 500, 502, 503, 504):
            response.raise_for_status()
        if "daily" in response.text.lower():response.raise_for_status()
        retry_after=response.headers.get("Retry-After","")
        delay=float(retry_after) if retry_after.isdigit() else min(30,2**attempt)
        if delay>60:raise RuntimeError(f"Provider requests {delay}s backoff; resume later")
        if attempt<6:time.sleep(delay)
    response.raise_for_status()
    raw = response.json()
    if raw.get("utc_offset_seconds") != 0:
        raise ValueError("Weather timezone is not UTC")
    h = raw["hourly"]
    rows = {t+"Z": [h[v+"_previous_day1"][i] for v in VARIABLES] for i,t in enumerate(h["time"])}
    record = dict(key=key, requested_lon=lon, requested_lat=lat, model=MODEL,
                  returned_lon=raw["longitude"], returned_lat=raw["latitude"],
                  variables=VARIABLES, lead_hours=24, publication_allowance_hours=6,
                  source=URL, mode="archived_fixed_lead_forecast", rows=rows,
                  fetched_at=str(pd.Timestamp.now(tz="UTC")))
    write_json(path, record)
    return key, path.name


class Weather:
    def __init__(self, root):
        self.root = Path(root)
        self.index = json.loads((self.root/"index.json").read_text())
        self.loaded = {}

    def at(self, lon, lat, issue, valid):
        values,mask=self.features(lon,lat,issue,valid)
        if not mask.all():raise ValueError(f"Invalid/missing weather values at {valid} for {location(lon,lat)}")
        return values

    def features(self, lon, lat, issue, valid):
        lo, la = location(lon, lat)
        entry = self.index["locations"].get(f"{lo},{la}")
        if entry is None:
            raise ValueError(f"No weather cache for location {(lo,la)}")
        if entry not in self.loaded:
            r = json.loads((self.root/entry).read_text())
            if (r["requested_lon"],r["requested_lat"]) != (lo,la) or r["model"] != MODEL:
                raise ValueError("Weather geography/model mismatch")
            self.loaded[entry] = r
        r = self.loaded[entry]
        valid = pd.Timestamp(valid).floor("h")
        if valid - pd.Timedelta(hours=r["lead_hours"]-r["publication_allowance_hours"]) > pd.Timestamp(issue):
            raise ValueError("Weather was not available at forecast issue time")
        key = valid.strftime("%Y-%m-%dT%H:%MZ")
        if key not in r["rows"]:
            raise ValueError(f"Missing weather hour {key} for {(lo,la)}")
        values, mask = clean_values(r["rows"][key])
        speed, direction, temp, rh, rain = values
        rad = np.radians(direction)
        # Meteorological FROM bearing -> east/north velocity components.
        output=np.array([-speed*np.sin(rad), -speed*np.cos(rad), temp, rh, rain], dtype=np.float32)
        output_mask=np.array([mask[0]*mask[1],mask[0]*mask[1],*mask[2:]],dtype=np.float32)
        return output*output_mask,output_mask


def main():
    ap=argparse.ArgumentParser()
    ap.add_argument("--events",type=Path,required=True)
    ap.add_argument("--out",type=Path,required=True)
    ap.add_argument("--workers",type=int,default=3)
    a=ap.parse_args(); a.out.mkdir(parents=True,exist_ok=True)
    events=pd.read_parquet(a.events)
    events=events[events.split!="reserved"].copy()
    events["loc"]=[location(r.lon,r.lat) for r in events.itertuples()]
    jobs=[]
    for (lo,la),g in events.groupby("loc"):
        start=(pd.to_datetime(g.start,utc=True).min()-pd.Timedelta(days=1)).strftime("%Y-%m-%d")
        end=(pd.to_datetime(g.sample_end,utc=True).max()+pd.Timedelta(days=1)).strftime("%Y-%m-%d")
        jobs.append((lo,la,start,end,str(a.out)))
    index={"locations":{},"model":MODEL,"variables":VARIABLES,"mode":"archived_fixed_lead_forecast"}
    with ThreadPoolExecutor(max_workers=a.workers) as pool:
        for i,(job,result) in enumerate(zip(jobs,pool.map(fetch_one,jobs))):
            lo,la=job[:2]; index["locations"][f"{lo},{la}"]=result[1]
            if (i+1)%20==0:
                write_json(a.out/"index.partial.json",index)
                print(f"weather locations={i+1}/{len(jobs)}",flush=True)
    write_json(a.out/"index.json",index)
    print(f"weather complete: {len(jobs)} locations",flush=True)


if __name__=="__main__": main()
