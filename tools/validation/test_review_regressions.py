import hashlib
import importlib
import importlib.util
import json
from pathlib import Path
import pickle
from unittest.mock import patch
import zipfile

import numpy as np
import pandas as pd
import pytest
import torch

from tools.validation import frozen_inputs
from tools.validation.novel_detection import metrics, paired_groups
from tools.validation.input_audit import PoisonUnavailable, Quality
from tools.validation.paired_deepfire import counts, raster

REPO = Path(__file__).resolve().parents[2]


def test_exact_operating_threshold_is_inclusive():
    result = metrics(np.array([True, False, True, False]), {'model': np.array([.5, .5, .49, .49])})['model']
    assert result['negative_fpr_05'] == .5
    assert result['operating_points']['0.5'] == dict(true_positive=1, false_positive=1,
                                                   false_negative=1, precision=.5, recall=.5)


def test_bootstrap_protocol_has_a_reproducible_interval():
    rows = [dict(group=str(i), metrics={'model': {'ap': v}, 'base': {'ap': .1}})
            for i, v in enumerate([.12, .18, .23, .31, .5, .63, .74])]
    np.testing.assert_allclose(paired_groups(rows, 'base')['ci95'],
                               [0.13142857142857142, 0.44003571428571414], rtol=0, atol=1e-14)


class ObjectCheckpoint:
    def __reduce__(self):
        return eval, ('123',)  # Harmless probe; the restricted loader must not run it.


def test_restricted_checkpoint_loader_accepts_tensors_but_rejects_objects(tmp_path):
    path = tmp_path / 'checkpoint.pt'
    torch.save({'state': {'weight': torch.ones(2)}, 'base': 8}, path)
    assert frozen_inputs.load_checkpoint(path)['base'] == 8
    torch.save(ObjectCheckpoint(), path)
    with pytest.raises(pickle.UnpicklingError, match='Weights only load failed'):
        frozen_inputs.load_checkpoint(path)


def test_source_lock_checks_siblings_before_any_code_runs(tmp_path, monkeypatch):
    source = tmp_path / 'source/tools/next_run'
    source.mkdir(parents=True)
    files = {'__init__.py': 'raise AssertionError("must not execute")',
             'train.py': 'from .common import VALUE', 'common.py': 'VALUE = 42'}
    for name, text in files.items():
        (source / name).write_text(text)
    evidence = tmp_path / 'evidence'; evidence.mkdir()
    (evidence / 'trainer-source-lock.json').write_text(json.dumps(
        {name: hashlib.sha256(text.encode()).hexdigest() for name, text in files.items()}))
    monkeypatch.setattr(frozen_inputs, 'EVIDENCE', evidence)
    (source / 'common.py').write_text('raise AssertionError("tampered sibling")')
    with pytest.raises(ValueError, match='common.py'):
        with frozen_inputs.frozen_trainer(tmp_path / 'source'):
            pytest.fail('unverified source was exposed')
    files['__init__.py'] = ''
    for name, text in files.items():
        (source / name).write_text(text)
    (evidence / 'trainer-source-lock.json').write_text(json.dumps(
        {name: hashlib.sha256(text.encode()).hexdigest() for name, text in files.items()}))
    # An unlisted package at the caller root must never be imported.
    (source.parent / '__init__.py').write_text('raise AssertionError("caller root imported")')
    with frozen_inputs.frozen_trainer(tmp_path / 'source') as namespace:
        assert importlib.import_module(namespace + '.train').VALUE == 42


def test_paired_inventory_rejects_changed_cases_weather_and_simulations(tmp_path):
    with zipfile.ZipFile(REPO / 'docs/validation/deepfire-paired/frozen-benchmark.zip') as bundle:
        bundle.extractall(tmp_path)
    # The archive contains one directory at its root.
    run = next(tmp_path.rglob('eligible.json')).parent
    archive = run / 'simulations'
    protocol, rows = frozen_inputs.paired_inputs(run, archive)
    assert len(rows) == 38
    for changed in [rows[:-1], rows + [rows[0]]]:
        target = run / 'eligible.json'; original = target.read_bytes()
        target.write_text(json.dumps(changed))
        with pytest.raises(ValueError, match='eligible.json'):
            frozen_inputs.paired_inputs(run, archive)
        target.write_bytes(original)
    for target in [next((run / 'weather').glob('*.json')), archive / (rows[0]['id'] + '-simulation.json')]:
        original = target.read_bytes(); target.write_text('{}')
        with pytest.raises(ValueError, match='Frozen identity mismatch'):
            frozen_inputs.paired_inputs(run, archive)
        target.write_bytes(original)
    assert [row['id'] for row in rows] == protocol['eligible_simulation_ids']


