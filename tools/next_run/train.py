"""U-Net with masked multi-horizon loss and separate selection/calibration/test sets."""
from __future__ import annotations

import argparse
import itertools
import json
import os
from time import perf_counter
from pathlib import Path

import numpy as np
import torch
from torch import nn
from torch.utils.data import Dataset, DataLoader, WeightedRandomSampler
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import average_precision_score, brier_score_loss
from scipy.ndimage import distance_transform_edt
from threadpoolctl import threadpool_limits

from .common import file_hash, write_json, SCHEMA, CHANNELS, HORIZONS, validation_role
from .build import verify_event
from .loading import EventArrayCache, LoaderOptions, make_loader
from .learning import (hazard_loss, novel_candidates, objective_mask, cumulative_hazard,
                       ResNetUNet, operating_point, DecoderBlock, logit_hazard_loss)
from .domains import novel_masks


def finite(x, name):
    ok = bool(torch.isfinite(x).all()) if torch.is_tensor(x) else bool(np.isfinite(x).all())
    if not ok:
        raise ValueError(f"Non-finite {name}; abort instead of replacing failed predictions")


class FireDataset(Dataset):
    def __init__(self, root, split, role=None, cache_events=16):
        self.root = Path(root)
        self.cache = EventArrayCache(self.root, max_events=cache_events)
        self.manifest = json.loads((self.root/"manifest.json").read_text())
        if (self.manifest["schema"]!=SCHEMA or self.manifest["channels"]!=CHANNELS
                or self.manifest["horizons"]!=HORIZONS):raise ValueError("Unsupported tensor schema")
        self.events = [e for e in self.manifest["events"] if e.get("split")==split and e["samples"]>0]
        if role is not None:
            self.events = [e for e in self.events if e["role"]==role]
        for event in self.events:
            verify_event(self.root,event,self.manifest["dataset_id"])
        self.rows = [(e,i) for e in self.events for i in range(e["samples"])]
        if not self.rows:
            raise ValueError(f"Empty {split}/{role} split")

    def load(self, filename):
        return self.cache[filename]

    def __len__(self):
        return len(self.rows)

    def __getitem__(self, i):
        e,j = self.rows[i]; d=self.load(e["file"])
        x=d["X"][j].astype(np.float32); finite(x,"input")
        return (torch.from_numpy(x),torch.from_numpy(d["Y"][j].astype(np.float32)),
                torch.from_numpy(d["M"][j].astype(np.float32)),i)


class LearningDataset(FireDataset):
    def __init__(self,*args,need_candidates=True,**kwargs):
        super().__init__(*args,**kwargs);self.need_candidates=need_candidates
    def __getitem__(self, i):
        x,y,m,index=super().__getitem__(i)
        if not self.need_candidates:return x,y,m,index,torch.zeros(x.shape[-2:],dtype=torch.bool)
        e,j=self.rows[i]
        previous=torch.from_numpy(self.load(e['file'])['P'][j].astype(np.float32))
        return x,y,m,index,novel_candidates(x,previous)


Block=DecoderBlock


class UNet(nn.Module):
    def __init__(self, cin, base=32, horizons=len(HORIZONS)):
        super().__init__()
        self.a=Block(cin,base);self.b=Block(base,base*2);self.c=Block(base*2,base*4)
        self.pool=nn.MaxPool2d(2)
        self.ub=Block(base*6,base*2);self.ua=Block(base*3,base)
        self.head=nn.Conv2d(base,horizons,1)

    def forward(self,x,return_log_survival=False,return_logits=False):
        a=self.a(x);b=self.b(self.pool(a));c=self.c(self.pool(b))
        b2=self.ub(torch.cat([nn.functional.interpolate(c,size=b.shape[-2:],mode="bilinear",align_corners=False),b],1))
        a2=self.ua(torch.cat([nn.functional.interpolate(b2,size=a.shape[-2:],mode="bilinear",align_corners=False),a],1))
        # Conditional hazards guarantee P(within 1h) <= P(within 3h) <= P(within 6h).
        logits=self.head(a2)
        return logits if return_logits else cumulative_hazard(logits,return_log_survival)


