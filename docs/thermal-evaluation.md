# Prospective thermal-model acceptance

The current RunPod experiment is a **pilot until its own declared evaluation is
complete**. This change neither changes its trainer nor launches another seed, reads
its final-test labels, or approves a model based on missing results. Use the exact
pinned trainer for its final evaluation: the trainer deliberately checks code and
manifest identity. This exporter can read the frozen v1 checkpoint shape without
rewriting that run.

`tools/next_run/acceptance.py` consumes final evaluation JSON already produced by the
trainer. It never reads tensors or fits a model. `data/model/thermal-protocol.example.json`
is an unregistered template, not a claim that a protocol has already been frozen.

## Freeze before final-test access

Record the dataset manifest SHA-256, seeds, training budget, selection criterion,
calibration procedure, fixed thresholds, baselines and all final candidates in a
version-controlled protocol before looking at final-test outcomes. Predeclare seeds
before training; freeze each candidate using selection data, never by choosing the
best test score. Candidate hashes become available after training and calibration.
Record the timing of both freezes externally (for example, git commits). JSON alone
cannot prove this ordering. Account for any earlier use of the same holdout.

The proposed v1 research gate requires:

- At least three distinct predeclared seeds, with exactly the frozen checkpoint set
  evaluated. Every seed and every 1/3/6-hour horizon must pass.
- Paired improvement in event AP over **both** persistence and the trainer's fixed
  dilation baseline. Average within geographic group and bootstrap the groups
  (2,000 draws, fixed RNG seed); the 95% interval's lower endpoint must be above zero.
  At least ten groups with scored positive episodes are required. A group is a
  resampling block, not proof of physical statistical independence.
- Pooled Brier score no worse than either baseline, and negative-cell false-positive
  rate at probability 0.5 no greater than 1%. AP excludes all-negative episodes, so
  the separate negative-cell result is necessary.
- Valid, finite scores; no duplicate episode IDs; matching dataset/checkpoint identities
  and complete horizon results. Missing evidence retains the baseline.

These are **proposed research thresholds**, not scientifically universal cutoffs or
an operational false-alarm budget. Ten total test groups do not guarantee ten groups
with positive labels at every horizon. A failure is a failure; do not relax the gate
or remove a difficult group after seeing the final score. More independent incidents
and regions are preferable to repeatedly sampling pixels from the same fire. An
accepted seed is not an uncertainty ensemble, and no individual-prediction confidence
interval is inferred from an aggregate bootstrap interval.

```bash
python -m tools.next_run.acceptance \
  --protocol frozen-protocol.json \
  --results seed0-final.json seed1-final.json seed2-final.json \
  --out decision.json
```

The decision can only be `research_model_eligible` or `retain_baseline`; both carry
`road_use=unsupported`. The exporter checks it against the supplied checkpoint,
dataset and seed. Operator-owned release files are trusted provenance; there is no
cryptographic attestation of the experiment or protection against a dishonest
operator editing both artifacts and checksums.

A late-added three-seed rule cannot retroactively preregister seed 0 or undo test
access. If the current test has already influenced a change, report that result as
exploratory and reserve a new untouched period/geography for confirmation. Reusing
v1 weights for research inspection is possible; promoting them requires an honestly
recorded protocol. No additional RunPod expenditure is triggered by this tooling.

## What these tests do not establish

The scored label is observed native thermal detection, conditional on the pipeline's
censoring policy and seeded-episode selection. It does not measure all wildfire
ignitions, independent physical spread, unseen industrial heat sources, burn severity,
or road safety. Calibration bins must be inspected across coverage and geography;
a good pooled Brier score can coexist with poor rare-event reliability.

Before a claim about “better than DeepFire”, register a like-for-like comparison:
independent event references, matched issue times and available inputs, same horizon
and region, predeclared spatial/timing metrics, and failure/missing-data handling.
Report any additional information supplied to one model. DeepFire output is a
competitor's prediction, not ground truth. A model-size estimate cannot determine
which system is more accurate.

## Reproduce the serving diagnostics

```bash
node --import tsx scripts/validate-growth-replay.ts
python -m tools.model.uncertainty --out data/model/baseline-uncertainty.json
python -m tools.next_run.check_inputs --data /path/to/full-v1 --out input-parity.json
```

The first tests the actual production motion estimator on the July development
capture, reports unscorable comparisons, and makes no held-out accuracy claim. The
second uses committed corpus fixtures, the primary harness's seven-day gap filter,
and per-fire bootstrap uncertainty. The third reads only raw observations and
train/selection input arrays; it does not open test arrays or future Y/M labels.
