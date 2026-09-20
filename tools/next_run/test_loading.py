import gc
import hashlib
from pathlib import Path
import pickle
import random

import numpy as np
import pytest
import torch
from torch.utils.data import Dataset, WeightedRandomSampler

from . import loading
from .loading import EventArrayCache, LoaderOptions, make_loader


class SyntheticDataset(Dataset):
    def __init__(self, root, verification_log):
        self.root = Path(root)
        self.rows = []
        for folder in sorted(self.root.iterdir()):
            for file in folder.glob("*.npy"):
                hashlib.sha256(file.read_bytes()).hexdigest()
            count = np.load(folder / "X.npy", mmap_mode="r").shape[0]
            self.rows.extend((folder.name, sample, count) for sample in range(count))
        with Path(verification_log).open("a") as stream:
            stream.write("verified\n")
        self.cache = EventArrayCache(root, max_events=2)

    def __len__(self):
        return len(self.rows)

    def __getitem__(self, index):
        filename, sample, _ = self.rows[index]
        arrays = self.cache[filename]
        return (*(torch.from_numpy(arrays[key][sample].astype(np.float32))
                  for key in ("X", "Y", "M")), index)


@pytest.fixture
def corpus(tmp_path):
    root = tmp_path / "tensors"
    root.mkdir()
    for event, count in enumerate((2, 3, 2)):
        folder = root / str(event)
        folder.mkdir()
        x = (np.arange(count * 4 * 3 * 3).reshape(count, 4, 3, 3) / 32 + event).astype(np.float16)
        y = (np.arange(count * 3 * 3 * 3).reshape(count, 3, 3, 3) % 2).astype(np.uint8)
        m = (np.arange(y.size).reshape(y.shape) % 3 != 0)
        for name, array in dict(X=x, Y=y, M=m, P=y[:, -1]).items():
            np.save(folder / f"{name}.npy", array)
    return root


@pytest.mark.parametrize("weighted", [False, True])
def test_spawn_loading_preserves_bytes_and_order_across_epochs(corpus, tmp_path, weighted):
    log = tmp_path / "verification.log"
    dataset = SyntheticDataset(corpus, log)
    dataset[0]  # A parent mapping must not be serialized into spawned workers.
    outputs = []
    with torch.random.fork_rng():
        torch.manual_seed(91)
        state = torch.get_rng_state().clone()
        for workers in (0, 2):
            sampler = None
            if weighted:
                sampler = WeightedRandomSampler(
                    [1 / row[2] for row in dataset.rows], 23, replacement=True,
                    generator=torch.Generator().manual_seed(17),
                )
            loader = make_loader(dataset, 3, LoaderOptions(
                workers=workers, persistent_workers=True, seed=41,
            ), sampler=sampler)
            epochs = []
            for _ in range(2):
                batches = list(loader)
                epochs.append(tuple(torch.cat([batch[i] for batch in batches]) for i in range(4)))
            outputs.append(epochs)
            del loader
            gc.collect()
        assert torch.equal(torch.get_rng_state(), state)
    for serial, parallel in zip(*outputs):
        for expected, actual in zip(serial, parallel):
            assert expected.dtype == actual.dtype
            assert expected.numpy().tobytes() == actual.numpy().tobytes()
        if not weighted:
            assert parallel[-1].tolist() == list(range(len(dataset)))
        for position, index in enumerate(parallel[-1].tolist()):
            for column, expected in enumerate(dataset[index][:3]):
                assert parallel[column][position].numpy().tobytes() == expected.numpy().tobytes()
    assert log.read_text() == "verified\n"


def test_zero_workers_omits_multiprocessing_only_options(corpus, tmp_path):
    dataset = SyntheticDataset(corpus, tmp_path / "verification.log")
    options = LoaderOptions(workers=0, prefetch_factor=5, persistent_workers=True, seed=19)
    loader = make_loader(dataset, 2, options)
    assert loader.num_workers == 0
    assert loader.prefetch_factor is None
    assert loader.persistent_workers is False
    assert loader.multiprocessing_context is None
    assert loader.pin_memory is False
    assert options.to_dict() == dict(workers=0, prefetch_factor=5, pin_memory=False,
                                     persistent_workers=True, seed=19)
    list(loader)


def test_cache_is_lazy_bounded_and_does_not_close_callers(corpus, monkeypatch):
    opened = []
    original = loading.np.load

    def record(path, **kwargs):
        opened.append(Path(path))
        return original(path, **kwargs)

    monkeypatch.setattr(loading.np, "load", record)
    cache = EventArrayCache(corpus, max_events=2)
    first = cache["0"]
    assert list(first) == ["X", "Y", "M", "P"]
    assert not opened
    held = first["X"]
    assert first["X"] is held
    assert len(opened) == 1 and opened[0].name == "X.npy"
    second = cache["1"]
    assert cache["0"] is first  # Refresh event 0; event 1 must be evicted next.
    cache["2"]
    assert len(cache) == 2
    assert cache["1"] is not second
    before = held.copy()
    cache.clear()
    assert len(cache) == 0
    np.testing.assert_array_equal(held, before)
    first["P"]
    assert [path.name for path in opened] == ["X.npy", "P.npy"]
    with pytest.raises(KeyError):
        first["unexpected"]


def test_cache_pickling_drops_mmaps_and_keeps_parent_alive(corpus):
    cache = EventArrayCache(corpus)
    mapping = cache["0"]
    held = mapping["X"]
    restored = pickle.loads(pickle.dumps(cache))
    restored_mapping = pickle.loads(pickle.dumps(mapping))
    assert len(restored) == 0
    assert restored_mapping._arrays == {}
    assert cache["0"]["X"] is held
    assert restored["0"]["X"] is not held
    np.testing.assert_array_equal(restored["0"]["X"], held)
    np.testing.assert_array_equal(restored_mapping["X"], held)


def test_cache_is_process_and_instance_local(corpus, monkeypatch):
    first = EventArrayCache(corpus)
    second = EventArrayCache(corpus)
    held = first["0"]["X"]
    assert second["0"]["X"] is not held
    pid = loading.os.getpid()
    monkeypatch.setattr(loading.os, "getpid", lambda: pid + 1)
    assert len(first) == 0
    assert first["0"]["X"] is not held
    assert np.isfinite(held).all()


def test_worker_seed_is_reproducible_without_advancing_torch_rng():
    numpy_state = np.random.get_state()
    python_state = random.getstate()
    try:
        with torch.random.fork_rng():
            torch.manual_seed(45)
            state = torch.get_rng_state().clone()
            loading._seed_worker(0)
            expected = (np.random.random(), random.random())
            loading._seed_worker(0)
            assert (np.random.random(), random.random()) == expected
            assert torch.equal(torch.get_rng_state(), state)
    finally:
        np.random.set_state(numpy_state)
        random.setstate(python_state)


@pytest.mark.parametrize("kwargs", [dict(workers=-1), dict(workers=True),
                                   dict(prefetch_factor=0), dict(seed=-1)])
def test_invalid_loader_options_fail_before_worker_creation(kwargs):
    with pytest.raises(ValueError):
        LoaderOptions(**kwargs)


@pytest.mark.parametrize("capacity", [0, -1, True])
def test_invalid_cache_bound(capacity, corpus):
    with pytest.raises(ValueError):
        EventArrayCache(corpus, capacity)