def build_model(cin, config, *, initialize=False):
    architecture=config.get('architecture','unet')
    if architecture=='unet':return UNet(cin,config.get('base',32))
    if architecture=='resnet18':return ResNetUNet(cin,pretrained=initialize and config.get('pretrained',False))
    raise ValueError(f'Unknown architecture: {architecture}')


def masked_loss(log_survival,y,mask,pos_weight, *, known_nonempty=False):
    return hazard_loss(log_survival,y,mask,pos_weight,known_nonempty=known_nonempty)


def save_checkpoint(state, path):
    """Readers see the previous complete checkpoint or the next complete one."""
    path=Path(path)
    temporary=path.with_suffix(path.suffix+'.tmp')
    torch.save(state,temporary)
    os.replace(temporary,path)


def train_class_weight(dataset,cap=50.0):
    positive=valid=0
    for e in dataset.events:
        positive+=sum(e["positive_cells"]);valid+=sum(e["label_valid_cells"])
    if not positive or valid==positive:
        raise ValueError("Training set needs both observed-positive and observed-negative labels")
    weight=max(1.0,(valid-positive)/positive)
    return min(cap,weight) if cap else weight


def selection_metrics(model,dataset,device,batch_size,*,loader=None,amp=False):
    """Whole-episode AP for both domains and every horizon; no test access."""
    if loader is None:loader=make_loader(dataset,batch_size,LoaderOptions())
    model.eval();previous=None;parts=[[] for _ in HORIZONS]
    values={domain:[[] for _ in HORIZONS] for domain in ['all','novel']}
    def finish():
        for h,arrays in enumerate(parts):
            if not arrays:continue
            y,p,novel=[np.concatenate([r[i] for r in arrays]) for i in range(3)]
            for domain,use in [('all',np.ones(len(y),dtype=bool)),('novel',novel)]:
                if y[use].any():values[domain][h].append(float(average_precision_score(y[use],p[use])))
    with torch.no_grad():
        for batch in loader:
            x,y,m,idx=batch[:4]
            with torch.autocast(device_type=torch.device(device).type,dtype=torch.bfloat16,enabled=amp):
                p=model(x.to(device,non_blocking=loader.pin_memory)).float().cpu().numpy()
            finite(p,'selection prediction');y=y.numpy();m=m.numpy().astype(bool)
            for j,k in enumerate(idx.tolist()):
                event,sample=dataset.rows[k]
                if event['event_id']!=previous:
                    finish();parts=[[] for _ in HORIZONS];previous=event['event_id']
                if len(batch)==5:novel=batch[4][j].numpy()
                else:novel=novel_candidates(x[j].numpy(),dataset.load(event['file'])['P'][sample])
                for h in range(len(HORIZONS)):
                    use=m[j,h];parts[h].append((y[j,h][use],p[j,h][use],novel[use]))
    finish()
    report={'novel_definition':'no_past_detection_and_any_observed_history'}
    for domain,horizons in values.items():
        means=[float(np.mean(v)) if v else None for v in horizons]
        report[domain+'_per_horizon_event_ap']=dict(zip(map(str,HORIZONS),means))
        report[domain+'_positive_events']=dict(zip(map(str,HORIZONS),map(len,horizons)))
        report[domain+'-6h']=means[-1]
        report[domain+'-mean']=float(np.mean(means)) if all(v is not None for v in means) else None
    return report


def selection_ap(model,dataset,device,batch_size, *, loader=None, timings=None):
    """Exact whole-episode six-hour AP; supplied loader must preserve row order."""
    model.eval();values=[];previous=None;ys=[];ps=[]
    phase=dict(loader_wait_seconds=0.0,inference_seconds=0.0,ap_seconds=0.0)
    def finish():
        start=perf_counter()
        if ys:
            y=np.concatenate(ys);p=np.concatenate(ps)
            if y.any():values.append(float(average_precision_score(y,p)))
        phase['ap_seconds']+=perf_counter()-start
    if loader is None:loader=make_loader(dataset,batch_size,LoaderOptions())
    ready=perf_counter()
    with torch.no_grad():
        for x,y,m,idx in loader:
            phase['loader_wait_seconds']+=perf_counter()-ready
            start=perf_counter()
            p=model(x.to(device,non_blocking=loader.pin_memory))[:,-1].cpu().numpy();finite(p,"selection prediction")
            phase['inference_seconds']+=perf_counter()-start
            y=y[:,-1].numpy();m=m[:,-1].numpy().astype(bool)
            for j,k in enumerate(idx.tolist()):
                event=dataset.rows[k][0]["event_id"]
                if event!=previous:
                    finish();ys=[];ps=[];previous=event
                ys.append(y[j][m[j]]);ps.append(p[j][m[j]])
            ready=perf_counter()
    finish()
    if timings is not None:timings.update(phase)
    return float(np.mean(values)) if values else None


