"""Bounded train/selection throughput probe; no final-test data or release weights.

Run on an idle accelerator. Temporary subset manifests link immutable source files;
all selected files are verified by FireDataset, with startup timing kept separate.
"""
from __future__ import annotations
import argparse
import gc
import hashlib
import importlib.util
import json
import platform
from pathlib import Path
import sys
import tempfile
from time import perf_counter
import numpy as np
import torch
from threadpoolctl import threadpool_limits
from torch.utils.data import DataLoader, WeightedRandomSampler
from . import train
from .common import file_hash, write_json
from .loading import LoaderOptions, make_loader


def subset(root, destination, count, role):
    manifest=json.loads((root/'manifest.json').read_text())
    events=[e for e in manifest['events'] if e['role']==role and e.get('samples')]
    if not events:raise ValueError(f'No {role} events')
    indices=np.unique(np.linspace(0,len(events)-1,min(count,len(events))).astype(int))
    chosen=[events[i] for i in indices]
    destination.mkdir()
    for e in chosen:(destination/e['file']).symlink_to((root/e['file']).resolve(),target_is_directory=True)
    manifest.update(events=chosen,smoke_only=True)
    write_json(destination/'manifest.json',manifest)
    return len(chosen)


def module_from(path):
    name='tools.next_run._benchmark_legacy'
    spec=importlib.util.spec_from_file_location(name,path);module=importlib.util.module_from_spec(spec)
    sys.modules[name]=module;spec.loader.exec_module(module)
    return module


def measure(module,data,selection_data,a,workers,legacy=False):
    start=perf_counter()
    dataset=module.FireDataset(data,'train') if legacy else module.FireDataset(data,'train',cache_events=a.cache_events)
    initialization=perf_counter()-start
    weights=[1/e['samples'] for e,_ in dataset.rows]
    count=(a.steps+a.warmup)*a.batch_size
    sampler=WeightedRandomSampler(weights,count,replacement=True,generator=torch.Generator().manual_seed(a.seed))
    options=LoaderOptions(workers=workers,pin_memory=torch.device(a.device).type=='cuda',persistent_workers=workers>0,seed=a.seed)
    loader=DataLoader(dataset,batch_size=a.batch_size,sampler=sampler) if legacy else make_loader(dataset,a.batch_size,options,sampler)
    torch.manual_seed(a.seed)
    model=module.UNet(len(train.CHANNELS),a.base).to(a.device) if a.phase=='train' else None
    optimizer=torch.optim.AdamW(model.parameters(),lr=1e-3,weight_decay=1e-3) if model else None
    weight=module.train_class_weight(dataset) if model else None
    waits=[];observed=[];first=None;total=None;empty=0
    iterator=iter(loader);ready=perf_counter()
    for i in range(a.steps+a.warmup):
        x,y,m,idx=next(iterator)
        wait=perf_counter()-ready
        observed.extend(idx.tolist())
        if first is None:first=perf_counter()-start
        if model:
            optimizer.zero_grad(set_to_none=True)
            nonblocking=options.pin_memory and not legacy
            if not legacy and not bool(m.any()):loss=None
            else:
                extra={} if legacy else dict(known_nonempty=True)
                loss=module.masked_loss(model(x.to(a.device,non_blocking=nonblocking),return_log_survival=True),y.to(a.device,non_blocking=nonblocking),m.to(a.device,non_blocking=nonblocking),weight,**extra)
            if loss is None:empty+=1
            else:
                loss.backward();torch.nn.utils.clip_grad_norm_(model.parameters(),5,error_if_nonfinite=True);optimizer.step()
                if legacy:float(loss.detach())
        if i+1==a.warmup:
            train.synchronize(a.device);total=perf_counter()
        if i>=a.warmup:waits.append(wait)
        ready=perf_counter()
    train.synchronize(a.device);elapsed=perf_counter()-total
    # Release worker pools before measuring selection or the next configuration.
    del iterator,loader;gc.collect()
    result=dict(implementation='legacy' if legacy else 'optimized',workers=workers,
                phase=a.phase,steps=a.steps,initialization_seconds=initialization,
                startup_and_first_batch_seconds=first,steady_seconds=elapsed,
                samples_per_second=a.steps*a.batch_size/elapsed,
                loader_wait_p50_seconds=float(np.median(waits)),loader_wait_p95_seconds=float(np.quantile(waits,.95)),
                sampled_indices_sha256=hashlib.sha256(np.asarray(observed,dtype='<i8').tobytes()).hexdigest(),empty_batches=empty)
    if a.selection_events and model:
        selection=module.FireDataset(selection_data,'validation','selection')
        timing={}
        selection_loader=None if legacy else make_loader(selection,a.batch_size,options)
        start=perf_counter()
        if legacy:value=module.selection_ap(model,selection,a.device,a.batch_size)
        else:value=module.selection_ap(model,selection,a.device,a.batch_size,loader=selection_loader,timings=timing)
        result.update(selection_first_pass_seconds=perf_counter()-start,selection_ap=value,selection_timing=timing)
        del selection_loader;gc.collect()
    if model:
        state=model.state_dict()
        result['parameter_sha256']=hashlib.sha256(b''.join(v.detach().cpu().numpy().tobytes() for v in state.values())).hexdigest()
    return result


