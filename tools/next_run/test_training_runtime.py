"""Synthetic checks for preserving training semantics during runtime changes."""
from pathlib import Path
import subprocess
import sys

import numpy as np
import pytest
import torch
from torch import nn
from torch.utils.data import Dataset

from .common import CHANNELS, HORIZONS
from .loading import LoaderOptions, make_loader
from .train import collect, fit_calibrator, score, selection_ap


class ProbabilityChannels(nn.Module):
    def forward(self, x):
        return x[:, -len(HORIZONS):]


class SyntheticEpisodes(Dataset):
    def __init__(self, samples):
        self.rows = []
        self.samples = []
        self.persistence = {}
        for event_id, probability, labels, mask in samples:
            height, width = labels.shape[-2:]
            x = np.zeros((len(CHANNELS), height, width), np.float32)
            for i, channel in enumerate(CHANNELS):
                if channel.endswith('observable_fraction'):
                    x[i] = 1
            x[-len(HORIZONS):] = probability
            previous = self.persistence.setdefault(event_id, [])
            sample = len(previous)
            previous.append(np.zeros((height, width), np.float32))
            event = dict(event_id=event_id, file=event_id, spatial_group=f'group-{event_id}')
            self.rows.append((event, sample))
            self.samples.append((x, labels.astype(np.float32), mask.astype(np.float32)))

    def __len__(self):
        return len(self.rows)

    def __getitem__(self, index):
        return (*[torch.from_numpy(value) for value in self.samples[index]], index)

    def load(self, event_id):
        return {'P': np.stack(self.persistence[event_id])}


def selection_dataset(all_horizons=False):
    samples = []
    # Episode A has AP=0.5 across its two samples; episode B has AP=1.
    for event, label, probability in [('a', 1, .6), ('a', 0, .9),
                                      ('b', 1, .8), ('b', 0, .1)]:
        labels = np.zeros((len(HORIZONS), 1, 2), np.float32)
        labels[-1, 0] = [label, 1 - label]
        if all_horizons:
            labels[:] = labels[-1]
        values = np.tile([probability, 0 if label == 0 else 1], (len(HORIZONS), 1, 1))
        mask = np.tile([1, 0], (len(HORIZONS), 1, 1))
        samples.append((event, values, labels, mask))
    shape = (len(HORIZONS), 1, 2)
    samples.append(('negative', np.full(shape, .99), np.zeros(shape), np.ones(shape)))
    samples.append(('empty', np.full(shape, .01), np.ones(shape), np.zeros(shape)))
    return SyntheticEpisodes(samples)


@pytest.mark.parametrize('workers', [0, 2])
@pytest.mark.parametrize('batch_size', [1, 3, 5])
def test_selection_keeps_whole_episode_ap_across_loader_settings(workers, batch_size):
    dataset = selection_dataset()
    loader = make_loader(dataset, batch_size, LoaderOptions(workers=workers, seed=23))
    value = selection_ap(ProbabilityChannels(), dataset, 'cpu', batch_size, loader=loader)
    assert value == pytest.approx(.75)


def test_scoring_keeps_negative_episodes_but_excludes_masked_cells():
    dataset = selection_dataset(all_horizons=True)
    loader = make_loader(dataset, 3, LoaderOptions())
    results = score(collect(ProbabilityChannels(), dataset, 'cpu', 3, loader=loader))
    labels = np.array([1, 0, 1, 0, 0, 0])
    probability = np.array([.6, .9, .8, .1, .99, .99])
    for horizon in map(str, HORIZONS):
        result = results[horizon]
        assert result['mean_event_ap'] == pytest.approx(.75)
        assert result['events'] == 3
        assert result['events_without_positive_label'] == 1
        assert result['brier'] == pytest.approx(np.mean((probability - labels) ** 2))
        assert result['negative_cell_false_positive_rate_at_05'] == pytest.approx(.75)
        events = {event['event']: event for event in result['per_event']}
        assert set(events) == {'a', 'b', 'negative'}
        assert events['negative']['ap'] is None
        assert events['negative']['cells'] == 2


def calibration_dataset():
    rng = np.random.default_rng(37)
    samples = []
    for event in ['a', 'a', 'a', 'b', 'b']:
        first = rng.uniform(.02, .4, (32, 32))
        probability = np.stack([first, first + .2, first + .4]).astype(np.float32)
        labels = rng.random((32, 32))[None] < probability
        mask = np.ones_like(labels)
        if event == 'b':
            mask[:, :16] = 0
        samples.append((event, probability, labels, mask))
    return SyntheticEpisodes(samples)


def test_light_collection_preserves_calibration_without_loading_baselines(monkeypatch):
    dataset = calibration_dataset()
    model = ProbabilityChannels()
    full = collect(model, dataset, 'cpu', 2,
                   loader=make_loader(dataset, 2, LoaderOptions()))

    def reject_baseline_read(*args, **kwargs):
        raise AssertionError('Calibration-only collection must not read persistence arrays')

    monkeypatch.setattr(dataset, 'load', reject_baseline_read)
    light = collect(model, dataset, 'cpu', 3, include_baselines=False,
                    loader=make_loader(dataset, 3, LoaderOptions()))
    assert list(light) == list(full)
    for event in full:
        assert light[event]['group'] == full[event]['group']
        for full_parts, light_parts in zip(full[event]['h'], light[event]['h'], strict=True):
            assert len(full_parts) == len(light_parts)
            for complete, reduced in zip(full_parts, light_parts, strict=True):
                assert len(reduced) == 5
                np.testing.assert_array_equal(reduced[0], complete[0])
                np.testing.assert_array_equal(reduced[1], complete[1])
                assert reduced[2:] == (None, None, None)
    expected = fit_calibrator(full)
    actual = fit_calibrator(light)
    # A has 3,072 cells per horizon; B has 1,024. Exercise both capped sampling
    # and its prevalence-preserving weights, not just a small unsampled case.
    assert actual['samples'] == expected['samples'] == len(HORIZONS) * (2000 + 1024)
    assert actual['slope'] == pytest.approx(expected['slope'], abs=1e-12)
    assert actual['intercept'] == pytest.approx(expected['intercept'], abs=1e-12)
    assert actual['method'] == expected['method']


def test_training_rejects_checkpoint_before_accessing_data(tmp_path):
    output = tmp_path / 'new-run'
    result = subprocess.run(
        [sys.executable, '-m', 'tools.next_run.train', 'train',
         '--data', str(tmp_path / 'missing-data'), '--out', str(output),
         '--checkpoint', str(tmp_path / 'missing-checkpoint.pt'), '--device', 'cpu'],
        cwd=Path(__file__).resolve().parents[2], capture_output=True, text=True, timeout=30,
    )
    assert result.returncode != 0
    assert 'does not resume' in (result.stdout + result.stderr).lower()
    assert not output.exists()
