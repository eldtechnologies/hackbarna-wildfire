"""Audit frozen split metadata and challenge raw input construction with future data."""
from __future__ import annotations

import argparse
from collections import Counter
import itertools
import json
from pathlib import Path

import numpy as np
import pandas as pd

from tools.next_run.common import SIZE, file_hash
from tools.next_run.inputs import InputFrame
from tools.next_run.quality import Quality
from tools.next_run.weather import Weather
from tools.next_run.terrain import Terrain


class PoisonUnavailable(Quality):
    def __init__(self, archive, issue):
        super().__init__(archive)
        self.issue = issue
        self.poisoned = 0
        self.reads = 0

    def patch(self, stamp, row0, col0, size=64):
        q, available = super().patch(stamp, row0, col0, size)
        self.reads += 1
        if available is None or available > self.issue or pd.Timestamp(stamp) >= self.issue:
            self.poisoned += 1
            q = np.ones_like(q)  # Fabricated fire must remain unavailable to inputs.
        return q, available


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--data', type=Path, required=True)
    ap.add_argument('--out', type=Path, required=True)
    a = ap.parse_args()
    m = json.loads((a.data/'manifest.json').read_text())
    cfg = m['config']
    nonempty = [e for e in m['events'] if e['samples']]
    roles = {role: [e for e in nonempty if e['role'] == role]
             for role in ['train', 'selection', 'calibration', 'test']}
    splits = []
    for ra, rb in itertools.combinations(roles, 2):
        left, right = roles[ra], roles[rb]
        overlap_ids = sorted({e['event_id'] for e in left} & {e['event_id'] for e in right})
        overlap_groups = sorted({e['spatial_group'] for e in left} & {e['spatial_group'] for e in right})
        ref = np.array([[e['seed_row'], e['seed_col']] for e in right])
        overlap_patches = sum(int(((np.abs(ref[:, 0]-e['seed_row']) < SIZE) &
                                  (np.abs(ref[:, 1]-e['seed_col']) < SIZE)).sum()) for e in left)
        splits.append(dict(roles=[ra, rb], shared_events=overlap_ids,
                           shared_groups=overlap_groups, overlapping_patch_pairs=overlap_patches))
    times = {}
    cut = pd.Timestamp('2026-08-01T00:00:00Z')
    for role, events in roles.items():
        first, last, seed_violations, boundary_violations = [], [], 0, 0
        for e in events:
            issues = pd.to_datetime(np.load(a.data/e['file']/'issue.npy'), utc=True)
            first.append(issues.min()); last.append(issues.max())
            seed_violations += int((issues < pd.Timestamp(e['seed_available'])).sum())
            boundary_violations += int((issues < cut).sum() if role == 'test'
                                       else (issues + pd.Timedelta(hours=6) > cut).sum())
        times[role] = dict(events=len(events), samples=sum(e['samples'] for e in events),
                           geographic_groups=len({e['spatial_group'] for e in events}),
                           first_issue=str(min(first)), last_issue=str(max(last)),
                           unavailable_seed_samples=seed_violations, time_boundary_violations=boundary_violations)
    report = dict(manifest_sha256=file_hash(a.data/'manifest.json'), split_pairs=splits,
                  roles=times, raw_challenges=[], future_labels_read=False)
    a.out.parent.mkdir(parents=True, exist_ok=True)
    a.out.write_text(json.dumps(report, indent=2)+'\n')
    print(json.dumps({'split_audit': times}), flush=True)
    q = Quality(cfg['archive'])
    w = Weather(cfg['weather'])
    terrain = Terrain(cfg['static_cache'], cfg.get('existing_tiles'), allow_remote=False)
    cat = pd.read_parquet(Path(cfg['catalogue'])/'events.parquet').set_index('event_id')
    # First episode from each held-out geographic group; no selection by score/label.
    selected = {}
    for e in roles['test']:
        selected.setdefault(e['spatial_group'], e)
    for group, e in sorted(selected.items()):
        event = cat.loc[e['event_id']].to_dict(); event['event_id'] = e['event_id']
        row0, col0 = int(event['seed_row'])-SIZE//2, int(event['seed_col'])-SIZE//2
        obs = pd.read_parquet(Path(cfg['extract'])/'observations.parquet',
            columns=['ABS_LINE', 'ABS_SAMP', 'observed_at', 'scan_time', 'FRP'],
            filters=[('ABS_LINE', '>=', row0), ('ABS_LINE', '<', row0+SIZE),
                     ('ABS_SAMP', '>=', col0), ('ABS_SAMP', '<', col0+SIZE)])
        path = a.data/e['file']
        issue = pd.Timestamp(str(np.load(path/'issue.npy')[0]))
        oldx = np.load(path/'X.npy', mmap_mode='r')[0]
        oldp = np.load(path/'P.npy', mmap_mode='r')[0]
        x, p = InputFrame(event, q, w, terrain, obs).at(issue)
        # Removing every future observation must leave exactly the same inputs.
        truncated = obs[obs.observed_at < issue]
        tx, tp = InputFrame(event, q, w, terrain, truncated).at(issue)
        injected = obs.copy()
        late = injected.observed_at >= issue
        injected.loc[late, 'FRP'] = 1e9
        extra = pd.DataFrame([dict(ABS_LINE=event['seed_row'], ABS_SAMP=event['seed_col'],
                                  observed_at=issue+pd.Timedelta(minutes=5), scan_time=issue, FRP=1e9)])
        injected = pd.concat([injected, extra], ignore_index=True)
        poison = PoisonUnavailable(cfg['archive'], issue)
        px, pp = InputFrame(event, poison, w, terrain, injected).at(issue)
        r = dict(event=e['event_id'], group=group, issue=str(issue),
                 frozen_input_equal=bool(np.array_equal(x, oldx)), frozen_state_equal=bool(np.array_equal(p, oldp)),
                 future_removal_equal=bool(np.array_equal(x, tx) and np.array_equal(p, tp)),
                 future_poison_equal=bool(np.array_equal(x, px) and np.array_equal(p, pp)),
                 future_observations_poisoned=int(late.sum())+1, unavailable_quality_reads_poisoned=poison.poisoned)
        report['raw_challenges'].append(r)
        a.out.write_text(json.dumps(report, indent=2)+'\n')
        print(json.dumps(r), flush=True)
    report['passed'] = (
        all(not r['shared_events'] and not r['shared_groups'] and r['overlapping_patch_pairs'] == 0 for r in splits)
        and all(r['unavailable_seed_samples'] == 0 and r['time_boundary_violations'] == 0 for r in times.values())
        and all(all(r[k] for k in ['frozen_input_equal','frozen_state_equal','future_removal_equal','future_poison_equal'])
                and r['unavailable_quality_reads_poisoned'] > 0 for r in report['raw_challenges']))
    a.out.write_text(json.dumps(report, indent=2)+'\n')
    if not report['passed']:
        raise SystemExit('Input audit failed; inspect the report')


if __name__ == '__main__':
    main()
