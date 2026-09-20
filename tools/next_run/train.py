"""U-Net with masked multi-horizon loss and separate selection/calibration/test sets."""
from __future__ import annotations

import argparse
import json
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


class Block(nn.Sequential):
    def __init__(self, cin, cout):
        super().__init__(nn.Conv2d(cin,cout,3,padding=1),nn.GroupNorm(8,cout),nn.SiLU(),
                         nn.Conv2d(cout,cout,3,padding=1),nn.GroupNorm(8,cout),nn.SiLU())


class UNet(nn.Module):
    def __init__(self, cin, base=32, horizons=len(HORIZONS)):
        super().__init__()
        self.a=Block(cin,base);self.b=Block(base,base*2);self.c=Block(base*2,base*4)
        self.pool=nn.MaxPool2d(2)
        self.ub=Block(base*6,base*2);self.ua=Block(base*3,base)
        self.head=nn.Conv2d(base,horizons,1)

    def forward(self,x,return_log_survival=False):
        a=self.a(x);b=self.b(self.pool(a));c=self.c(self.pool(b))
        b2=self.ub(torch.cat([nn.functional.interpolate(c,size=b.shape[-2:],mode="bilinear",align_corners=False),b],1))
        a2=self.ua(torch.cat([nn.functional.interpolate(b2,size=a.shape[-2:],mode="bilinear",align_corners=False),a],1))
        # Conditional hazards guarantee P(within 1h) <= P(within 3h) <= P(within 6h).
        log_survival=-torch.cumsum(nn.functional.softplus(self.head(a2)),dim=1)
        return log_survival if return_log_survival else -torch.expm1(log_survival)


def masked_loss(log_survival,y,mask,pos_weight, *, known_nonempty=False):
    finite(log_survival,"log survival")
    if not known_nonempty and not mask.any():
        return None
    # Probability rounds to 1 at large hazards in float32. Computing BCE from
    # that rounded probability kills the gradient on confident false alarms.
    log_survival=log_survival.clamp_max(-torch.finfo(log_survival.dtype).tiny)
    positive=-torch.log(-torch.expm1(log_survival))
    loss=torch.where(y>0,positive,-log_survival)
    weights=torch.where(y>0,torch.as_tensor(pos_weight,device=y.device),1.0)
    loss=(loss*weights*mask).sum()/mask.sum()
    finite(loss,"loss")
    return loss


def train_class_weight(dataset):
    positive=valid=0
    for e in dataset.events:
        positive+=sum(e["positive_cells"]);valid+=sum(e["label_valid_cells"])
    if not positive or valid==positive:
        raise ValueError("Training set needs both observed-positive and observed-negative labels")
    return min(50.0,max(1.0,(valid-positive)/positive))


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


