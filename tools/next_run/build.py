"""Build causal, masked, multi-horizon examples on the native satellite grid."""
from __future__ import annotations

import argparse
from concurrent.futures import ProcessPoolExecutor
import json
import os
import shutil
import tempfile
from pathlib import Path

import numpy as np
import pandas as pd

from .common import digest, write_json, file_hash, SCHEMA, SIZE, HORIZONS, TAIL_HOURS, LATENCY_MINUTES, CHANNELS
from .quality import Quality, labels, lonlat
from .terrain import Terrain
from .weather import Weather
from .inputs import InputFrame, update_observed_state, observed_offsets

def issue_times(start,end,archive_end,max_samples=48,seed_available=None):
    if max_samples<1:raise ValueError("max_samples must be positive")
    first=pd.Timestamp(start)+pd.Timedelta(minutes=LATENCY_MINUTES)
    if seed_available is not None:first=max(first,pd.Timestamp(seed_available))
    first=first.ceil("h")
    last=min((pd.Timestamp(end)+pd.Timedelta(hours=TAIL_HOURS)).ceil("h"),pd.Timestamp(archive_end)-pd.Timedelta(hours=max(HORIZONS)))
    times=pd.date_range(first,last,freq="h")
    # Cap event contribution without selecting on future positive labels. Retain
    # the terminal windows, even when the future detection mask is all zero.
    if len(times)>max_samples:
        times=times[np.unique(np.linspace(0,len(times)-1,max_samples).astype(int))]
    return times


def verify_event(root, result, dataset_id):
    if result["dataset_id"]!=dataset_id:raise ValueError("Event dataset identity mismatch")
    hashes=result.get("sha256",{})
    if set(hashes)!={"X.npy","Y.npy","M.npy","P.npy","issue.npy"}:
        raise ValueError("Incomplete event checksums")
    for name,sha in hashes.items():
        if file_hash(Path(root)/result["file"]/name)!=sha:raise ValueError(f"Corrupt event file: {name}")
    return result