def main():
    p=argparse.ArgumentParser()
    p.add_argument('--data',type=Path,required=True);p.add_argument('--out',type=Path,required=True)
    p.add_argument('--phase',choices=['loader','train'],default='loader')
    p.add_argument('--device',default='cpu');p.add_argument('--steps',type=int,default=32)
    p.add_argument('--warmup',type=int,default=4);p.add_argument('--events',type=int,default=128)
    p.add_argument('--selection-events',type=int,default=0);p.add_argument('--batch-size',type=int,default=16)
    p.add_argument('--base',type=int,default=32);p.add_argument('--cpu-threads',type=int,default=2)
    p.add_argument('--workers',type=int,nargs='+',default=[0,2,4]);p.add_argument('--cache-events',type=int,default=16)
    p.add_argument('--legacy-source',type=Path);p.add_argument('--seed',type=int,default=0)
    a=p.parse_args()
    if min(a.steps,a.warmup,a.events,a.batch_size,a.cpu_threads)<1 or a.selection_events<0:p.error('counts must be positive; selection-events may be zero')
    if a.out.exists():raise FileExistsError('Use a new benchmark output')
    a.out.parent.mkdir(parents=True,exist_ok=True)
    torch.set_num_threads(a.cpu_threads);torch.set_num_interop_threads(1)
    rows=[];verification_seconds=0.0
    with threadpool_limits(limits=a.cpu_threads),tempfile.TemporaryDirectory(prefix='throughput-',dir=a.out.parent) as scratch:
        root=Path(scratch);n=subset(a.data,root/'train',a.events,'train')
        if a.selection_events:subset(a.data,root/'selection',a.selection_events,'selection')
        # Prime every selected file identically before any timed variant.
        start=perf_counter();verified=train.FireDataset(root/'train','train');verification_seconds=perf_counter()-start
        del verified
        if a.selection_events:
            verified=train.FireDataset(root/'selection','validation','selection');del verified
        if a.legacy_source:
            row=measure(module_from(a.legacy_source),root/'train',root/'selection',a,0,True);rows.append(row);print(json.dumps(row),flush=True)
        for workers in a.workers:
            row=measure(train,root/'train',root/'selection',a,workers);rows.append(row);print(json.dumps(row),flush=True)
        if a.legacy_source:
            row=measure(module_from(a.legacy_source),root/'train',root/'selection',a,0,True)
            row['repeat']='after_optimized';rows.append(row);print(json.dumps(row),flush=True)
    if len({r['sampled_indices_sha256'] for r in rows})!=1:raise ValueError('Benchmark variants used different samples')
    write_json(a.out,dict(schema='thermal-throughput-benchmark-v1',device=a.device,torch_version=torch.__version__,
        cpu_threads=a.cpu_threads,platform=platform.system(),machine=platform.machine(),common_verification_seconds=verification_seconds,manifest_sha256=file_hash(a.data/'manifest.json'),runtime_sources=train.training_sources(),
        legacy_source_sha256=file_hash(a.legacy_source) if a.legacy_source else None,events=n,
        test_partition_accessed=False,arguments=vars(a),results=rows,
        limitations=['Bounded sampled train events, not a full-epoch speed guarantee.','No predictive-accuracy conclusions; no production checkpoint produced.','Warm-cache and startup effects are reported separately; configuration order is not randomized.']))


if __name__=='__main__':main()