def test_unavailable_quality_poison_preserves_availability_and_exercises_all_gates(tmp_path):
    issue = pd.Timestamp('2026-07-09T18:00Z')
    challenge = PoisonUnavailable(tmp_path, issue)
    clear = np.zeros((2, 2), np.uint8)
    for stamp, available, poisoned in [
        (issue - pd.Timedelta(hours=1), None, True),
        (issue - pd.Timedelta(hours=1), issue + pd.Timedelta(minutes=1), True),
        (issue, issue, True),
        (issue - pd.Timedelta(hours=1), issue, False),
    ]:
        with patch.object(Quality, 'patch', return_value=(clear, available)):
            got, delivery = challenge.patch(stamp, 0, 0, 2)
        assert delivery == available
        np.testing.assert_array_equal(got, np.ones_like(clear) if poisoned else clear)
    assert challenge.poisoned == 3


def test_paired_counts_and_polygon_hour_bounds():
    assert counts([1, 0, 1, 0], [1, 1, 0, 0]) == dict(tp=1, fp=1, fn=1, tn=1,
        precision=.5, recall=.5, f1=.5, csi=1/3, predicted_cells=2)
    assert counts([0], [0])['recall'] is None
    polygon = {'type': 'Polygon', 'coordinates': [[[100,-100],[900,-100],[900,-900],[100,-900],[100,-100]]]}
    sim = {'result': {'features': [{'properties': {'hour': 3}, 'geometry': polygon}]}}
    transform = lambda x, y, z=None: (x, y)
    assert not raster(sim, 2, 5568, 5568, transform, 2).any()
    np.testing.assert_array_equal(raster(sim, 3, 5568, 5568, transform, 2), [[True, False], [False, False]])


def test_importer_preserves_baseline_and_publishes_complete_bundle(tmp_path):
    spec = importlib.util.spec_from_file_location('almeria', REPO / 'scripts/import-almeria-infrastructure.py')
    importer = importlib.util.module_from_spec(spec); spec.loader.exec_module(importer)
    baseline = tmp_path / 'base'; baseline.mkdir()
    features = {}
    for kind, filename in importer.FILES.items():
        existing = {'id': 'catalonia-' + kind, 'properties': {}}
        (baseline / filename).write_text(json.dumps(dict(type='FeatureCollection', features=[existing])))
        features[kind] = [{'id': 'almeria-' + kind, 'properties': {'region': importer.REGION}}]
    metadata = json.loads((REPO / 'data/infrastructure/almeria-source.json').read_text())
    assert importer.BBOX == metadata['bbox']
    original = {p.name: p.read_bytes() for p in baseline.iterdir()}
    out = tmp_path / 'bundle'
    missing = baseline / 'schools.geojson'; missing.unlink()
    with pytest.raises(FileNotFoundError):
        importer.publish_bundle(baseline, out, features, metadata)
    assert not out.exists()
    missing.write_bytes(original[missing.name])
    with patch.object(Path, 'rename', side_effect=OSError('publication failed')):
        with pytest.raises(OSError, match='publication failed'):
            importer.publish_bundle(baseline, out, features, metadata)
    assert not out.exists()
    assert {p.name: p.read_bytes() for p in baseline.iterdir()} == original
    importer.publish_bundle(baseline, out, features, metadata)
    again = tmp_path / 'again'
    importer.publish_bundle(out, again, features, metadata)
    assert {p.name: p.read_bytes() for p in out.iterdir()} == {p.name: p.read_bytes() for p in again.iterdir()}
    for filename in importer.FILES.values():
        assert len(json.loads((out / filename).read_text())['features']) == 2
    with pytest.raises(FileExistsError):
        importer.publish_bundle(baseline, out, features, metadata)
