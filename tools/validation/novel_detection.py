"""Exploratory frozen-checkpoint audit, with no fitting or threshold selection.

Requires the exact trainer source named by the checkpoint. This is a separate
diagnostic, not a replacement for that trainer's official final-test command.
"""
from __future__ import annotations

import argparse
import hashlib
import importlib
import json
from pathlib import Path
import time

import numpy as np
from scipy.ndimage import distance_transform_edt
from sklearn.metrics import average_precision_score
import torch

if __package__:
    from .frozen_inputs import frozen_trainer, load_checkpoint
else:
    from frozen_inputs import frozen_trainer, load_checkpoint


def sha(path):
    h = hashlib.sha256()
    with Path(path).open('rb') as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b''):
            h.update(chunk)
    return h.hexdigest()


def distance_score(active):
    return (np.exp(-distance_transform_edt(~active) / 2).astype(np.float32)
            if active.any() else np.zeros(active.shape, np.float32))


def novel_masks(x, old, channels):
    observable = [i for i, name in enumerate(channels) if name.endswith('observable_fraction')]
    fire = [i for i, name in enumerate(channels) if name.endswith('fire_fraction')]
    if len(observable) != 6 or len(fire) != 6:
        raise ValueError('Expected six observation bins')
    known = x[:, observable].max(axis=1) > 0
    past = x[:, fire].max(axis=1) > 0
    return {'full': np.ones_like(known), 'latest_clear': known & (old == 0),
            'no_past_detection': known & ~past}, past


def metrics(y, predictions):
    result = {'cells': len(y), 'positives': int(y.sum()),
              'prevalence': float(y.mean()) if len(y) else None}
    for name, p in predictions.items():
        result[name] = {
            'ap': float(average_precision_score(y, p)) if y.any() else None,
            'brier': float(np.mean((p.astype(np.float64) - y) ** 2)) if len(y) else None,
            'negative_fpr_05': float((p[y == 0] >= .5).mean()) if (y == 0).any() else None,
        }
        result[name]['operating_points'] = {}
        for threshold in [.1, .25, .5]:
            alert = p >= threshold
            tp = int((alert & (y > 0)).sum())
            fp = int((alert & (y == 0)).sum())
            result[name]['operating_points'][str(threshold)] = {
                'true_positive': tp, 'false_positive': fp,
                'false_negative': int(y.sum()) - tp,
                'precision': tp / (tp + fp) if tp + fp else None,
                'recall': tp / int(y.sum()) if y.any() else None,
            }
    return result


def paired_groups(events, baseline):
    groups = {}
    for event in events:
        m = event['metrics']
        if m['model']['ap'] is not None:
            groups.setdefault(event['group'], []).append(m['model']['ap'] - m[baseline]['ap'])
    deltas = np.array([np.mean(v) for v in groups.values()])
    if not len(deltas):
        return {'groups': 0, 'mean': None, 'ci95': None}
    draws = np.random.default_rng(0).choice(deltas, (2000, len(deltas)), replace=True).mean(axis=1)
    return {'groups': len(deltas), 'mean': float(deltas.mean()),
            'ci95': np.quantile(draws, [.025, .975]).tolist() if len(deltas) > 1 else None,
            'group_deltas': {k: float(np.mean(v)) for k, v in groups.items()}}