def collect(model,dataset,device,batch_size=16,calibrator=None, *, loader=None, include_baselines=True,target='all'):
    model.eval();result={}
    if loader is None:loader=make_loader(dataset,batch_size,LoaderOptions())
    with torch.no_grad():
        for x,y,m,idx in loader:
            p=model(x.to(device,non_blocking=loader.pin_memory)).cpu().numpy();finite(p,"evaluation predictions")
            if calibrator is not None:
                p=calibrate(p,calibrator)
            y=y.numpy();m=m.numpy().astype(bool)
            for j,k in enumerate(idx.tolist()):
                e,sample=dataset.rows[k]
                if include_baselines or target=='novel':
                    old=dataset.load(e["file"])["P"][sample].astype(np.float32)
                    domains,_=novel_masks(x[j].numpy(),old,CHANNELS)
                    novel=domains['latest_clear']
                if include_baselines:
                    distance=distance_transform_edt(old<=0)
                    baseline=np.exp(-distance/2).astype(np.float32) if (old>0).any() else np.zeros_like(old)
                record=result.setdefault(e["event_id"],dict(group=e["spatial_group"],h=[[] for _ in HORIZONS]))
                for h in range(len(HORIZONS)):
                    use=m[j,h]
                    if target=='novel':use=use & domains['no_past_detection']
                    extras=(old[use],baseline[use],novel[use]) if include_baselines else (None,None,None)
                    record["h"][h].append((y[j,h][use],p[j,h][use],*extras))
    return result


