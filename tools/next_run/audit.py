"""Fail-closed data preflight and materialized-tensor audit; never score a model."""
from __future__ import annotations

import argparse
from collections import Counter
from itertools import combinations
import json
from pathlib import Path

import numpy as np
import pandas as pd

from .build import issue_times, verify_event
from .common import CHANNELS, HORIZONS, SIZE, file_hash, write_json
from .quality import Quality
from .weather import Weather


def separation(events):
    active=events[events.role!="reserved"]
    roles=sorted(active.role.unique())
    checks={}
    for left,right in combinations(roles,2):
        a=active[active.role==left];b=active[active.role==right]
        if set(a.spatial_group)&set(b.spatial_group):raise ValueError(f"Shared geography: {left}/{right}")
        ref=b[["seed_row","seed_col"]].to_numpy()
        overlaps=sum(bool(((np.abs(ref[:,0]-r.seed_row)<SIZE)&(np.abs(ref[:,1]-r.seed_col)<SIZE)).any())
                     for r in a.itertuples())
        checks[f"{left}/{right}"]=overlaps
        if overlaps:raise ValueError(f"Overlapping patches: {left}/{right}")
    return checks


def preflight(extract,catalogue,weather,out,max_samples=48):
    extraction=json.loads((extract/"extraction.json").read_text())
    events=pd.read_parquet(catalogue/"events.parquet")
    overlap=separation(events)
    q=Quality(extraction["archive"]);w=Weather(weather)
    archive_end=max(pd.to_datetime(Path(f["path"]).name[-19:-7],format="%Y%m%d%H%M",utc=True)
                    for f in extraction["files"])+pd.Timedelta(minutes=10)
    skipped=Counter();counts=Counter();samples=Counter();errors=[];delays=[];wind=[];plan=[]
    weather_valid=np.zeros(5,dtype=np.int64);weather_joins=0;all_missing=0
    for e in events[events.role!="reserved"].itertuples():
        available=q.availability(e.seed_scan_time)
        if available is None:skipped["seed_availability_unknown"]+=1;continue
        delays.append((available-pd.Timestamp(e.start)).total_seconds()/3600)
        issues=issue_times(e.start,e.end,archive_end,max_samples,available)
        if not len(issues):skipped["seed_unavailable_or_no_future_window"]+=1;continue
        if e.role!="test" and issues[-1]+pd.Timedelta(hours=max(HORIZONS))>pd.Timestamp("2026-08-01T00:00Z"):
            raise ValueError("Training/validation labels cross the temporal cutoff")
        if e.role=="test" and issues[0]<pd.Timestamp("2026-08-01T00:00Z"):
            raise ValueError("Test starts before cutoff")
        counts[e.role]+=1;samples[e.role]+=len(issues)
        for t in issues:
            for h in [0,*HORIZONS]:
                try:
                    v,mask=w.features(e.lon,e.lat,t,t+pd.Timedelta(hours=h))
                    weather_valid+=mask.astype(np.int64);weather_joins+=1
                    all_missing+=int(not mask.any())
                    if mask[:2].all():wind.append(float(np.hypot(v[0],v[1])))
                except ValueError as exc:
                    errors.append(dict(event=e.event_id,issue=str(t),horizon=h,error=str(exc)))
        plan.append(dict(event_id=e.event_id,role=e.role,first_issue=str(issues[0]),last_issue=str(issues[-1]),
                         seed_available=str(available),samples=len(issues)))
    report=dict(status="passed" if not errors else "failed",extraction_rows=extraction["selected_rows"],
                native_scans=extraction["scan_count"],aggregate_exports=extraction["aggregate_exports_included"],
                invalid_timestamps=extraction["invalid_times"],catalogue_events=len(events),
                usable_events=dict(counts),planned_samples=dict(samples),skipped=dict(skipped),
                cross_role_patch_overlaps=overlap,weather_joins=weather_joins,weather_join_errors=len(errors),
                weather_all_variables_missing=all_missing,
                weather_valid_values=dict(zip(["wind_east","wind_north","temperature","humidity","precipitation"],weather_valid.tolist())),
                weather_wind_speed_quantiles=np.quantile(wind,[0,.5,.95,1]).tolist() if wind else [],
                seed_available_delay_hours_quantiles=np.quantile(delays,[0,.5,.95,1]).tolist() if delays else [],
                caveats=["Creation timestamps plus 45-minute latency are a retrospective availability assumption, not delivery logs.",
                         "Forecast availability uses a 24-hour lead and a six-hour publication allowance, not delivery logs.",
                         "These are satellite thermal observations, not independently verified wildfire perimeters."],
                errors=errors[:100],plan=plan)
    write_json(out,report)
    print({k:v for k,v in report.items() if k not in ["errors","plan","caveats"]},flush=True)
    if errors:raise ValueError(f"{len(errors)} weather joins failed; inspect {out}")


def tensors(data,out):
    manifest=json.loads((data/"manifest.json").read_text());total=0;empty=np.zeros(len(HORIZONS),int)
    finite_count=0;role_counts=Counter()
    events=[e for e in manifest["events"] if e["samples"]]
    overlaps=separation(pd.DataFrame(events))
    for e in events:
        verify_event(data,e,manifest["dataset_id"])
        arrays={k:np.load(data/e["file"]/f"{k}.npy",mmap_mode="r",allow_pickle=False) for k in ["X","Y","M","P","issue"]}
        n=e["samples"];x,y,m,p,t=[arrays[k] for k in ["X","Y","M","P","issue"]]
        if x.shape!=(n,len(CHANNELS),SIZE,SIZE) or y.shape!=(n,len(HORIZONS),SIZE,SIZE) or m.shape!=y.shape:
            raise ValueError("Tensor shape mismatch")
        if not np.isfinite(x).all() or not np.isfinite(p).all():raise ValueError("Non-finite tensor")
        if not np.isin(y,[0,1]).all() or not np.isin(p,[0,1]).all():raise ValueError("Nonbinary observation state")
        if not (y[:,1:]>=y[:,:-1]).all():raise ValueError("Nonmonotonic targets")
        if pd.to_datetime(t,utc=True).min()<pd.Timestamp(e["seed_available"]):raise ValueError("Future seed leak")
        if m.sum(axis=(0,2,3)).tolist()!=e["label_valid_cells"]:raise ValueError("Label-mask counts disagree")
        if (y*m).sum(axis=(0,2,3)).tolist()!=e["positive_cells"]:raise ValueError("Positive-label counts disagree")
        total+=n;role_counts[e["role"]]+=n;finite_count+=x.size
        empty+=((y*m).sum(axis=(2,3))==0).sum(axis=0)
    report=dict(status="passed",manifest_sha256=file_hash(data/"manifest.json"),events=len(events),samples=total,
                role_samples=dict(role_counts),finite_input_values=finite_count,nonfinite_input_values=0,
                future_empty_samples_by_horizon=empty.tolist(),cross_role_patch_overlaps=overlaps,
                checked_artifact_hashes=True,model_evaluated=False,smoke_only=manifest["smoke_only"])
    write_json(out,report);print(report,flush=True)


def main():
    ap=argparse.ArgumentParser();ap.add_argument("mode",choices=["preflight","tensors"])
    for name in ["extract","catalogue","weather","data"]:ap.add_argument("--"+name,type=Path)
    ap.add_argument("--out",type=Path,required=True);ap.add_argument("--max-samples",type=int,default=48)
    a=ap.parse_args()
    if a.mode=="preflight":preflight(a.extract,a.catalogue,a.weather,a.out,a.max_samples)
    else:tensors(a.data,a.out)


if __name__=="__main__":main()
