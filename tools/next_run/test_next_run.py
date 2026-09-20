"""Regression tests for the defects found in the first training pipelines."""
import json
from pathlib import Path

import numpy as np
import pandas as pd
import pytest
import torch

from .extract import parse_frame, raw_scans
from .quality import labels, Quality, GEOS, lonlat
from .build import issue_times, observed_offsets, update_observed_state, verify_event
from .index import split_for, purge_overlaps
from .weather import Weather, cache_key, clean_values
from .terrain import aspect_from_gradient
from .train import UNet, masked_loss, finite, validation_role


def scan_frame():
    return pd.DataFrame(dict(ACQTIME=["20260709150830"],ABS_LINE=[1600],ABS_SAMP=[5400],
                             LONGITUDE=[-2.],LATITUDE=[37.],LONGITUDE_PARALLAX=[-2.],
                             LATITUDE_PARALLAX=[37.],FRP=[np.nan],FRP_UNCERTAINTY=[np.nan],
                             FIRE_CONFIDENCE=[.1],PIXEL_SIZE=[1.4]))


def test_native_extraction_reconstructs_time_and_keeps_missing_frp():
    path="07/09/LSA-509_MTG_MTFRPPIXEL-ListProduct_MTG-FD_202607091500.csv.gz"
    d=parse_frame(scan_frame(),path,[-12,28,32,48])
    assert str(d.observed_at.iloc[0])=="2026-07-09 15:08:30+00:00"
    assert d.source_file.iloc[0]==path
    assert pd.isna(d.FRP.iloc[0])


def test_aggregate_not_a_native_scan(tmp_path):
    day=tmp_path/"07"/"09";day.mkdir(parents=True)
    name="LSA-509_MTG_MTFRPPIXEL-ListProduct_MTG-FD_202607091500.csv.gz"
    (day/name).touch()
    (tmp_path/"analysis").mkdir();(tmp_path/"analysis"/"iberia_bbox_hotspots.csv.gz").touch()
    assert [p.name for p in raw_scans(tmp_path)]==[name]
    with pytest.raises(ValueError):parse_frame(scan_frame(),"iberia_bbox_hotspots.csv.gz",[-12,28,32,48])


@pytest.mark.parametrize("time",["", "20261309150830","20260709160900"])
def test_bad_timestamp_is_an_error(time):
    d=scan_frame();d.ACQTIME=time
    with pytest.raises((ValueError,TypeError)):
        parse_frame(d,"LSA-509_MTG_MTFRPPIXEL-ListProduct_MTG-FD_202607091500.csv.gz",[-12,28,32,48])


def test_observation_mask_does_not_call_cloud_or_absence_negative():
    flags=np.array([[[0,0,1,2,255,10,8]],[[0,3,3,0,0,10,0]]],np.uint8)
    y,m=labels(flags)
    np.testing.assert_array_equal(y,[[0,0,1,1,0,0,0]])
    np.testing.assert_array_equal(m,[[1,0,1,1,0,0,0]])


def test_quality_prior_excludes_static_without_turning_it_into_negative():
    y,m=labels(np.ones((2,2,2),np.uint8),np.array([[1,0],[0,0]],bool))
    assert y[0,0]==1 and not m[0,0] and m[1,1]


def test_samples_include_end_of_episode_even_without_future_fire():
    t=issue_times("2026-07-01T12:08:00Z","2026-07-01T14:08:00Z","2026-07-10T00:00Z")
    assert t[0]==pd.Timestamp("2026-07-01T13:00Z")
    assert t[-1]>pd.Timestamp("2026-07-01T14:08Z")
    assert t[-1]==pd.Timestamp("2026-07-01T21:00Z")
    limited=issue_times("2026-07-01T00:00Z","2026-07-20T00:00Z","2026-07-30T00:00Z",max_samples=4)
    assert len(limited)==4 and limited[-1]==pd.Timestamp("2026-07-20T06:00Z")


def test_native_geometry_roundtrip():
    lo,la=lonlat(1800,5100,4);x,y=GEOS(lo,la)
    rr,cc=np.mgrid[1800:1804,5100:5104]
    np.testing.assert_allclose(x/1000+5567.5,cc,atol=1e-6)
    np.testing.assert_allclose(5567.5-y/1000,rr,atol=1e-6)


def test_aspect_north_up_row_sign():
    # Elevation rises north: row/south derivative is negative, slope faces south.
    assert np.isclose(aspect_from_gradient(-1,0),np.pi)
    assert np.isclose(aspect_from_gradient(1,0),0)
    assert np.isclose(aspect_from_gradient(0,1),3*np.pi/2)


def test_empty_current_fire_has_no_fake_corner_centroid():
    lo,la=np.meshgrid(np.arange(4),np.arange(4))
    assert not observed_offsets(np.zeros((4,4)),lo,la).any()


def test_weather_cache_is_coordinate_time_model_keyed():
    a=cache_key(-2,37,"2026-07-09","2026-07-10")
    assert a==cache_key(-2,37,"2026-07-09","2026-07-10")
    assert a!=cache_key(22,37,"2026-07-09","2026-07-10")
    assert a!=cache_key(-2,37,"2026-08-09","2026-08-10")


def test_weather_sentinel_is_missing_and_direction_is_not_a_sentinel_angle():
    values,mask=clean_values([-999,-999,None,30,0])
    assert not mask[:3].any()
    assert not values[:3].any()
    assert mask[3:].all()


def weather_fixture(tmp_path, rows):
    r=dict(requested_lon=-2.0,requested_lat=37.0,model="ecmwf_ifs025",
           lead_hours=24,publication_allowance_hours=6,rows=rows)
    (tmp_path/"cache.json").write_text(json.dumps(r))
    (tmp_path/"index.json").write_text(json.dumps({"locations":{"-2.0,37.0":"cache.json"}}))
    return Weather(tmp_path)