def score(records):
    output={}
    for h,hours in enumerate(HORIZONS):
        by_event=[];pooled=[]
        for event,r in records.items():
            parts=r["h"][h]
            if not parts:continue
            arrays=[np.concatenate([p[i] for p in parts]) for i in range(5)]
            y,p,persist,dilate,novel=arrays
            if len(y)==0:continue
            ap=lambda s:float(average_precision_score(y,s)) if y.any() else None
            by_event.append(dict(event=event,group=r["group"],ap=ap(p),persistence_ap=ap(persist),
                                 dilation_ap=ap(dilate),brier=float(brier_score_loss(y,p)),
                                 positives=int(y.sum()),cells=len(y),latest_clear_positives=int(y[novel].sum()),
                                 latest_clear_ap=float(average_precision_score(y[novel],p[novel])) if y[novel].any() else None,
                                 latest_clear_dilation_ap=float(average_precision_score(y[novel],dilate[novel])) if y[novel].any() else None))
            pooled.append(arrays)
        if not pooled:raise ValueError("No observed labels for evaluation")
        y,p,persist,dilate,novel=[np.concatenate([a[i] for a in pooled]) for i in range(5)]
        if not y.any():raise ValueError("No positive labels for evaluation")
        positive_events=[e for e in by_event if e["ap"] is not None]
        delta={}
        for e in positive_events:delta.setdefault(e["group"],[]).append(e["ap"]-e["dilation_ap"])
        group_deltas=np.array([np.mean(v) for v in delta.values()])
        rng=np.random.default_rng(0)
        ci=None
        if len(group_deltas)>=2:
            draws=rng.choice(group_deltas,(2000,len(group_deltas)),replace=True).mean(1)
            ci=np.quantile(draws,[.025,.975]).tolist()
        output[str(hours)]=dict(
            pooled_ap=float(average_precision_score(y,p)),
            persistence_ap=float(average_precision_score(y,persist)),
            dilation_ap=float(average_precision_score(y,dilate)),
            mean_event_ap=float(np.mean([e["ap"] for e in positive_events])) if positive_events else None,
            median_event_ap=float(np.median([e["ap"] for e in positive_events])) if positive_events else None,
            brier=float(brier_score_loss(y,p)),events=len(by_event),
            persistence_brier=float(brier_score_loss(y,persist)),
            dilation_brier=float(brier_score_loss(y,dilate)),
            calibration_bins=[dict(lower=float(lo),upper=float(hi),count=int(use.sum()),
                                   mean_probability=float(p[use].mean()),observed_fraction=float(y[use].mean()))
                              for lo,hi in zip(np.linspace(0,1,11)[:-1],np.linspace(0,1,11)[1:])
                              if (use:=((p>=lo)&(p<hi if hi<1 else p<=hi))).any()],
            negative_cell_false_positive_rate_at_05=float((p[y==0]>=.5).mean()) if (y==0).any() else None,
            negative_cell_mean_probability=float(p[y==0].mean()) if (y==0).any() else None,
            events_without_positive_label=sum(e["positives"]==0 for e in by_event),
            independent_geographic_groups=len(delta),
            event_ap_minus_dilation_group_bootstrap_95ci=ci,
            new_observable_detection_ap=float(average_precision_score(y[novel],p[novel])) if y[novel].any() else None,
            new_observable_detection_dilation_ap=float(average_precision_score(y[novel],dilate[novel])) if y[novel].any() else None,
            new_observable_detection_persistence_ap=float(average_precision_score(y[novel],persist[novel])) if y[novel].any() else None,
            operating_points=[operating_point(y,p,t) for t in [.01,.05,.1,.2,.5]],
            latest_clear_operating_points=[operating_point(y[novel],p[novel],t) for t in [.01,.05,.1,.2,.5]],
            per_event=by_event)
    return output


def clipped_logit(p):
    p=np.clip(p,1e-6,1-1e-6)
    return np.log(p)-np.log1p(-p)


def calibrate(p,c):
    z=clipped_logit(p)
    return 1/(1+np.exp(-np.clip(c["slope"]*z+c["intercept"],-40,40)))


def fit_calibrator(records):
    # Uniform sampling preserves prevalence. No negative subsampling or balancing.
    rng=np.random.default_rng(11);zs=[];ys=[];weights=[]
    for r in records.values():
        for parts in r["h"]:
            if not parts:continue
            y=np.concatenate([v[0] for v in parts]);p=np.concatenate([v[1] for v in parts])
            original_count=len(y)
            if len(y)>2000:
                take=rng.choice(len(y),2000,replace=False);y=y[take];p=p[take]
            zs.extend(clipped_logit(p).tolist());ys.extend(y.tolist())
            if len(y):weights.extend([original_count/len(y)]*len(y))
    if len(set(ys))<2:raise ValueError("Calibration set lacks both classes")
    clf=LogisticRegression(C=1000,max_iter=500).fit(np.asarray(zs).reshape(-1,1),ys,sample_weight=weights)
    slope=float(clf.coef_[0,0])
    if slope<=0:raise ValueError("Nonpositive calibration slope: model needs investigation")
    return dict(slope=slope,intercept=float(clf.intercept_[0]),samples=len(ys),
                method="shared monotonic logistic calibration on reserved validation regions")


def smoke(data,out):
    torch.manual_seed(0);torch.set_num_threads(2)
    d=FireDataset(data,"train");x,y,m,_=next(iter(DataLoader(d,batch_size=2)))
    model=UNet(x.shape[1],base=8)
    loss=logit_hazard_loss(model(x,return_logits=True),y,m,10)
    if loss is None:raise ValueError("Smoke batch has no usable labels")
    loss.backward()
    for p in model.parameters():
        if p.grad is not None:finite(p.grad,"gradient")
    model.eval()
    with torch.no_grad():pred=model(x)
    if not (pred[:,1:]>=pred[:,:-1]).all():raise ValueError("Horizon monotonicity failed")
    write_json(out,dict(status="passed",batch=list(x.shape),loss=float(loss.detach()),
                        finite_input=True,finite_gradient=True,monotonic_horizons=True,
                        note="Two-example CPU smoke check, not a training result"))


