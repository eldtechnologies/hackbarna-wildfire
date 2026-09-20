"""Export input-only native-grid forecasts. No future labels or test scores are read.

Archived examples and freshly prepared frames use the same exporter. Model serving
requires an acceptance artifact tied to the checkpoint and dataset; otherwise the
explicit persistence fallback is exported. All outputs remain research-only.
"""
from __future__ import annotations
import argparse
import hashlib
import json
from pathlib import Path
import numpy as np
import pandas as pd
import torch
from .common import CHANNELS,HORIZONS,SCHEMA,SIZE,digest,file_hash,write_json
from .quality import GEOS,Quality
from .terrain import Terrain
from .weather import Weather
from .inputs import InputFrame
from .train import UNet,build_model,calibrate,training_sources
from .acceptance import POLICY,is_hash

# Audited legacy trainers use identical Block/UNet/logit/calibration definitions.
# Pin both source identities so another inference change cannot silently pass.
COMPATIBLE_TRAINERS = {
    '83a42e470850d3c9961805e3603a0b14db8207219e06eccc38503b57a4cfb6f6': '0575bb1ae0b4f5514a0c94e368c4afc601225b66250e84d173ad1147a0f657db',
    '5582241583b9323d6adb0fe68ca24fc3982cd0668927a8748754cd0c3cd8906e': '0575bb1ae0b4f5514a0c94e368c4afc601225b66250e84d173ad1147a0f657db',
}


LEGACY_LEARNING_SHA256 = '3e4d160cb6f7953a8be27db3aa5a9e94a2c1ffa655b41279e038c3fe1f3084d7'

def validate_trainer(saved_hash):
    runtime_hash=file_hash(Path(__file__).with_name('train.py'))
    if saved_hash!=runtime_hash and COMPATIBLE_TRAINERS.get(saved_hash)!=runtime_hash:
        raise ValueError('Checkpoint trainer differs from verified inference runtime')
    if saved_hash!=runtime_hash and file_hash(Path(__file__).with_name('learning.py'))!=LEGACY_LEARNING_SHA256:
        raise ValueError('Legacy trainer inference dependency changed')


def producer_hash():
    names=['forecast','inputs','common','quality','weather','terrain','train','learning','domains','loading','acceptance']
    return digest({name:file_hash(Path(__file__).with_name(name+'.py')) for name in names})


