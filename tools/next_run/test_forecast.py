import json
import numpy as np
import pandas as pd
import pytest
from . import train as training_module
from .common import CHANNELS,HORIZONS,SCHEMA,file_hash
from .inputs import InputFrame
from .forecast import artifact,archived_frame
from .acceptance import assess,POLICY


def inputs():
    x=np.zeros((len(CHANNELS),64,64),np.float16)
    x[CHANNELS.index('past_bin0_observable_fraction')]=1
    x[CHANNELS.index('terrain_valid')]=1
    old=np.zeros((64,64),np.float16);old[32,32]=1
    event=dict(event_id='test',seed_row=5000,seed_col=6000)
    return event,x,old


def test_missing_acceptance_preserves_explicit_baseline(tmp_path):
    e,x,old=inputs();checkpoint=tmp_path/'untrusted.pt';checkpoint.write_bytes(b'not loaded')
    result=artifact(e,'2026-07-09T18:00Z',x,old,'a'*64,checkpoint)
    assert result['predictor']=='persistence'
    assert result['roadUse']=='unsupported'
    assert result['fallbackReason']=='model_acceptance_not_established'
    assert result['horizons'][0]['probability']==old.ravel().tolist()
    assert len(result['coverage']['weatherValid'])==20


def test_no_observations_is_not_an_all_clear_forecast():
    e,x,old=inputs();x[:24]=0
    result=artifact(e,'2026-07-09T18:00Z',x,old,'a'*64)
    assert result['status']=='insufficient_observations'
    assert all(h['probability'] is None for h in result['horizons'])


def test_archived_export_reads_no_future_labels(tmp_path):
    e,x,old=inputs();d=tmp_path/'test';d.mkdir()
    for n,v in dict(X=x[None],P=old[None],issue=np.array(['2026-07-09T18:00:00+00:00'])).items():np.save(d/f'{n}.npy',v)
    e.update(file='test',samples=1,sha256={p.name:file_hash(p) for p in d.glob('*.npy')})
    manifest=dict(schema=SCHEMA,channels=CHANNELS,horizons=HORIZONS,events=[e])
    (tmp_path/'manifest.json').write_text(json.dumps(manifest))
    _,got,previous,_=archived_frame(tmp_path,'test','2026-07-09T18:00Z')
    assert np.array_equal(got,x) and np.array_equal(previous,old)
    # No Y.npy or M.npy exists. Future labels are not an inference prerequisite.


def test_one_completed_run_cannot_claim_robust_acceptance():
    protocol=dict(schema='thermal-evaluation-protocol-v1',policy=POLICY,seeds=[0],candidates=[dict(seed=0,checkpoint_sha256='b'*64)],manifest_sha256='a'*64)
    result=assess([],protocol)
    assert result['decision']=='retain_baseline' and result['road_use']=='unsupported'
    assert 'fewer than three distinct predeclared training seeds' in result['reasons']


def test_gate_requires_paired_geographic_improvement_and_each_horizon():
    protocol=dict(schema='thermal-evaluation-protocol-v1',policy=POLICY,seeds=[0,1,2],
                  candidates=[dict(seed=i,checkpoint_sha256=str(i)*64) for i in range(3)],manifest_sha256='a'*64)
    scores={str(h):dict(per_event=[dict(event=str(i),group=str(i),positives=1,ap=.6,persistence_ap=.3,dilation_ap=.4) for i in range(10)],
                      brier=.1,persistence_brier=.2,dilation_brier=.2,negative_cell_false_positive_rate_at_05=.001) for h in HORIZONS}
    reports=[dict(checkpoint_sha256=str(i)*64,manifest_sha256='a'*64,scores=scores) for i in range(3)]
    assert assess(reports,protocol)['decision']=='research_model_eligible'
    reports[0]['scores']=dict(scores);reports[0]['scores'].pop('1')
    assert assess(reports,protocol)['decision']=='retain_baseline'


