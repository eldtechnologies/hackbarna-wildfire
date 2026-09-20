"""Bounded, process-local tensor mappings and reproducible CPU data loading."""
from __future__ import annotations

from collections import OrderedDict
from collections.abc import Mapping
from dataclasses import asdict, dataclass
import os
from pathlib import Path
import random

import numpy as np
import torch
from threadpoolctl import threadpool_limits
from torch.utils.data import DataLoader


@dataclass(frozen=True)
class LoaderOptions:
    workers: int = 0
    prefetch_factor: int = 2
    pin_memory: bool = False
    persistent_workers: bool = False
    seed: int = 0

    def __post_init__(self):
        if type(self.workers) is not int or self.workers < 0:
            raise ValueError("workers must be a non-negative integer")
        if type(self.prefetch_factor) is not int or self.prefetch_factor < 1:
            raise ValueError("prefetch_factor must be a positive integer")
        if type(self.seed) is not int or not 0 <= self.seed < 2**64:
            raise ValueError("seed must be an integer in [0, 2**64)")

    def to_dict(self):
        return asdict(self)


def _seed_worker(_worker_id):
    threadpool_limits(limits=1)
    # DataLoader already seeds torch; its dedicated generator also determines
    # these seeds without advancing the model's global RNG in the parent.
    seed = torch.initial_seed() % 2**32
    np.random.seed(seed)
    random.seed(seed)


def make_loader(dataset, batch_size, options: LoaderOptions, sampler=None):
    kwargs = dict(
        batch_size=batch_size,
        sampler=sampler,
        shuffle=False,
        num_workers=options.workers,
        pin_memory=options.pin_memory,
        generator=torch.Generator().manual_seed(options.seed),
        worker_init_fn=_seed_worker,
    )
    if options.workers:
        kwargs.update(
            prefetch_factor=options.prefetch_factor,
            persistent_workers=options.persistent_workers,
            multiprocessing_context="spawn",
        )
    return DataLoader(dataset, **kwargs)


class _EventArrays(Mapping):
    _names = ("X", "Y", "M", "P")

    def __init__(self, path):
        self.path = Path(path)
        self._arrays = {}
        self._pid = os.getpid()

    def __getitem__(self, name):
        if name not in self._names:
            raise KeyError(name)
        if self._pid != os.getpid():
            self._arrays = {}
            self._pid = os.getpid()
        if name not in self._arrays:
            self._arrays[name] = np.load(
                self.path / f"{name}.npy", mmap_mode="r", allow_pickle=False,
            )
        return self._arrays[name]

    def __iter__(self):
        return iter(self._names)

    def __len__(self):
        return len(self._names)

    def __getstate__(self):
        return dict(path=self.path, _arrays={}, _pid=None)


class EventArrayCache:
    def __init__(self, root, max_events=16):
        if type(max_events) is not int or max_events < 1:
            raise ValueError("max_events must be a positive integer")
        self.root = Path(root)
        self.max_events = max_events
        self._events = OrderedDict()
        self._pid = os.getpid()

    def _ensure_process(self):
        if self._pid != os.getpid():
            self.clear()

    def __getitem__(self, filename):
        self._ensure_process()
        if filename not in self._events:
            self._events[filename] = _EventArrays(self.root / filename)
            if len(self._events) > self.max_events:
                self._events.popitem(last=False)
        self._events.move_to_end(filename)
        return self._events[filename]

    def __len__(self):
        self._ensure_process()
        return len(self._events)

    def clear(self):
        # Dropping cache references lets NumPy release unused mappings without
        # invalidating a view or mapping still held by a caller.
        self._events.clear()
        self._pid = os.getpid()

    def __getstate__(self):
        return dict(root=self.root, max_events=self.max_events,
                    _events=OrderedDict(), _pid=None)