def artifact(event,issue,x,previous,identity,checkpoint=None,acceptance=None,device='cpu'):
    issue=pd.Timestamp(issue)
    if issue.tzinfo is None:raise ValueError('Issue timezone required')
    issue=issue.tz_convert('UTC')
    if issue != issue.floor('h'):raise ValueError('Issue must be hourly')
    if not is_hash(identity):raise ValueError('Dataset identity must be a SHA-256')
    if x.shape!=(len(CHANNELS),SIZE,SIZE) or previous.shape!=(SIZE,SIZE):raise ValueError('Bad input shape')
    if not np.isfinite(x).all() or not np.isfinite(previous).all():raise ValueError('Nonfinite input')
    if not np.isin(previous,[0,1]).all():raise ValueError('Nonbinary persistence state')
    observed_bins=x[[i for i,n in enumerate(CHANNELS) if n.endswith('observable_fraction')]].astype(np.float32)
    observed=observed_bins.mean(0)
    weather=x[[i for i,n in enumerate(CHANNELS) if n.startswith('forecast_') and n.endswith('_valid')],0,0]
    stale=not bool(observed.any())
    reasons=[];predictor='persistence';calibration=None;checkpoint_sha=None;trainer_sha=None
    prediction=np.repeat(previous[None],len(HORIZONS),axis=0).astype(np.float32)
    if checkpoint is not None:
        checkpoint_sha=file_hash(checkpoint)
        if not acceptance or acceptance.get('schema')!=POLICY['schema'] or acceptance.get('policy')!=POLICY or acceptance.get('decision')!='research_model_eligible' or acceptance.get('reasons')!=[] or not is_hash(acceptance.get('protocol_sha256')):
            reasons.append('model_acceptance_not_established')
        elif checkpoint_sha not in acceptance.get('checkpoint_sha256',[]):reasons.append('checkpoint_not_in_accepted_protocol')
        elif acceptance.get('manifest_sha256')!=identity:reasons.append('acceptance_dataset_mismatch')
        elif stale:reasons.append('no_observable_history')
        else:
            saved=torch.load(checkpoint,map_location=device,weights_only=False)
            if saved['manifest_sha256']!=identity:raise ValueError('Checkpoint dataset mismatch')
            if saved.get('target','all')!='all':raise ValueError('Novel-only checkpoint cannot supply a full-domain forecast')
            validate_trainer(saved.get('trainer_sha256'))
            if (saved.get('trainer_sha256')==file_hash(Path(__file__).with_name('train.py')) or 'runtime_sources' in saved) and saved.get('runtime_sources')!=training_sources():
                raise ValueError('Checkpoint training dependencies changed')
            if not any(c.get('checkpoint_sha256')==checkpoint_sha and c.get('seed')==saved['seed'] for c in acceptance.get('candidates',[])):
                raise ValueError('Checkpoint seed differs from frozen protocol')
            calibration=saved.get('calibration')
            if calibration is None or not np.isfinite([calibration['slope'],calibration['intercept']]).all() or calibration['slope']<=0:
                raise ValueError('Missing monotonic calibration')
            trainer_sha=saved['trainer_sha256']
            model=build_model(len(CHANNELS),saved.get('model_config',dict(base=saved['base']))).to(device);model.load_state_dict(saved['state']);model.eval()
            with torch.no_grad():prediction=model(torch.from_numpy(x.astype(np.float32))[None].to(device))[0].cpu().numpy()
            prediction=calibrate(prediction,calibration);predictor='model'
    else:reasons.append('no_accepted_checkpoint')
    if stale:reasons.append('no_observable_history')
    if not np.isfinite(prediction).all() or (prediction<0).any() or (prediction>1).any():raise ValueError('Invalid prediction')
    if not (prediction[1:]>=prediction[:-1]).all():raise ValueError('Nonmonotonic horizons')
    row0=int(event['seed_row'])-SIZE//2;col0=int(event['seed_col'])-SIZE//2
    bins=np.flatnonzero(observed_bins.any(axis=(1,2)))
    latest_bin=None if not len(bins) else int(bins[-1])
    input_sha=hashlib.sha256(np.asarray(x,dtype='<f2').tobytes()+np.asarray(previous,dtype='<f2').tobytes()+digest([event['event_id'],row0,col0,issue.isoformat()]).encode()).hexdigest()
    return dict(schema='thermal-forecast-v1',target='observed_thermal_detection_within_horizon',eventId=event['event_id'],
        issuedAt=issue.isoformat(),generatedAt=pd.Timestamp.now(tz='UTC').isoformat(),predictor=predictor,
        status='insufficient_observations' if stale else 'forecast',
        deployment='research_only',roadUse='unsupported',fallbackReason=','.join(sorted(set(reasons))) or None,
        grid=dict(projection='geostationary',proj4=GEOS.srs,width=SIZE,height=SIZE,row0=row0,col0=col0,
                  centreTransform=[(col0-5567.5)*1000,1000,0,(5567.5-row0)*1000,0,-1000],order='row_major_north_to_south'),
        horizons=[dict(hours=h,validUntil=(issue+pd.Timedelta(hours=h)).isoformat(),probability=None if stale else prediction[i].ravel().tolist()) for i,h in enumerate(HORIZONS)],
        coverage=dict(observedFraction=observed.astype(float).ravel().tolist(),terrainValidFraction=float(x[CHANNELS.index('terrain_valid')].mean()),
                      weatherValid=weather.astype(float).tolist(),historyStart=(issue-pd.Timedelta(hours=3)).isoformat(),
                      latestObservableBin=None if latest_bin is None else dict(start=(issue-pd.Timedelta(minutes=180-30*latest_bin)).isoformat(),end=(issue-pd.Timedelta(minutes=150-30*latest_bin)).isoformat()),
                      availabilityPolicy='native-creation-or-scan-plus-45min;forecast-day1-plus-6h',stale=stale),
        identity=dict(datasetSha256=identity,checkpointSha256=checkpoint_sha,trainerSha256=trainer_sha,
                      inputSha256=input_sha,calibrationSha256=digest(calibration) if calibration else None,producerSha256=producer_hash(),acceptanceSha256=None),
        uncertainty=dict(calibration='held_out_regions' if calibration else 'uncalibrated',epistemic='not_estimated',
                         interpretation='conditional_on_label_observability'),
        limitations=['Not a verified wildfire perimeter or physical arrival-time distribution.',
                     'Cloud/unknown labels are censored; calibration is conditional on the evaluated observability regime.',
                     'Native pixels have variable ground footprints; input weather and fuel context are coarse.',
                     'Do not convert thermal probabilities into road-open, road-cut or evacuation instructions.'])