def test_input_builder_never_reads_future_scans_and_ignores_future_frp():
    issue=pd.Timestamp('2026-07-09T18:00Z')
    class Q:
        def availability(self,stamp):return issue-pd.Timedelta(hours=2)
        def sequence(self,start,end,*args,available_by=None):
            assert end<=issue and available_by==issue
            return np.zeros((3,64,64),np.uint8)
        def patch(self,*args):return None,issue-pd.Timedelta(hours=1)
    class W:
        def features(self,lon,lat,at,valid):return np.zeros(5,np.float32),np.ones(5,np.float32)
    class T:
        def sample(self,lon,lat):return np.zeros((16,64,64),np.float32),np.ones((64,64))
    event=dict(event_id='e',seed_row=3000,seed_col=6000,seed_scan_time=str(issue-pd.Timedelta(hours=3)),lon=0,lat=40)
    obs=pd.DataFrame(dict(ABS_LINE=[3000],ABS_SAMP=[6000],observed_at=[issue+pd.Timedelta(hours=1)],scan_time=[str(issue+pd.Timedelta(hours=1))],FRP=[100.]))
    a=InputFrame(event,Q(),W(),T(),obs).at(issue)[0]
    obs.FRP=1e9
    b=InputFrame(event,Q(),W(),T(),obs).at(issue)[0]
    assert np.array_equal(a,b)
    c=InputFrame(event,Q(),W(),T(),obs).at('2026-07-09T20:00:00+02:00')[0]
    assert np.array_equal(a,c)


def test_accepted_checkpoint_matches_training_inference(tmp_path):
    import torch
    from .train import UNet,calibrate
    from .forecast import producer_hash
    torch.set_num_threads(1)
    e,x,old=inputs();model=UNet(len(CHANNELS),8).eval()
    calibration=dict(slope=1.2,intercept=-.3)
    path=tmp_path/'frozen.pt'
    torch.save(dict(state=model.state_dict(),base=8,seed=0,calibration=calibration,
                    manifest_sha256='a'*64,trainer_sha256=file_hash(training_module.__file__)),path)
    checkpoint=file_hash(path)
    acceptance=dict(schema=POLICY['schema'],policy=POLICY,decision='research_model_eligible',reasons=[],
                    protocol_sha256='d'*64,checkpoint_sha256=[checkpoint],manifest_sha256='a'*64,
                    candidates=[dict(seed=0,checkpoint_sha256=checkpoint)])
    result=artifact(e,'2026-07-09T18:00Z',x,old,'a'*64,path,acceptance)
    with torch.no_grad():expected=calibrate(model(torch.from_numpy(x.astype(np.float32))[None])[0].numpy(),calibration)
    assert result['predictor']=='model' and result['fallbackReason'] is None
    for i,h in enumerate(result['horizons']):np.testing.assert_array_equal(h['probability'],expected[i].ravel())
    assert result['identity']['producerSha256']==producer_hash()
    assert result['uncertainty']['epistemic']=='not_estimated'
    acceptance['candidates'][0]['seed']=1
    with pytest.raises(ValueError,match='seed'):artifact(e,'2026-07-09T18:00Z',x,old,'a'*64,path,acceptance)


def test_nonfinite_and_duplicate_events_cannot_pass_acceptance():
    from .acceptance import valid_events
    row=dict(event='e',group='g',positives=2,ap=.6,persistence_ap=.4,dilation_ap=.4)
    assert valid_events([row])
    assert not valid_events([row,row])
    assert not valid_events([dict(row,ap=float('nan'))])
    assert not valid_events([dict(row,positives=0)])


def test_checkpoint_trainer_is_current_or_narrowly_audited(monkeypatch):
    from . import forecast
    current=file_hash(training_module.__file__)
    forecast.validate_trainer(current)
    forecast.validate_trainer('83a42e470850d3c9961805e3603a0b14db8207219e06eccc38503b57a4cfb6f6')
    with pytest.raises(ValueError,match='trainer'):forecast.validate_trainer('0'*64)
    monkeypatch.setattr(forecast,'file_hash',lambda p:'f'*64)
    with pytest.raises(ValueError,match='trainer'):forecast.validate_trainer(current)
    with pytest.raises(ValueError,match='trainer'):forecast.validate_trainer('83a42e470850d3c9961805e3603a0b14db8207219e06eccc38503b57a4cfb6f6')
