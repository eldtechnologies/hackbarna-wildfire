# Training throughput without changing the experiment

The 20 September RunPod observation showed an H100 80 GB at about 4% utilization
and about 1 GB allocated. The container exposes 208 CPUs, its default PyTorch
intra/inter-op pools report 104 threads each, but `cpu.max` permits only **22.1 CPU
cores**. The active process had 234 threads and approximately 2,206% CPU use. The
cgroup had been throttled in 33,587 of 35,972 scheduling periods at the observation.
These measurements indicate CPU oversubscription; they do not by themselves identify
how every epoch's time is divided between loading, GPU work and selection scoring.

Source inspection found all DataLoaders using zero workers and unpinned memory, a
two-event mmap cache that eagerly opened X/Y/M/P despite P being unused in training,
several per-step GPU synchronization points, and calibration computing expensive
baseline data it never used. Ordinary training does **not** run the full `collect` /
`score` pipeline each epoch; it runs six-hour selection AP. That distinction matters
when interpreting a low-utilization screenshot.

## Implemented for the next run

- Parent PyTorch/BLAS CPU threads default to 2; inter-op to 1. Spawned workers also
  cap their numerical thread pools at 1. Both worker count and parent threads are
  configurable; two workers are a starting setting, not a measured H100 optimum.
- Configurable prefetching, pinned CPU memory for CUDA, nonblocking transfers and
  persistent workers. Selection keeps its ordered loader across epochs. Worker RNG
  is isolated from model initialization; the weighted sampler and sequence stay intact.
- Per-process bounded lazy mmap cache, 16 events by default. X/Y/M open on demand;
  P opens only for baseline evaluation. Spawn drops inherited mappings. Checksums
  are verified in the parent before loaders start; workers do not rehash the dataset.
- Empty masks are checked before GPU transfer and still skip optimizer updates.
  Epoch loss is accumulated as a detached double scalar, avoiding per-step CPU
  conversion while retaining the previous summation precision. Numerical-failure
  checks and the stable log-survival loss remain in place.
- Calibration-only collection keeps the same y/p arrays and sampling procedure but
  skips persistence, distance transforms and novelty masks. Its fitted coefficients
  match the full collector in regression tests.
- Each epoch reports training time, loader wait, examples/second, selection time,
  and selection loading/inference/AP components. Initialization/checksum and calibration
  time are separate. New checkpoints freeze transitive runtime source hashes too.
- `train --checkpoint ...` is explicitly rejected. It previously accepted and ignored
  the option. Neither old nor new best/frozen weights are an exact-resume checkpoint.

There is no change to model architecture, targets, masks, float32 compute, optimizer,
class weighting, sampler distribution, six-hour whole-episode AP selection, evaluation
frequency or calibration. AMP/BF16, larger batches, compilation and different learning
rates remain separate measured experiments, not bundled accuracy-changing shortcuts.

## Evidence and its limits

The committed local benchmark uses real full-v1 **train** inputs, 128 selected episodes,
64 measured batches of 16 after eight warmup batches, and two CPU threads on macOS
ARM. Selected files are verified/read before all variants, and the legacy variant
is repeated after the optimized cases. It tests both the same sampled index sequence
and warm-cache conditions. See `data/model/throughput-local.json` for measured rates.

A separate short CPU update probe uses real train data, identical initialization and
sample indices, and checks complete model-parameter hashes plus selection AP after
four updates (one warmup, three measured). All implementations match exactly. Its
small timing figures are **not** an epoch-speed claim. Synthetic tests also cover
worker counts 0/2, multiple batch sizes, two-epoch ordering, missing/negative masks,
calibration sampling and invalid checkpoint continuation.

The local loader improvement does not establish H100 end-to-end speedup. Run the
bounded probe on an **idle** pod before a new run; compare worker counts and phase
times, including startup. Do not add a competing GPU benchmark to an active run and
then treat the timings as isolated performance measurements.

```bash
# Existing frozen data is read only. Use a new output filename for each probe.
OMP_NUM_THREADS=2 MKL_NUM_THREADS=2 OPENBLAS_NUM_THREADS=2 \
python -m tools.next_run.benchmark --data /workspace/full-v1 \
  --out /workspace/bench-loader.json --phase loader --device cuda \
  --steps 64 --warmup 8 --events 128 --workers 0 2 4 --cpu-threads 2

OMP_NUM_THREADS=2 MKL_NUM_THREADS=2 OPENBLAS_NUM_THREADS=2 \
python -m tools.next_run.benchmark --data /workspace/full-v1 \
  --out /workspace/bench-training.json --phase train --device cuda \
  --steps 32 --warmup 5 --events 128 --selection-events 8 \
  --workers 0 2 4 --cpu-threads 2
```

Use `--legacy-source /path/to/pinned/tools/next_run/train.py` for the paired legacy
comparison. The benchmark creates a disposable subset manifest with links to train
and optional selection files, never reads the final-test partition, and saves no
release weights. Record hardware, startup, sample hashes and benchmark settings with
any throughput number; small subsets and filesystem cache can change the result.

## Protect the current pilot and the double-descent question

Do not replace the active process or overwrite its source checkout. Finish its
calibration and evaluation with its original pinned trainer (`08c7bbe`), dataset and
protocol. The new trainer's final-test path intentionally rejects an older trainer's
checkpoint; inference has a narrowly audited compatibility map for identical model
and calibration definitions. A different source hash is not permission to bypass
an evaluation guard. New runs belong in a separate checkout and output directory.

An early-stopped run with patience 8 can answer which checkpoint is best under that
rule. It cannot determine whether performance recovers after substantially more
training. A double-descent experiment needs a predeclared longer epoch budget with
`--patience 0`, untouched final-test data and repeat seeds. Starting from best weights
without optimizer/sampler/RNG state is a new experiment, not an uninterrupted
continuation. Faster loading does not itself improve predictive accuracy or make
that hypothesis true.

The changes follow the relevant mechanisms in PyTorch's
[performance tuning guide](https://docs.pytorch.org/tutorials/recipes/recipes/tuning_guide.html):
asynchronous loading, pinned transfers and controlling CPU oversubscription. Actual
hardware measurements, rather than that guidance alone, must select the final settings.
