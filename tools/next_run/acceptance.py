"""Prospective evidence gate. Consumes results; never opens tensors or trains."""
from __future__ import annotations
import argparse
import json
from pathlib import Path
import re
import numpy as np
from .common import HORIZONS, file_hash, write_json

POLICY = {
    "schema": "thermal-acceptance-v1", "minimum_seeds": 3,
    "minimum_geographic_groups": 10, "bootstrap_draws": 2000,
    "confidence": .95, "maximum_false_positive_rate_at_05": .01,
    "maximum_brier_regression": 0.0,
    "scope": "research thermal forecast only; not physical fire arrival or road safety",
}


def is_hash(value):
    return isinstance(value, str) and re.fullmatch(r"[a-f0-9]{64}", value) is not None


def probability(value):
    return isinstance(value, (float, int)) and not isinstance(value, bool) and np.isfinite(value) and 0 <= value <= 1


def group_interval(events, field):
    groups = {}
    for e in events:
        if e.get("ap") is not None and e.get(field) is not None:
            groups.setdefault(e["group"], []).append(e["ap"] - e[field])
    # Preserve the frozen trainer's event/group order for identical resamples.
    values = np.asarray([np.mean(v) for v in groups.values()])
    if len(values) < 2:
        return len(values), None
    draws = np.random.default_rng(0).choice(values, (POLICY["bootstrap_draws"], len(values)), replace=True).mean(1)
    return len(values), np.quantile(draws, [.025, .975]).tolist()


def valid_events(events):
    if not isinstance(events, list) or not events:
        return False
    seen = set()
    for e in events:
        if not isinstance(e, dict) or not isinstance(e.get("event"), str) or e["event"] in seen:
            return False
        seen.add(e["event"])
        if not isinstance(e.get("group"), str) or not e["group"] or type(e.get("positives")) is not int or e['positives'] < 0:
            return False
        values = [e.get(k) for k in ["ap", "persistence_ap", "dilation_ap"]]
        if e["positives"] > 0 and not all(probability(v) for v in values):
            return False
        if e["positives"] == 0 and any(v is not None for v in values):
            return False
    return True


def assess(reports, protocol):
    reasons, checks = [], []
    if protocol.get("schema") != "thermal-evaluation-protocol-v1":
        reasons.append("missing evaluation protocol")
    if protocol.get("policy") != POLICY:
        reasons.append("protocol does not freeze this acceptance policy")
    if not is_hash(protocol.get("manifest_sha256")):
        reasons.append("invalid dataset identity")
    seeds = protocol.get("seeds", [])
    if not isinstance(seeds, list) or any(type(s) is not int or s < 0 for s in seeds):
        reasons.append("invalid seeds")
        seeds = []
    if len(set(seeds)) < POLICY["minimum_seeds"] or len(set(seeds)) != len(seeds):
        reasons.append("fewer than three distinct predeclared training seeds")
    candidates = protocol.get("candidates", [])
    if not isinstance(candidates, list) or any(not isinstance(c, dict) or not is_hash(c.get("checkpoint_sha256")) or type(c.get("seed")) is not int for c in candidates):
        reasons.append("invalid frozen candidates")
        candidates = []
    expected = {c["checkpoint_sha256"] for c in candidates}
    if len(candidates) != len(seeds) or {c["seed"] for c in candidates} != set(seeds):
        reasons.append("frozen candidate list does not cover declared seeds")
    if len(expected) != len(candidates):
        reasons.append("duplicate checkpoint identities")
    if {r.get("checkpoint_sha256") for r in reports} != expected or len(reports) != len(expected):
        reasons.append("results do not cover exactly the frozen candidates")
    if any(r.get("manifest_sha256") != protocol.get("manifest_sha256") for r in reports):
        reasons.append("mixed dataset identities")
    if not reports:
        reasons.append("no final evaluation results")
    for r in reports:
        for h in map(str, HORIZONS):
            s = r.get("scores", {}).get(h)
            if not isinstance(s, dict):
                reasons.append(f"missing horizon {h}")
                continue
            events = s.get("per_event")
            if not valid_events(events):
                reasons.append(f"{h}h invalid or duplicate event scores")
            else:
                for field in ["persistence_ap", "dilation_ap"]:
                    count, ci = group_interval(events, field)
                    ok = count >= POLICY["minimum_geographic_groups"] and ci is not None and ci[0] > 0
                    checks.append(dict(checkpoint=r.get("checkpoint_sha256"), horizon=h, baseline=field, groups=count, interval=ci, passed=ok))
                    if not ok:
                        reasons.append(f"{h}h improvement over {field} not established")
            brier = [s.get(k) for k in ["brier", "persistence_brier", "dilation_brier"]]
            if not all(probability(v) for v in brier) or brier[0] > min(brier[1:]) + POLICY["maximum_brier_regression"]:
                reasons.append(f"{h}h Brier regression or missing result")
            fpr = s.get("negative_cell_false_positive_rate_at_05")
            if not probability(fpr) or fpr > POLICY["maximum_false_positive_rate_at_05"]:
                reasons.append(f"{h}h false-alarm gate not met")
    return dict(schema=POLICY["schema"], decision="research_model_eligible" if not reasons else "retain_baseline",
                road_use="unsupported", reasons=sorted(set(reasons)), checks=checks,
                checkpoint_sha256=sorted(expected), candidates=candidates,
                manifest_sha256=protocol.get("manifest_sha256"), policy=POLICY,
                note="Protocol timing must be independently recorded before final-test access. This file cannot prove preregistration.")


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--protocol', type=Path, required=True)
    p.add_argument('--results', type=Path, nargs='*', default=[])
    p.add_argument('--out', type=Path, required=True)
    a = p.parse_args()
    result = assess([json.loads(f.read_text()) for f in a.results], json.loads(a.protocol.read_text()))
    result.update(protocol_sha256=file_hash(a.protocol), result_sha256=[file_hash(f) for f in a.results])
    write_json(a.out, result)
    print(result['decision'], result['reasons'])


if __name__ == '__main__':
    main()