def training_sources():
    names=['train','learning','domains','loading','common','build','inputs','quality','weather','terrain']
    return {name:file_hash(Path(__file__).with_name(name+'.py')) for name in names}


def synchronize(device):
    if torch.device(device).type=='cuda':torch.cuda.synchronize(device)


def main():
    ap=argparse.ArgumentParser()
    ap.add_argument("mode",choices=["smoke","train","test"])
    ap.add_argument("--data",type=Path,required=True);ap.add_argument("--out",type=Path,required=True)
    ap.add_argument("--checkpoint",type=Path)
    ap.add_argument("--epochs",type=int,default=30);ap.add_argument("--patience",type=int,default=8)
    ap.add_argument("--batch-size",type=int,default=16);ap.add_argument("--base",type=int,default=32)
    ap.add_argument("--device",default="cuda");ap.add_argument("--seed",type=int,default=0)
    ap.add_argument("--unlock-final-test",action="store_true")
    ap.add_argument("--workers",type=int,default=2)
    ap.add_argument("--prefetch-factor",type=int,default=2)
    ap.add_argument("--cache-events",type=int,default=16)
    ap.add_argument("--cpu-threads",type=int,default=2)
    ap.add_argument("--pin-memory",action=argparse.BooleanOptionalAction,default=None)
    ap.add_argument("--persistent-workers",action=argparse.BooleanOptionalAction,default=True)
    ap.add_argument('--architecture',choices=['unet','resnet18'],default='unet')
    ap.add_argument('--pretrained',action='store_true')
    ap.add_argument('--lr',type=float,default=1e-3)
    ap.add_argument('--weight-decay',type=float,default=1e-3)
    ap.add_argument('--focal-gamma',type=float,default=0.0)
    ap.add_argument('--pos-weight-cap',type=float,default=50.0,help='Zero means uncapped; a hyperparameter, not a correction')
    ap.add_argument('--novel-weight',type=float,default=1.0)
    ap.add_argument('--target',choices=['all','novel'],default='all')
    ap.add_argument('--selection-objective',choices=['all-6h','all-mean','novel-6h','novel-mean'],default='all-6h')
    ap.add_argument('--max-steps',type=int,default=0,help='Fixed optimizer update budget; zero uses epochs')
    ap.add_argument('--amp',action='store_true',help='BF16 convolutions, FP32 probabilities and loss')
    a=ap.parse_args()
    if a.mode!='test' and a.checkpoint is not None:ap.error('train/smoke does not resume from --checkpoint; use a new declared experiment')
    if a.cpu_threads<1 or a.cache_events<1 or a.epochs<1 or a.patience<0:ap.error('thread/cache/epoch counts must be positive; patience must be nonnegative')
    numeric=[a.lr,a.weight_decay,a.focal_gamma,a.pos_weight_cap,a.novel_weight]
    if not np.isfinite(numeric).all() or a.lr<=0 or min(a.weight_decay,a.focal_gamma,a.pos_weight_cap,a.max_steps)<0 or a.novel_weight<1:ap.error('Invalid optimizer/loss budget')
    if a.pretrained and a.architecture!='resnet18':ap.error('Pretraining requires resnet18')
    if a.target=='novel' and not a.selection_objective.startswith('novel'):ap.error('Novel-only target requires a novel selection objective')
    if a.max_steps and a.patience:ap.error('Fixed --max-steps requires --patience 0; epoch limit is then ignored')
    if a.amp and torch.device(a.device).type!='cuda':ap.error('AMP training is currently validated only on CUDA')
    torch.set_num_threads(a.cpu_threads)
    torch.set_num_interop_threads(1)
    with threadpool_limits(limits=a.cpu_threads):run(a)


