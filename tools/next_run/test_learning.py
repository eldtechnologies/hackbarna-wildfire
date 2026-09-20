"""Regression tests for the scientific/numerical changes in paper-driven runs."""
import numpy as np
import pytest
import torch
from .common import CHANNELS,HORIZONS
from .learning import hazard_loss, logit_hazard_loss, novel_candidates, objective_mask, operating_point
from .train import masked_loss, selection_metrics, build_model
from .test_training_runtime import ProbabilityChannels, selection_dataset


@pytest.mark.parametrize('gamma',[0.,2.])
@pytest.mark.parametrize('value',[-20.,-100.,-1000.])
def test_confident_false_alarms_keep_corrective_gradient(gamma,value):
    s=torch.tensor([value],requires_grad=True)
    loss=hazard_loss(s,torch.zeros(1),torch.ones(1),50.,gamma)
    loss.backward()
    assert torch.isfinite(loss) and s.grad.item() < -.99


@pytest.mark.parametrize('gamma',[0.,.25,.5,2.])
@pytest.mark.parametrize('value',[-87.,-100.,-1000.])
def test_confident_false_negatives_keep_corrective_gradient(gamma,value):
    z=torch.tensor([[[[value]]]],requires_grad=True)
    loss=logit_hazard_loss(z,torch.ones_like(z),torch.ones_like(z),50.,gamma)
    loss.backward()
    # FP32 logcumsumexp backward has ~3e-5 relative rounding at logits=-1000.
    assert torch.isfinite(loss) and z.grad.item()==pytest.approx(-50.,rel=1e-4)


@pytest.mark.parametrize('label',[0.,1.])
def test_fractional_focal_has_finite_gradients_at_zero_probability(label):
    z=torch.full((1,3,1,1),-1000.,requires_grad=True)
    logit_hazard_loss(z,torch.full_like(z,label),torch.ones_like(z),50.,.5).backward()
    assert torch.isfinite(z.grad).all()


def test_focal_matches_independent_probability_formula_away_from_saturation():
    s=torch.tensor([-.01,-.2,-1.,-3.],requires_grad=True)
    y=torch.tensor([1.,0.,1.,0.]);m=torch.tensor([1.,1.,0.,1.])
    p=-torch.expm1(s.double());pt=torch.where(y>0,p,1-p)
    expected=(-torch.log(pt)*(1-pt)**2*torch.where(y>0,7.,1.)*m).sum()/m.sum()
    actual=hazard_loss(s,y,m,7.,2.)
    assert actual.item()==pytest.approx(expected.item(),rel=2e-6)
    actual.backward();assert s.grad[2]==0


def test_gamma_zero_preserves_bce_and_missing_cells_do_not_train():
    s=-torch.rand(2,3,2,2);y=torch.randint(0,2,s.shape).float();m=torch.randint(0,2,s.shape).float()
    assert hazard_loss(s,y,m,50.,0.)==pytest.approx(masked_loss(s,y,m,50.).item())
    assert hazard_loss(s,y,torch.zeros_like(m),50.,2.) is None


def test_candidate_mask_is_input_only_and_does_not_call_unknown_no_fire():
    x=torch.zeros(1,len(CHANNELS),1,4)
    x[:,CHANNELS.index('past_bin0_observable_fraction'),:,0:3]=1
    x[:,CHANNELS.index('past_bin0_fire_fraction'),:,0]=1
    old=torch.tensor([[[1.,0.,0.,0.]]])
    candidate=novel_candidates(x,old)
    assert candidate.flatten().tolist()==[False,True,True,False]
    m=torch.ones(1,3,1,4)
    assert objective_mask(m,candidate,target='novel')[0,0,0].tolist()==[0,1,1,0]
    assert objective_mask(m,candidate,novel_weight=4)[0,0,0].tolist()==[1,4,4,1]
    np.testing.assert_array_equal(novel_candidates(x.numpy(),old.numpy()),candidate.numpy())