def test_weather_fails_on_missing_join_instead_of_silent_zero(tmp_path):
    w=weather_fixture(tmp_path,{})
    with pytest.raises(ValueError,match="Missing weather hour"):
        w.at(-2,37,"2026-07-09T12:00Z","2026-07-09T12:00Z")
    with pytest.raises(ValueError,match="No weather cache"):
        w.at(22,37,"2026-07-09T12:00Z","2026-07-09T12:00Z")


def test_weather_forecast_availability_and_vector_bearing(tmp_path):
    w=weather_fixture(tmp_path,{"2026-07-09T12:00Z":[10,90,30,40,0]})
    v=w.at(-2,37,"2026-07-09T06:00Z","2026-07-09T12:00Z")
    assert np.isclose(v[0],-10) and np.isclose(v[1],0,atol=1e-5)
    with pytest.raises(ValueError,match="not available"):
        w.at(-2,37,"2026-07-08T00:00Z","2026-07-09T12:00Z")


def test_missing_humidity_is_explicitly_masked_without_losing_wind(tmp_path):
    w=weather_fixture(tmp_path,{"2026-07-09T12:00Z":[10,90,30,None,0]})
    values,mask=w.features(-2,37,"2026-07-09T06:00Z","2026-07-09T12:00Z")
    np.testing.assert_array_equal(mask,[1,1,1,0,1])
    assert values[3]==0 and np.isclose(values[0],-10)
    with pytest.raises(ValueError,match="Invalid/missing"):
        w.at(-2,37,"2026-07-09T06:00Z","2026-07-09T12:00Z")


def test_prediction_nan_is_not_sanitized():
    with pytest.raises(ValueError):finite(np.array([np.nan]),"test")
    with pytest.raises(ValueError):finite(torch.tensor([float("nan")]),"test")


def test_masked_loss_ignores_unknown_and_horizon_probability_is_monotonic():
    torch.set_num_threads(2);torch.manual_seed(1)
    net=UNet(cin=4,base=8)
    x=torch.randn(2,4,16,16);p=net(x)
    assert torch.all(p[:,1:]>=p[:,:-1])
    y=torch.zeros_like(p);m=torch.ones_like(p);m[:,:,0,0]=0
    log_survival=net(x,return_log_survival=True)
    l1=masked_loss(log_survival,y,m,5)
    y2=y.clone();y2[:,:,0,0]=1;l2=masked_loss(log_survival,y2,m,5)
    torch.testing.assert_close(l1,l2)
    l1.backward()
    for param in net.parameters():
        if param.grad is not None:assert torch.isfinite(param.grad).all()


def test_selection_and_calibration_are_group_stable():
    roles={validation_role(f"group{i}") for i in range(100)}
    assert roles=={"selection","calibration"}
    assert validation_role("same")==validation_role("same")


def test_confident_false_alarm_still_has_gradient():
    z=torch.tensor([17.0],requires_grad=True)
    log_survival=-torch.nn.functional.softplus(z)
    loss=masked_loss(log_survival,torch.zeros(1),torch.ones(1),1)
    loss.backward()
    assert loss.item()==pytest.approx(17,abs=1e-5)
    assert z.grad.item()==pytest.approx(1,abs=1e-5)


def test_late_seed_never_starts_a_retrospectively_available_event():
    times=issue_times("2026-07-24T14:08Z","2026-07-24T18:08Z","2026-08-01T00:00Z",
                      seed_available="2026-07-29T18:18:54Z")
    assert len(times)==0
    times=issue_times("2026-07-24T14:08Z","2026-07-24T18:08Z","2026-08-01T00:00Z",
                      seed_available="2026-07-24T17:18:54Z")
    assert times[0]==pd.Timestamp("2026-07-24T18:00Z")


def test_persistence_retains_latest_observable_state_through_cloud():
    flags=np.array([[[1,0]],[[0,1]],[[3,3]]],np.uint8)
    np.testing.assert_array_equal(update_observed_state(np.zeros((1,2)),flags),[[0,1]])


def test_selection_calibration_overlap_is_purged():
    e=pd.DataFrame([dict(split="validation",spatial_group="native256-6-30",seed_row=1773,seed_col=7747),
                    dict(split="validation",spatial_group="native256-7-30",seed_row=1831,seed_col=7706)])
    result,n=purge_overlaps(e)
    assert n==1 and set(result.role)=={"reserved","calibration"}


def test_resume_rejects_changed_artifact(tmp_path):
    from .common import file_hash
    p=tmp_path/"event";p.mkdir();(p/"X.npy").write_bytes(b"original")
    meta=dict(file="event",dataset_id="id",sha256={"X.npy":file_hash(p/"X.npy")})
    assert verify_event(tmp_path,meta,"id")==meta
    (p/"X.npy").write_bytes(b"corrupt")
    with pytest.raises(ValueError,match="Corrupt"):verify_event(tmp_path,meta,"id")


def test_weather_transport_error_is_retried(tmp_path,monkeypatch):
    from . import weather
    calls=[]
    def fail(*args,**kwargs):
        calls.append(1)
        raise weather.requests.Timeout("test")
    monkeypatch.setattr(weather.requests,"get",fail)
    monkeypatch.setattr(weather,"throttle",lambda:None)
    monkeypatch.setattr(weather.time,"sleep",lambda n:None)
    with pytest.raises(weather.requests.Timeout):weather.fetch_one((-2,37,"2026-07-09","2026-07-10",tmp_path))
    assert len(calls)==7
