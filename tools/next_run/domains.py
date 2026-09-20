"""Shared input-only evaluation domains for NumPy and tensor batches."""
import numpy as np
import torch


def novel_masks(x, old, channels):
    observable = [i for i, name in enumerate(channels) if name.endswith('observable_fraction')]
    fire = [i for i, name in enumerate(channels) if name.endswith('fire_fraction')]
    if len(observable) != 6 or len(fire) != 6:
        raise ValueError('Expected six observation bins')
    reduce = (lambda a: a.amax(dim=-3)) if torch.is_tensor(x) else (lambda a: a.max(axis=-3))
    known = reduce(x[..., observable, :, :]) > 0
    past = reduce(x[..., fire, :, :]) > 0
    full = torch.ones_like(known) if torch.is_tensor(x) else np.ones_like(known)
    return {'full': full, 'latest_clear': known & (old == 0),
            'no_past_detection': known & ~past}, past
