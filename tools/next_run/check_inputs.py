"""Manual raw-archive parity check; does not touch the test partition or labels."""
import json
from pathlib import Path
import numpy as np
import pandas as pd
from tools.next_run.inputs import InputFrame
from tools.next_run.quality import Quality
from tools.next_run.weather import Weather
from tools.next_run.terrain import Terrain
from tools.next_run.common import file_hash
import argparse


def main():
    p=argparse.ArgumentParser(description='Recreate eight archived train/selection frames without reading labels.')
    p.add_argument('--data',type=Path,required=True);p.add_argument('--out',type=Path,required=True)
    a=p.parse_args();root=a.data
    m=json.loads((root/'manifest.json').read_text());cfg=m['config']
    q=Quality(cfg['archive']);w=Weather(cfg['weather']);t=Terrain(cfg['static_cache'],cfg.get('existing_tiles'),allow_remote=False)
    obs=pd.read_parquet(Path(cfg['extract'])/'observations.parquet',columns=['ABS_LINE','ABS_SAMP','observed_at','scan_time','FRP'])
    cat=pd.read_parquet(Path(cfg['catalogue'])/'events.parquet').set_index('event_id')
    rows=[]
    # Feature-only comparison in train/selection; never open test labels or scores.
    for role in ['train','selection']:
        events=[e for e in m['events'] if e['role']==role and e.get('samples')]
        for e in [events[0],events[len(events)//2]]:
            event=cat.loc[e['event_id']].to_dict();event['event_id']=e['event_id']
            frame=InputFrame(event,q,w,t,obs)
            path=root/e['file'];times=np.load(path/'issue.npy',allow_pickle=False)
            oldx=np.load(path/'X.npy',mmap_mode='r',allow_pickle=False);oldp=np.load(path/'P.npy',mmap_mode='r',allow_pickle=False)
            for i in [0,len(times)-1]:
                x,p=frame.at(str(times[i]));row=dict(event=e['event_id'],role=role,issue=str(times[i]),input_equal=bool(np.array_equal(x,oldx[i])),persistence_equal=bool(np.array_equal(p,oldp[i])),max_absolute_input_delta=float(np.max(np.abs(x.astype(float)-oldx[i].astype(float)))))
                rows.append(row);print(json.dumps(row),flush=True)
    report=dict(manifest_sha256=file_hash(root/'manifest.json'),future_labels_read=False,all_equal=all(r['input_equal'] and r['persistence_equal'] for r in rows),comparisons=rows)
    a.out.write_text(json.dumps(report,indent=2)+'\n')
    if not report['all_equal']:raise ValueError('Shared inference inputs differ from frozen arrays')


if __name__ == "__main__":
    main()