def run(a):
    if a.mode=="smoke":smoke(a.data,a.out);return
    manifest=json.loads((a.data/"manifest.json").read_text())
    if manifest["smoke_only"]:raise ValueError("A smoke dataset cannot support a real training/test result")
    sha=file_hash(a.data/"manifest.json")
    options=LoaderOptions(workers=a.workers,prefetch_factor=a.prefetch_factor,
                          pin_memory=torch.device(a.device).type=='cuda' if a.pin_memory is None else a.pin_memory,
                          persistent_workers=a.persistent_workers and a.workers>0,seed=a.seed)
    sources=training_sources()
    if a.mode=="test":
        if not a.unlock_final_test or a.checkpoint is None:raise ValueError("Final test requires a frozen checkpoint and --unlock-final-test")
        if a.out.exists():raise FileExistsError("Refusing to overwrite final test result")
        saved=torch.load(a.checkpoint,map_location=a.device,weights_only=False)
        if saved["manifest_sha256"]!=sha:raise ValueError("Checkpoint/dataset mismatch")
        if saved["trainer_sha256"]!=file_hash(__file__):raise ValueError("Frozen trainer source changed; evaluate with its pinned source version")
        if saved.get("runtime_sources")!=sources:raise ValueError("Frozen training dependencies changed")
        model=build_model(len(manifest['channels']),saved.get('model_config',dict(base=saved['base']))).to(a.device);model.load_state_dict(saved['state'])
        dataset=FireDataset(a.data,"test",cache_events=a.cache_events)
        scores=score(collect(model,dataset,a.device,a.batch_size,saved["calibration"],loader=make_loader(dataset,a.batch_size,options),target=saved.get('target','all')))
        write_json(a.out,dict(checkpoint_sha256=file_hash(a.checkpoint),manifest_sha256=sha,
                              evaluation_domain=saved.get('target','all'),
                              evaluation_domain_definition=('no_past_detection_and_any_observed_history' if saved.get('target')=='novel' else 'all_observable_future_labels'),
                              new_observable_definition='latest_clear_and_any_observed_history',scores=scores))
        return
    if a.out.exists():raise FileExistsError("Use a new run directory")
    a.out.mkdir(parents=True)
    write_json(a.out/"run.json",dict(arguments=vars(a),trainer_sha256=file_hash(__file__),
                                    torch_version=torch.__version__,numpy_version=np.__version__,
                                    manifest_sha256=sha,runtime_sources=sources,loader=options.to_dict(),
                                    cpu_threads=torch.get_num_threads(),precision='bf16_convolutions_fp32_hazards' if a.amp else 'float32'))
    torch.manual_seed(a.seed);np.random.seed(a.seed)
    initialization_start=perf_counter()
    train=LearningDataset(a.data,"train",cache_events=a.cache_events,need_candidates=a.target=='novel' or a.novel_weight!=1)
    selection=LearningDataset(a.data,"validation","selection",cache_events=a.cache_events)
    calibration=FireDataset(a.data,"validation","calibration",cache_events=a.cache_events)
    initialization_seconds=perf_counter()-initialization_start
    # No test tensors are loaded by training or checkpoint selection.
    model_config=dict(architecture=a.architecture,base=a.base,pretrained=a.pretrained)
    model=build_model(len(manifest['channels']),model_config,initialize=True).to(a.device)
    optimizer=torch.optim.AdamW(model.parameters(),lr=a.lr,weight_decay=a.weight_decay)
    weight=train_class_weight(train,a.pos_weight_cap)
    weights=[1/e["samples"] for e,_ in train.rows]
    sampler=WeightedRandomSampler(weights,len(train),replacement=True,
                                   generator=torch.Generator().manual_seed(a.seed))
    loader=make_loader(train,a.batch_size,options,sampler=sampler)
    selection_loader=make_loader(selection,a.batch_size,options)
    history=[];best=-float("inf");stale=0;total_steps=0;best_all=-float('inf')
    for epoch in itertools.count():
        if a.max_steps:
            if total_steps>=a.max_steps:break
        elif epoch>=a.epochs:break
        synchronize(a.device);start=perf_counter();ready=start;wait_seconds=0.0
        model.train();total=torch.zeros((),dtype=torch.float64,device=a.device);steps=empty_batches=examples=0
        for x,y,m,_,novel in loader:
            wait_seconds+=perf_counter()-ready
            active=m if a.target=='all' else m*novel.unsqueeze(1)
            if not bool(active.any()):
                empty_batches+=1;ready=perf_counter();continue
            optimizer.zero_grad(set_to_none=True)
            transfer=lambda v:v.to(a.device,non_blocking=options.pin_memory)
            with torch.autocast(device_type=torch.device(a.device).type,dtype=torch.bfloat16,enabled=a.amp):
                logits=model(transfer(x),return_logits=True)
            loss_mask=objective_mask(transfer(m),transfer(novel),target=a.target,novel_weight=a.novel_weight)
            loss=logit_hazard_loss(logits,transfer(y),loss_mask,weight,a.focal_gamma,known_nonempty=True)
            loss.backward()
            norm=nn.utils.clip_grad_norm_(model.parameters(),5,error_if_nonfinite=True)
            optimizer.step();total+=loss.detach();steps+=1;total_steps+=1;examples+=len(x);ready=perf_counter()
            if a.max_steps and total_steps>=a.max_steps:break
        synchronize(a.device);train_seconds=perf_counter()-start
        if not steps:raise ValueError("No valid training batches")
        start=perf_counter();selection_timing={}
        metrics=selection_metrics(model,selection,a.device,a.batch_size,loader=selection_loader)
        value=metrics[a.selection_objective]
        selection_seconds=perf_counter()-start
        if value is None:raise ValueError("Selection set has no positive events")
        history.append(dict(epoch=epoch+1,loss=float(total)/steps,selection_mean_event_ap=metrics['all-6h'],
                            selection_objective=a.selection_objective,selection_value=value,selection_metrics=metrics,total_steps=total_steps,
                            train_seconds=train_seconds,loader_wait_seconds=wait_seconds,
                            selection_seconds=selection_seconds,selection_timing=selection_timing,
                            train_examples_per_second=examples/train_seconds,optimizer_steps=steps,empty_batches=empty_batches))
        state=dict(state=model.state_dict(),base=a.base,model_config=model_config,target=a.target,
                   selection_objective=a.selection_objective,selection_metrics=metrics,
                   epoch=epoch+1,seed=a.seed,manifest_sha256=sha,trainer_sha256=file_hash(__file__),
                   runtime_sources=sources,class_weight=weight,
                   selection_geographic_groups=sorted({e['spatial_group'] for e in selection.events}))
        if metrics['all-6h'] is not None and metrics['all-6h']>best_all:
            best_all=metrics['all-6h'];save_checkpoint(state,a.out/'best_all6_uncalibrated.pt')
        if value>best:
            best=value;stale=0
            save_checkpoint(state,a.out/'best_uncalibrated.pt')
        else:stale+=1
        write_json(a.out/"curve.json",history)
        print(history[-1],flush=True)
        if (a.patience and stale>=a.patience) or (a.max_steps and total_steps>=a.max_steps):break
    del loader,selection_loader
    saved=torch.load(a.out/"best_uncalibrated.pt",map_location=a.device,weights_only=True)
    model.load_state_dict(saved["state"])
    start=perf_counter()
    saved["calibration"]=fit_calibrator(collect(model,calibration,a.device,a.batch_size,
        loader=make_loader(calibration,a.batch_size,options),include_baselines=False,target=a.target))
    calibration_seconds=perf_counter()-start
    saved["calibration_geographic_groups"]=sorted({e["spatial_group"] for e in calibration.events})
    if sources!=training_sources():raise ValueError('Training source changed during run; refusing to freeze')
    save_checkpoint(saved,a.out/"frozen.pt")
    write_json(a.out/"summary.json",dict(best_epoch=saved["epoch"],selection_mean_event_ap=saved['selection_metrics']['all-6h'],
                                         selection_objective=a.selection_objective,selection_value=best,
                                         best_all6_selection_ap=best_all,total_steps=total_steps,
                                         calibration=saved["calibration"],final_test_evaluated=False,
                                         initialization_seconds=initialization_seconds,calibration_seconds=calibration_seconds,
                                         stopping_policy='fixed_budget' if a.patience==0 else 'early_stopping'))


if __name__=="__main__":main()