def test_selection_reports_matching_domains_and_all_horizons():
    d=selection_dataset(all_horizons=True)
    r=selection_metrics(ProbabilityChannels(),d,'cpu',3)
    assert r['all-6h']==pytest.approx(.75)
    assert r['novel-mean']==pytest.approx(.75)
    # Extinguished earlier detections do not become "new" when P returns to zero.
    d.persistence['a']=[np.ones_like(p) for p in d.persistence['a']]
    for i,(event,_) in enumerate(d.rows):
        if event['event_id']=='a':d.samples[i][0][CHANNELS.index('past_bin0_fire_fraction')]=1
    r=selection_metrics(ProbabilityChannels(),d,'cpu',3)
    assert r['all-6h']==pytest.approx(.75)
    assert r['novel-mean']==pytest.approx(1.)
    assert r['novel_positive_events']['6']==1


@pytest.mark.parametrize('architecture',['unet','resnet18'])
def test_model_roundtrip_and_mixed_precision_hazards(architecture):
    torch.set_num_threads(1)
    config=dict(architecture=architecture,base=8,pretrained=False)
    model=build_model(len(CHANNELS),config).eval()
    x=torch.randn(2,len(CHANNELS),64,64)
    with torch.no_grad(),torch.autocast('cpu',dtype=torch.bfloat16):
        p=model(x)
    assert p.dtype==torch.float32 and p.shape==(2,len(HORIZONS),64,64)
    assert torch.isfinite(p).all() and (p[:,1:]>=p[:,:-1]).all()
    restored=build_model(len(CHANNELS),config).eval();restored.load_state_dict(model.state_dict())
    with torch.no_grad():torch.testing.assert_close(model(x),restored(x),rtol=0,atol=0)


def test_precision_recall_exposes_misses_even_with_small_false_positive_rate():
    r=operating_point(np.array([1,1,1,1]+[0]*1000),np.array([.9,.1,.1,.1]+[.1]*1000),.5)
    assert r['precision']==1 and r['recall']==.25 and r['false_positive_rate']==0


def test_restricted_domain_is_not_full_domain_acceptance():
    from .acceptance import assess
    assert 'restricted-domain evaluation cannot establish full-domain acceptance' in assess([{'evaluation_domain':'novel'}],{})['reasons']


def test_fixed_updates_override_epoch_limit_and_save_complete_checkpoint(tmp_path,monkeypatch):
    import json
    from types import SimpleNamespace
    from . import train
    torch.set_num_threads(1)
    class TinyDataset(torch.utils.data.Dataset):
        events=[dict(samples=2,positive_cells=[1,1,1],label_valid_cells=[4,4,4],spatial_group='g')]
        rows=[(events[0],0),(events[0],1)]
        def __len__(self):return 2
        def __getitem__(self,i):
            return torch.ones(86,4,4),torch.ones(3,4,4),torch.ones(3,4,4),i,torch.ones(4,4,dtype=torch.bool)
    class TinyModel(torch.nn.Conv2d):
        def forward(self,x,return_logits=False):return super().forward(x)
    monkeypatch.setattr(train,'LearningDataset',lambda *a,**k:TinyDataset())
    def calibration_only(root,split,role,**kwargs):
        assert (split,role)==('validation','calibration')
        return TinyDataset()
    monkeypatch.setattr(train,'FireDataset',calibration_only)
    monkeypatch.setattr(train,'build_model',lambda *a,**k:TinyModel(86,3,1))
    monkeypatch.setattr(train,'selection_metrics',lambda *a,**k:{'all-6h':.2,'novel-mean':.1})
    monkeypatch.setattr(train,'collect',lambda *a,**k:{})
    monkeypatch.setattr(train,'fit_calibrator',lambda _:dict(slope=1.,intercept=0.))
    data=tmp_path/'data';data.mkdir()
    (data/'manifest.json').write_text(json.dumps(dict(smoke_only=False,channels=CHANNELS)))
    out=tmp_path/'run'
    args=SimpleNamespace(mode='train',data=data,out=out,workers=0,prefetch_factor=2,
        pin_memory=False,persistent_workers=False,seed=0,device='cpu',cache_events=2,
        target='all',novel_weight=1.,architecture='unet',base=8,pretrained=False,
        lr=.001,weight_decay=.001,pos_weight_cap=50.,batch_size=1,max_steps=5,
        epochs=1,patience=0,amp=False,focal_gamma=2.,selection_objective='novel-mean')
    train.run(args)
    curve=json.loads((out/'curve.json').read_text())
    assert [row['optimizer_steps'] for row in curve]==[2,2,1]
    assert curve[-1]['total_steps']==5
    assert torch.load(out/'frozen.pt',weights_only=True)['calibration']['slope']==1.
    assert not list(out.glob('*.tmp'))