def archived_frame(root,event_id,issue):
    m=json.loads((root/'manifest.json').read_text())
    if m['schema']!=SCHEMA or m['channels']!=CHANNELS or m['horizons']!=HORIZONS:raise ValueError('Unsupported schema')
    event=next(e for e in m['events'] if e['event_id']==event_id and e['samples'])
    # Deliberately do not load Y/M or use their future availability to mask a forecast.
    for name in ['X.npy','P.npy','issue.npy']:
        if file_hash(root/event['file']/name)!=event['sha256'][name]:raise ValueError('Input checksum mismatch')
    times=np.load(root/event['file']/'issue.npy',allow_pickle=False)
    matches=np.flatnonzero(pd.to_datetime(times,utc=True)==pd.Timestamp(issue))
    if len(matches)!=1:raise ValueError('Issue must identify one prepared sample')
    i=int(matches[0]);x=np.load(root/event['file']/'X.npy',mmap_mode='r',allow_pickle=False)[i]
    old=np.load(root/event['file']/'P.npy',mmap_mode='r',allow_pickle=False)[i]
    return event,x,old,file_hash(root/'manifest.json')


def main():
    p=argparse.ArgumentParser();p.add_argument('--data',type=Path);p.add_argument('--event',required=True)
    p.add_argument('--issue',required=True);p.add_argument('--out',type=Path,required=True)
    p.add_argument('--checkpoint',type=Path);p.add_argument('--acceptance',type=Path);p.add_argument('--device',default='cpu')
    # For new observations, --frame-config supplies seed metadata and local input paths.
    p.add_argument('--frame-config',type=Path)
    a=p.parse_args()
    if (a.data is None)==(a.frame_config is None):p.error('Choose --data or --frame-config')
    if a.data is not None:event,x,old,identity=archived_frame(a.data,a.event,a.issue)
    else:
        cfg=json.loads(a.frame_config.read_text());event=cfg['event']
        if event['event_id']!=a.event:raise ValueError('Event identity mismatch')
        row0=int(event['seed_row'])-SIZE//2;col0=int(event['seed_col'])-SIZE//2
        issue=pd.Timestamp(a.issue)
        if issue.tzinfo is None:raise ValueError('Issue timezone required')
        observations=pd.read_parquet(Path(cfg['extract'])/'observations.parquet',
            columns=['ABS_LINE','ABS_SAMP','observed_at','scan_time','FRP'],
            filters=[('ABS_LINE','>=',row0),('ABS_LINE','<',row0+SIZE),
                     ('ABS_SAMP','>=',col0),('ABS_SAMP','<',col0+SIZE),
                     ('observed_at','>=',issue-pd.Timedelta(hours=3)),('observed_at','<',issue)])
        frame=InputFrame(event,Quality(cfg['archive']),Weather(cfg['weather']),
                         Terrain(cfg['static_cache'],cfg.get('existing_tiles'),allow_remote=False),
                         observations)
        x,old=frame.at(a.issue);identity=cfg['training_manifest_sha256']
    acceptance=json.loads(a.acceptance.read_text()) if a.acceptance else None
    result=artifact(event,a.issue,x,old,identity,a.checkpoint,acceptance,a.device)
    if a.acceptance:result['identity']['acceptanceSha256']=file_hash(a.acceptance)
    # Snapshot store uses content-safe keys; the server never accepts filesystem paths.
    key=digest([a.event,result['issuedAt']])
    a.out.mkdir(parents=True,exist_ok=True);write_json(a.out/f'{key}.json',result)
    index_path=a.out/'index.json'
    index=json.loads(index_path.read_text()) if index_path.exists() else dict(schema='thermal-forecast-index-v1',entries=[])
    index['entries']=[e for e in index['entries'] if not(e['eventId']==a.event and e['issuedAt']==result['issuedAt'])]
    index['entries'].append(dict(eventId=a.event,issuedAt=result['issuedAt'],file=key+'.json',sha256=file_hash(a.out/f'{key}.json')))
    write_json(index_path,index);print(result['predictor'],key)


if __name__=='__main__':main()