def main():
    ap = argparse.ArgumentParser()
    for name in ['data', 'checkpoint', 'trainer-root', 'protocol', 'out']:
        ap.add_argument('--' + name, type=Path, required=True)
    ap.add_argument('--device', default='cpu')
    ap.add_argument('--batch-size', type=int, default=16)
    a = ap.parse_args()
    if a.out.exists():
        raise FileExistsError('Use a fresh output directory')
    protocol = json.loads(a.protocol.read_text())
    if not (sha(a.checkpoint) == protocol['checkpoint_sha256']):
        raise ValueError('Checkpoint hash mismatch')
    if not (sha(a.data / 'manifest.json') == protocol['manifest_sha256']):
        raise ValueError('Manifest hash mismatch')
    if not (sha(a.trainer_root / 'tools/next_run/train.py') == protocol['trainer_sha256']):
        raise ValueError('Trainer hash mismatch')
    with frozen_trainer(a.trainer_root) as namespace:
        trainer = importlib.import_module(namespace + '.train')
        torch.set_num_threads(2)
        saved = load_checkpoint(a.checkpoint)
        if not (saved['manifest_sha256'] == protocol['manifest_sha256']):
            raise ValueError('Checkpoint manifest provenance mismatch')
        if not (saved['trainer_sha256'] == protocol['trainer_sha256']):
            raise ValueError('Checkpoint trainer provenance mismatch')
        manifest = json.loads((a.data / 'manifest.json').read_text())
        if not (not manifest['smoke_only']):
            raise ValueError('A smoke dataset cannot validate model accuracy')
        channels = manifest['channels']
        model = trainer.UNet(len(channels), saved['base']).eval().to(a.device)
        model.load_state_dict(saved['state'])
        events = [e for e in manifest['events'] if e['split'] == 'test' and e['samples'] > 0]
        a.out.mkdir(parents=True)
        pooled = {mask: {str(h): [] for h in [1, 3, 6]}
                  for mask in ['full', 'latest_clear', 'no_past_detection']}
        per_event = {mask: {str(h): [] for h in [1, 3, 6]} for mask in pooled}
        started = time.monotonic()
        parity = None
        for ei, e in enumerate(events):
            path = a.data / e['file']
            for name, expected in e['sha256'].items():
                if sha(path / name) != expected:
                    raise ValueError(f'Hash mismatch: {e["event_id"]}/{name}')
            x = np.load(path / 'X.npy', mmap_mode='r')
            old = np.load(path / 'P.npy', mmap_mode='r')
            predictions = []
            with torch.inference_mode():
                for start in range(0, len(x), a.batch_size):
                    batch = torch.from_numpy(x[start:start+a.batch_size].astype(np.float32))
                    p = model(batch.to(a.device)).cpu().numpy()
                    if not np.isfinite(p).all():
                        raise ValueError('Non-finite predictions')
                    if parity is None:
                        cpu = trainer.UNet(len(channels), saved['base']).eval()
                        cpu.load_state_dict(saved['state'])
                        cp = cpu(batch).numpy()
                        parity = {'batch_samples': len(batch), 'max_abs_cpu_device_delta': float(np.abs(cp-p).max())}
                        del cpu
                    predictions.append(trainer.calibrate(p, saved['calibration']))
            pred = np.concatenate(predictions)
            # Labels are first opened after this event's model inference has completed.
            y = np.load(path / 'Y.npy', mmap_mode='r').astype(bool)
            valid = np.load(path / 'M.npy', mmap_mode='r').astype(bool)
            masks, past = novel_masks(x, old, channels)
            dlast = np.stack([distance_score(p > 0) for p in old])
            dhist = np.stack([distance_score(p) for p in past])
            for maskname, eligibility in masks.items():
                for hi, hours in enumerate([1, 3, 6]):
                    h = str(hours)
                    use = eligibility & valid[:, hi]
                    arrays = [y[:, hi][use], pred[:, hi][use], old[use].astype(np.float32), dlast[use], dhist[use]]
                    pooled[maskname][h].append(arrays)
                    m = metrics(arrays[0], dict(zip(['model', 'persistence', 'dilation', 'history_dilation'], arrays[1:])))
                    per_event[maskname][h].append({'event': e['event_id'], 'group': e['spatial_group'], 'metrics': m})
            if (ei + 1) % 20 == 0 or ei + 1 == len(events):
                print(json.dumps({'events': ei + 1, 'total': len(events), 'seconds': round(time.monotonic()-started, 1)}), flush=True)
        report = {'protocol': protocol, 'torch': torch.__version__, 'numpy': np.__version__,
                  'device': a.device, 'cpu_device_parity': parity, 'events': len(events),
                  'samples': sum(e['samples'] for e in events), 'all_test_artifact_hashes_verified': True,
                  'scores': {}, 'per_event': per_event}
        for maskname, horizons in pooled.items():
            report['scores'][maskname] = {}
            for h, parts in horizons.items():
                arrays = [np.concatenate([p[i] for p in parts]) for i in range(5)]
                parts.clear()
                m = metrics(arrays[0], dict(zip(['model', 'persistence', 'dilation', 'history_dilation'], arrays[1:])))
                m['paired_event_ap_group_bootstrap'] = {
                    b: paired_groups(per_event[maskname][h], b) for b in ['persistence', 'dilation', 'history_dilation']}
                report['scores'][maskname][h] = m
                del arrays
        report['seconds'] = round(time.monotonic() - started, 1)
        (a.out / 'results.json').write_text(json.dumps(report, indent=2) + '\n')
        print(json.dumps({'finished': True, 'seconds': report['seconds'], 'out': str(a.out)}), flush=True)


if __name__ == '__main__':
    main()
