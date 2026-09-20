# Paper-informed training

The target is still **observed thermal detection within 1, 3 and 6 hours**. A better score on this task does not establish a better physical spread simulator or a safe evacuation route.

## What the paper teaches us

[Lahrichi et al., WSTS+, v3](https://arxiv.org/html/2502.12003v3) compares models under shared training and evaluation conditions. Its useful findings are joint loss/learning-rate tuning, AP-based checkpoint selection, temporal context, and testing smaller convolutional encoders. Focal loss helps their benchmark; pretraining is not uniformly beneficial. Their best headline AP is approximately 0.478 on WSTS and 0.363 on the harder WSTS+ benchmark. Large established fires can be much easier than small fires, new ignitions or displaced detections. More years of data do not automatically improve performance because distributions differ. Their training recipe uses 10,000 optimizer updates, batch size 64, AdamW and a learning-rate search. These are experimental findings to test here, not a transferable accuracy guarantee.

Our sensor, spatial resolution, horizons, target and geographic splits differ. Six ordered history bins already supply temporal information; a GRU changes how time is modeled, rather than introducing previously absent history. We do not reproduce the paper's five-day attention model in this screen.

## Corrections

- Stable cumulative-hazard BCE/focal arithmetic, including extreme false positives and false negatives. BF16 is restricted to convolutions; hazard probabilities, loss, model selection and inference use FP32.
- A shared input-only definition of new detection: no detection in any of the six historical bins and at least one observable past scan. Future unknowns remain censored. Both positive and negative candidate cells receive the same extra weight.
- Selection reports whole-episode AP for each horizon on all observable labels and on new detections. The original six-hour checkpoint is saved separately; switching metrics cannot be presented as a gain.
- Optional ResNet-18 decoder with random or ImageNet initialization. The first convolution repeats and rescales the RGB weights for the multispectral inputs; usefulness requires a matched random-initialization control.
- Exact optimizer-update budgets, atomic checkpoints, source hashes and separate calibration geography. A novel-only checkpoint cannot qualify for full-domain serving.
- Detailed selection diagnostics retain negative episodes, fixed-threshold precision/recall, persistence/distance baselines and geographic bootstrap comparisons. Legacy `new_observable_detection_*` fields explicitly remain **latest-clear**; the stricter domain is reported separately.

The previous single-horizon `selection_ap` function remains for compatibility and its phase-timed loader benchmark. That benchmark measures the old path. Use the new runs' actual training/selection times to assess the new path.

## Frozen screening design

[Protocol](paper-screen-protocol.json): six matched 4,000-update runs, seed 0, batch 64, unchanged full-v1 tensors and spatial splits. The primary selection objective is mean episode AP across horizons for new detections. Every run also retains all-label scores. The candidates isolate BCE/focal at LR 1e-3, focal at LR 1e-4, an additional factor of four on new-detection candidates, and random/pretrained ResNet-18 at LR 1e-4.

This is a shorter development screen than the paper's 10,000-update recipe. One seed and seven selection geographic groups cannot establish generalization or a winner over DeepFire. The previously inspected test set is not a fresh confirmatory holdout. This experiment does not open test tensors, change the dataset or promote a model. Promising changes need matched repeated seeds and newly reserved time/geography before making those claims.

Run on an isolated GPU worker:

```sh
python -m tools.next_run.experiment --data /workspace/full-v1 \
  --protocol docs/training/paper-screen-protocol.json --out /workspace/results
```

The worker command does not purchase or terminate cloud resources. The local controller owns that lifecycle: one uniquely named pod, no persistent volumes, maximum rate $4/hour, 90-minute lifetime including setup/retrieval, checksum-verified artifact retrieval and termination in `finally`. Do not use an existing collaborator's pod as its target.

## What training cannot supply

Our history spans three hours; weather is spatially uniform within each patch; land-cover categories are not measured fuel moisture. Satellite detections are not time-resolved burned perimeters, and native MTG cells do not resolve individual roads or advancing flame fronts. Additional fitting cannot manufacture those missing observations. Higher-resolution independent arrival/perimeter labels, fuel condition and better local weather would address different limitations than another architecture sweep.

The conservative 45-minute availability allowance also makes the latest 30-minute history bin unavailable at issue time. Replacing that allowance with measured delivery timestamps could recover recent signal, but simply reducing it without historical availability evidence would weaken the leakage controls. Persistent heat is filtered using an earlier warm-up period; that heuristic still does not turn the remaining episodes into independently confirmed wildfires.

The existing [accuracy assessment](../validation/model-accuracy-assessment.md) documents very low new-detection recall. Until that improves on suitable external evidence, the trained model remains a research probability layer alongside physical simulation.

## Implementation references

[Authors' source](https://github.com/slahrichi/WildfireSpreadTS), inspected at `ed221d491fe2142a4b2e93462c2c0b7a1c7c31ad`; [torchvision focal-loss convention](https://docs.pytorch.org/vision/stable/generated/torchvision.ops.sigmoid_focal_loss.html). Our positive class weight is an explicit odds weight, separate from the focal exponent. It must not be substituted into torchvision's alpha parameter. The authors first normalize `w` to `w/(1+w)`, then pass `alpha=1-w/(1+w)`. At the checked-in `w=236`, this gives a positive/negative ratio of `1/236`, not a negative alpha. That differs from our positive odds weight of 50. The separate [source-weight follow-up](paper-source-weight-protocol.json) tests focal weights 1 and 1/236 against the original focal-50 control, without rewriting the original experiment. The published paper and checked-in defaults alone do not establish the configuration of every reported run.