def collect(model,dataset,device,batch_size=16,calibrator=None, *, loader=None, include_baselines=True):
    model.eval();result={}
    if loader is None:loader=make_loader(dataset,batch_size,LoaderOptions())
    observable=[i for i,name in enumerate(CHANNELS) if name.endswith("observable_fraction")]
    with torch.no_grad():
        for x,y,m,idx in loader:
            p=model(x.to(device,non_blocking=loader.pin_memory)).cpu().numpy();finite(p,"evaluation predictions")
            if calibrator is not None:
                p=calibrate(p,calibrator)
            y=y.numpy();m=m.numpy().astype(bool)
            for j,k in enumerate(idx.tolist()):
                e,sample=dataset.rows[k]
                if include_baselines:
                    old=dataset.load(e["file"])["P"][sample].astype(np.float32)
                    distance=distance_transform_edt(old<=0)
                    baseline=np.exp(-distance/2).astype(np.float32) if (old>0).any() else np.zeros_like(old)
                    known=x[j,observable].numpy().max(axis=0)>0
                record=result.setdefault(e["event_id"],dict(group=e["spatial_group"],h=[[] for _ in HORIZONS]))
                for h in range(len(HORIZONS)):
                    use=m[j,h]
                    extras=(old[use],baseline[use],((old<=0)&known)[use]) if include_baselines else (None,None,None)
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
                                 positives=int(y.sum()),cells=len(y)))
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
    loss=masked_loss(model(x,return_log_survival=True),y,m,10)
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
    names=['train','loading','common','build','inputs','quality','weather','terrain']
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
    a=ap.parse_args()
    if a.mode!='test' and a.checkpoint is not None:ap.error('train/smoke does not resume from --checkpoint; use a new declared experiment')
    if a.cpu_threads<1 or a.cache_events<1 or a.epochs<1 or a.patience<0:ap.error('thread/cache/epoch counts must be positive; patience must be nonnegative')
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
        model=UNet(len(manifest["channels"]),saved["base"]).to(a.device);model.load_state_dict(saved["state"])
        dataset=FireDataset(a.data,"test",cache_events=a.cache_events)
        scores=score(collect(model,dataset,a.device,a.batch_size,saved["calibration"],loader=make_loader(dataset,a.batch_size,options)))
        write_json(a.out,dict(checkpoint_sha256=file_hash(a.checkpoint),manifest_sha256=sha,scores=scores))
        return
    if a.out.exists():raise FileExistsError("Use a new run directory")
    a.out.mkdir(parents=True)
    write_json(a.out/"run.json",dict(arguments=vars(a),trainer_sha256=file_hash(__file__),
                                    torch_version=torch.__version__,numpy_version=np.__version__,
                                    manifest_sha256=sha,runtime_sources=sources,loader=options.to_dict(),
                                    cpu_threads=torch.get_num_threads(),precision='float32'))
    torch.manual_seed(a.seed);np.random.seed(a.seed)
    initialization_start=perf_counter()
    train=FireDataset(a.data,"train",cache_events=a.cache_events)
    selection=FireDataset(a.data,"validation","selection",cache_events=a.cache_events)
    calibration=FireDataset(a.data,"validation","calibration",cache_events=a.cache_events)
    initialization_seconds=perf_counter()-initialization_start
    # No test tensors are loaded by training or checkpoint selection.
    model=UNet(len(manifest["channels"]),a.base).to(a.device)
    optimizer=torch.optim.AdamW(model.parameters(),lr=1e-3,weight_decay=1e-3)
    weight=train_class_weight(train)
    weights=[1/e["samples"] for e,_ in train.rows]
    sampler=WeightedRandomSampler(weights,len(train),replacement=True,
                                   generator=torch.Generator().manual_seed(a.seed))
    loader=make_loader(train,a.batch_size,options,sampler=sampler)
    selection_loader=make_loader(selection,a.batch_size,options)
    history=[];best=-float("inf");stale=0
    for epoch in range(a.epochs):
        synchronize(a.device);start=perf_counter();ready=start;wait_seconds=0.0
        model.train();total=torch.zeros((),dtype=torch.float64,device=a.device);steps=empty_batches=0
        for x,y,m,_ in loader:
            wait_seconds+=perf_counter()-ready
            if not bool(m.any()):
                empty_batches+=1;ready=perf_counter();continue
            optimizer.zero_grad(set_to_none=True)
            transfer=lambda v:v.to(a.device,non_blocking=options.pin_memory)
            loss=masked_loss(model(transfer(x),return_log_survival=True),transfer(y),transfer(m),weight,known_nonempty=True)
            loss.backward()
            norm=nn.utils.clip_grad_norm_(model.parameters(),5,error_if_nonfinite=True)
            optimizer.step();total+=loss.detach();steps+=1;ready=perf_counter()
        synchronize(a.device);train_seconds=perf_counter()-start
        if not steps:raise ValueError("No valid training batches")
        start=perf_counter();selection_timing={}
        value=selection_ap(model,selection,a.device,a.batch_size,loader=selection_loader,timings=selection_timing)
        selection_seconds=perf_counter()-start
        if value is None:raise ValueError("Selection set has no positive events")
        history.append(dict(epoch=epoch+1,loss=float(total)/steps,selection_mean_event_ap=value,
                            train_seconds=train_seconds,loader_wait_seconds=wait_seconds,
                            selection_seconds=selection_seconds,selection_timing=selection_timing,
                            train_examples_per_second=len(train)/train_seconds,optimizer_steps=steps,empty_batches=empty_batches))
        if value>best:
            best=value;stale=0
            torch.save(dict(state=model.state_dict(),base=a.base,epoch=epoch+1,seed=a.seed,
                            manifest_sha256=sha,trainer_sha256=file_hash(__file__),runtime_sources=sources,class_weight=weight,
                            selection_geographic_groups=sorted({e["spatial_group"] for e in selection.events})),
                       a.out/"best_uncalibrated.pt")
        else:stale+=1
        write_json(a.out/"curve.json",history)
        print(history[-1],flush=True)
        if a.patience and stale>=a.patience:break
    del loader,selection_loader
    saved=torch.load(a.out/"best_uncalibrated.pt",map_location=a.device,weights_only=False)
    model.load_state_dict(saved["state"])
    start=perf_counter()
    saved["calibration"]=fit_calibrator(collect(model,calibration,a.device,a.batch_size,
        loader=make_loader(calibration,a.batch_size,options),include_baselines=False))
    calibration_seconds=perf_counter()-start
    saved["calibration_geographic_groups"]=sorted({e["spatial_group"] for e in calibration.events})
    torch.save(saved,a.out/"frozen.pt")
    write_json(a.out/"summary.json",dict(best_epoch=saved["epoch"],selection_mean_event_ap=best,
                                         calibration=saved["calibration"],final_test_evaluated=False,
                                         initialization_seconds=initialization_seconds,calibration_seconds=calibration_seconds,
                                         stopping_policy='fixed_budget' if a.patience==0 else 'early_stopping'))


if __name__=="__main__":main()