def init_worker(config):
    global CFG,Q,W,T,OBS,BUCKETS,PERSISTENT
    CFG=config
    Q=Quality(config["archive"])
    W=Weather(config["weather"])
    T=Terrain(config["static_cache"],config.get("existing_tiles"),allow_remote=not config.get("offline_static",False))
    OBS=pd.read_parquet(Path(config["extract"])/"observations.parquet",
                        columns=["ABS_LINE","ABS_SAMP","observed_at","scan_time","FRP"])
    OBS["bucket"]=(OBS.ABS_LINE//64)*200+(OBS.ABS_SAMP//64)
    BUCKETS=OBS.groupby("bucket").indices
    prior=json.loads((Path(config["catalogue"])/"persistent_prior.json").read_text())
    PERSISTENT=set(map(tuple,prior["cells"]))


def local_observations(row0,col0):
    ix=[]
    for r in range(max(0,row0)//64,(row0+SIZE-1)//64+1):
        for c in range(max(0,col0)//64,(col0+SIZE-1)//64+1):
            if r*200+c in BUCKETS:ix.extend(BUCKETS[r*200+c])
    if not ix:return OBS.iloc[:0]
    d=OBS.iloc[ix]
    return d[d.ABS_LINE.between(row0,row0+SIZE-1)&d.ABS_SAMP.between(col0,col0+SIZE-1)]


def build_event(event):
    out=Path(CFG["out"]);path=out/event['event_id']
    metadata=path/"event.json"
    if metadata.exists():return verify_event(out,json.loads(metadata.read_text()),CFG["dataset_id"])
    if path.exists():raise ValueError(f"Unverified existing event directory: {path}")
    row0,col0=int(event["seed_row"])-SIZE//2,int(event["seed_col"])-SIZE//2
    seed_available=Q.availability(event["seed_scan_time"])
    result=dict(event_id=event["event_id"],spatial_group=event["spatial_group"],split=event["split"],
                role=event["role"],dataset_id=CFG["dataset_id"],samples=0,
                seed_row=event["seed_row"],seed_col=event["seed_col"],start=event["start"],end=event["end"],
                lon=event["lon"],lat=event["lat"],seed_available=str(seed_available))
    if seed_available is None:return dict(result,reason="seed_product_missing")
    times=issue_times(event["start"],event["end"],CFG["archive_end"],CFG["max_samples"],seed_available)
    if len(times)==0:return dict(result,reason="seed_unavailable_or_no_complete_future_window")
    persistent=np.array([[(r,c) in PERSISTENT for c in range(col0,col0+SIZE)] for r in range(row0,row0+SIZE)])
    obs=local_observations(row0,col0)
    inputs=InputFrame(event,Q,W,T,obs)
    Xs,Ys,Ms,Ps,issues=[],[],[],[],[]
    for issue in times:
        x,recent_fire=inputs.at(issue)
        future=Q.sequence(issue,issue+pd.Timedelta(hours=max(HORIZONS)),row0,col0,SIZE)
        yy,mm=zip(*(labels(future[:h*6],persistent) for h in HORIZONS))
        Xs.append(x.astype(np.float16));Ys.append(np.stack(yy).astype(np.uint8));Ms.append(np.stack(mm))
        Ps.append(recent_fire.astype(np.float16));issues.append(str(issue))
    x,y,m,p=np.stack(Xs),np.stack(Ys),np.stack(Ms),np.stack(Ps)
    if not np.isfinite(x).all():raise ValueError("float16 overflow")
    result.update(samples=len(x),file=path.name,
                label_valid_cells=m.sum(axis=(0,2,3)).tolist(),positive_cells=(y*m).sum(axis=(0,2,3)).tolist(),
                future_empty_samples=((y*m).sum(axis=(2,3))==0).sum(axis=0).tolist(),
                terrain_valid_fraction=float(inputs.static_valid.mean()))
    tmp=Path(tempfile.mkdtemp(prefix=f".{path.name}.",dir=out))
    try:
        for name,array in dict(X=x,Y=y,M=m,P=p,issue=np.asarray(issues)).items():np.save(tmp/f"{name}.npy",array)
        result["sha256"]={p.name:file_hash(p) for p in sorted(tmp.glob("*.npy"))}
        write_json(tmp/"event.json",result)
        tmp.rename(path)
    finally:
        if tmp.exists():shutil.rmtree(tmp)
    return result


def main():
    ap=argparse.ArgumentParser()
    for name in ["extract","catalogue","weather","static-cache","out"]:ap.add_argument("--"+name,type=Path,required=True)
    ap.add_argument("--existing-tiles",type=Path)
    ap.add_argument("--workers",type=int,default=3)
    ap.add_argument("--max-samples",type=int,default=48)
    ap.add_argument("--limit-events",type=int,default=0,help="Development smoke build only; manifest marks it")
    ap.add_argument("--offline-static",action="store_true")
    ap.add_argument("--resume",action="store_true",help="Verify identity and checksums before reusing completed events")
    a=ap.parse_args()
    if a.out.exists() and not a.resume:raise FileExistsError(f"Use --resume to verify and reuse {a.out}")
    a.out.mkdir(parents=True,exist_ok=True)
    extraction=json.loads((a.extract/"extraction.json").read_text())
    events=pd.read_parquet(a.catalogue/"events.parquet")
    events=events[events.split!="reserved"].sort_values(["split","start","event_id"])
    if a.limit_events:
        events=pd.concat([g.iloc[np.unique(np.linspace(0,len(g)-1,min(a.limit_events,len(g))).astype(int))]
                          for _,g in events.groupby("role")])
    end=max(pd.to_datetime(Path(f["path"]).name[-19:-7],format="%Y%m%d%H%M",utc=True) for f in extraction["files"])+pd.Timedelta(minutes=10)
    cfg={k:str(v) if isinstance(v,Path) else v for k,v in vars(a).items()}
    cfg.update(archive=extraction["archive"],archive_end=str(end))
    code={p.name:file_hash(p) for p in Path(__file__).parent.glob("*.py")
          if p.stem in ["common","extract","index","quality","terrain","weather","build","inputs"]}
    q=Quality(extraction["archive"])
    quality_files=[dict(path=str(p.relative_to(q.archive)),bytes=p.stat().st_size,mtime_ns=p.stat().st_mtime_ns)
                   for p in q.files.values()]
    sources=dict(code=code,events_sha256=file_hash(a.catalogue/"events.parquet"),
                 prior_sha256=file_hash(a.catalogue/"persistent_prior.json"),quality_files=quality_files,
                 weather_files={name:file_hash(a.weather/name) for name in sorted(set(json.loads((a.weather/"index.json").read_text())["locations"].values()))})
    semantic_config={k:v for k,v in cfg.items() if k not in ["workers","out","resume"]}
    cfg["dataset_id"]=digest([extraction["dataset_id"],semantic_config,sources,CHANNELS])
    manifest=dict(schema=SCHEMA,dataset_id=cfg["dataset_id"],
                  extraction_id=extraction["dataset_id"],channels=CHANNELS,horizons=HORIZONS,
                  target="observed native MTG detection within each horizon; not burned area",
                  unknown_label_policy="positive if any flag 1/2; negative only if ALL scheduled flags 0; otherwise excluded",
                  availability="max(NetCDF creation time, scan start + assumed 45 minutes)",
                  config=semantic_config,source_manifest_sha256=digest(sources),smoke_only=bool(a.limit_events),events=[])
    if a.resume:
        old=json.loads((a.out/"build.identity.json").read_text())
        if old["dataset_id"]!=cfg["dataset_id"]:raise ValueError("Resume source/config/code identity mismatch; use a new directory")
    else:
        write_json(a.out/"build.identity.json",dict(dataset_id=cfg["dataset_id"]))
        write_json(a.out/"sources.json",sources)
    with ProcessPoolExecutor(max_workers=a.workers,initializer=init_worker,initargs=(cfg,)) as pool:
        for i,result in enumerate(pool.map(build_event,events.to_dict("records"),chunksize=1)):
            manifest["events"].append(result)
            write_json(a.out/"manifest.partial.json",manifest)
            if (i+1)%10==0:print(f"events={i+1}/{len(events)} samples={sum(e['samples'] for e in manifest['events'])}",flush=True)
    write_json(a.out/"manifest.json",manifest)
    print(f"COMPLETE events={len(events)} samples={sum(e['samples'] for e in manifest['events'])}",flush=True)


if __name__=="__main__":main()
