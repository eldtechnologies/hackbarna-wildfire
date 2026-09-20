"""Numerically stable objectives and optional paper-inspired encoder.

The target remains cumulative observed thermal detection, not burned area.
New-detection eligibility depends only on previously observable inputs.
"""
from __future__ import annotations

import math
import numpy as np
import torch
from torch import nn
from .common import CHANNELS, HORIZONS
from .domains import novel_masks

def novel_candidates(x, previous):
    """Both positive and negative futures use the same input-only domain."""
    return novel_masks(x, previous, CHANNELS)[0]['no_past_detection']


def objective_mask(mask, candidates, *, target='all', novel_weight=1.0):
    if target not in ('all', 'novel'):
        raise ValueError('Unknown training target')
    if not math.isfinite(novel_weight) or novel_weight < 1:
        raise ValueError('novel_weight must be finite and at least one')
    if target == 'all' and novel_weight == 1:
        return mask
    candidate = candidates.unsqueeze(1).to(mask.dtype)
    if target == 'novel':
        return mask * candidate
    return mask * (1 + (novel_weight - 1) * candidate)


def hazard_loss(log_survival, y, mask, pos_weight, gamma=0.0, *, known_nonempty=False):
    """Weighted BCE/focal from log survival, including saturated false alarms.

    Gamma zero is exactly weighted BCE. Class weights are odds weights (not
    torchvision's alpha); the mask may contain input-dependent sample weights.
    """
    if not math.isfinite(gamma) or gamma < 0:
        raise ValueError('gamma must be finite and nonnegative')
    # FP32 hazard arithmetic is required even when convolutions use BF16.
    s = log_survival.float().clamp_max(-torch.finfo(torch.float32).tiny)
    if not bool(torch.isfinite(s).all()):
        raise ValueError('Non-finite log survival')
    if not known_nonempty and not bool(mask.any()):
        return None
    positive = -torch.log(-torch.expm1(s))
    return _reduce_loss(s, positive, y, mask, pos_weight, gamma)


def logit_hazard_loss(logits, y, mask, pos_weight, gamma=0.0, *, known_nonempty=False):
    """Stable even for false negatives whose conditional hazard underflows.

    Computing log P from log-cumulative-hazard avoids the overflowing 1/P
    derivative before the tiny sigmoid derivative can cancel it.
    """
    z = logits.float()
    if not math.isfinite(gamma) or gamma < 0 or not bool(torch.isfinite(z).all()):
        raise ValueError('Invalid logits or focal exponent')
    if not known_nonempty and not bool(mask.any()):
        return None
    log_hazard = torch.where(z < -20, z, torch.log(nn.functional.softplus(z.clamp_min(-20))))
    log_total = torch.logcumsumexp(log_hazard, dim=1)
    s = -torch.cumsum(nn.functional.softplus(z), dim=1)
    # For H<exp(-20), log(1-exp(-H))=log(H) to FP32 precision.
    log_p = torch.where(log_total < -20, log_total,
                        torch.log(-torch.expm1(s.clamp_max(-math.exp(-20)))))
    return _reduce_loss(s, -log_p, y, mask, pos_weight, gamma)


def _reduce_loss(s, positive, y, mask, pos_weight, gamma):
    cross_entropy = torch.where(y > 0, positive, -s)
    if not torch.is_tensor(pos_weight) and (not math.isfinite(pos_weight) or pos_weight <= 0):
        raise ValueError('Positive class weights must be finite and positive')
    weights = torch.as_tensor(pos_weight, device=s.device, dtype=s.dtype)
    weights = torch.where(y > 0, weights, torch.ones_like(s))
    if gamma:
        # (1-p_t)^gamma; BCE retains its corrective gradient when exp rounds.
        modulation = torch.where(y > 0, torch.exp(gamma * s), torch.exp(-gamma * positive))
        cross_entropy = cross_entropy * modulation
    loss = (cross_entropy * weights * mask).sum() / mask.sum()
    if not bool(torch.isfinite(loss)):
        raise ValueError('Non-finite loss')
    return loss


def cumulative_hazard(logits, return_log_survival=False):
    survival = -torch.cumsum(nn.functional.softplus(logits.float()), dim=1)
    return survival if return_log_survival else -torch.expm1(survival)


class DecoderBlock(nn.Sequential):
    def __init__(self, cin, cout):
        super().__init__(nn.Conv2d(cin, cout, 3, padding=1), nn.GroupNorm(8, cout), nn.SiLU(),
                         nn.Conv2d(cout, cout, 3, padding=1), nn.GroupNorm(8, cout), nn.SiLU())


class ResNetUNet(nn.Module):
    """ResNet-18 encoder and native-resolution decoder; optional ImageNet init.

    This adapts the paper's encoder experiment to 86 channels and three
    cumulative horizons. It is not a reproduction of its daily benchmark.
    """
    def __init__(self, cin, pretrained=False):
        super().__init__()
        from torchvision.models import resnet18, ResNet18_Weights
        encoder = resnet18(weights=ResNet18_Weights.IMAGENET1K_V1 if pretrained else None)
        old = encoder.conv1
        encoder.conv1 = nn.Conv2d(cin, 64, 7, stride=2, padding=3, bias=False)
        if pretrained:
            # Same repeat-and-scale adaptation used for multispectral encoders.
            with torch.no_grad():
                encoder.conv1.weight.copy_(old.weight[:, torch.arange(cin) % 3] * (3 / cin))
        encoder.fc = nn.Identity()
        self.encoder = encoder
        self.decoders = nn.ModuleList([DecoderBlock(512+256, 256), DecoderBlock(256+128, 128),
                                      DecoderBlock(128+64, 64), DecoderBlock(64+64, 32),
                                      DecoderBlock(32+cin, 32)])
        self.head = nn.Conv2d(32, len(HORIZONS), 1)

    def forward(self, x, return_log_survival=False, return_logits=False):
        e = self.encoder
        a = e.relu(e.bn1(e.conv1(x)))
        b = e.layer1(e.maxpool(a))
        c = e.layer2(b)
        d = e.layer3(c)
        z = e.layer4(d)
        for decoder, skip in zip(self.decoders, [d, c, b, a, x], strict=True):
            z = nn.functional.interpolate(z, size=skip.shape[-2:], mode='bilinear', align_corners=False)
            z = decoder(torch.cat([z, skip], dim=1))
        logits = self.head(z)
        return logits if return_logits else cumulative_hazard(logits, return_log_survival)


def operating_point(y, p, threshold):
    y = np.asarray(y, dtype=bool)
    selected = np.asarray(p) >= threshold
    tp = int((y & selected).sum())
    fp = int((~y & selected).sum())
    fn = int((y & ~selected).sum())
    tn = int((~y & ~selected).sum())
    return dict(threshold=float(threshold), tp=tp, fp=fp, fn=fn, tn=tn,
                precision=tp/(tp+fp) if tp+fp else None,
                recall=tp/(tp+fn) if tp+fn else None,
                false_positive_rate=fp/(fp+tn) if fp+tn else None)
