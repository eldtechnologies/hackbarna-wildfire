"""Fire-balanced uncertainty for committed baseline fixtures; no model fitting."""
from __future__ import annotations
import argparse
from collections import defaultdict
import json
from pathlib import Path
import numpy as np
from .harness import State,pairs_of,circular_error_deg,MAX_GAP_HOURS


def interval(values):
    a=np.asarray(values,dtype=float)
    if not len(a):return dict(fires=0,mean=None,bootstrap95=None)
    ci=None
    if len(a)>1:
        draws=np.random.default_rng(0).choice(a,(2000,len(a)),replace=True).mean(axis=1)
        ci=np.quantile(draws,[.025,.975]).tolist()
    return dict(fires=len(a),mean=float(a.mean()),bootstrap95=ci)


def evaluate(path,max_gap):
    states=[State(**s) for s in json.loads(path.read_text())['states']]
    errors=defaultdict(lambda:defaultdict(list))
    for a,b in pairs_of(states,max_gap):
        if a.bearing_deg is not None and b.bearing_deg is not None:
            errors['bearing_error_deg'][a.fire].append(circular_error_deg(b.bearing_deg,a.bearing_deg))
        if a.rate_kmh is not None and b.rate_kmh is not None:
            errors['rate_absolute_error_kmh'][a.fire].append(abs(b.rate_kmh-a.rate_kmh))
        if b.area_ha>0:
            errors['area_absolute_percentage_error'][a.fire].append(100*abs(b.area_ha-a.area_ha)/b.area_ha)
    return dict(fixture=path.name,max_gap_hours=max_gap,
                metrics={k:interval([np.mean(v) for v in groups.values()]) for k,groups in errors.items()})


def main():
    p=argparse.ArgumentParser();p.add_argument('--fixtures',type=Path,default=Path('data/model'));p.add_argument('--out',type=Path,required=True)
    a=p.parse_args();rows=[evaluate(a.fixtures/f'fixture-{name}.json',MAX_GAP_HOURS) for name in ['PT-FireSprd','FireSpread_MedEU']]
    # Match the primary harness's interval filters, never select a gap using the score.
    a.out.parent.mkdir(parents=True,exist_ok=True)
    a.out.write_text(json.dumps(dict(target='offline_corpus_persistence',aggregation='mean of per-fire mean errors',
          bootstrap_unit='fire',bootstrap_draws=2000,seed=0,
          limitation='Does not validate the online hotspot centroid estimator. MedEU rates are representative-point drift, not frontal speed.',rows=rows),indent=2)+'\n')
    print(a.out)


if __name__=='__main__':main()
