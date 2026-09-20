from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path

SCHEMA = "mtg-next-run-v1"
SIZE = 64
HORIZONS = [1, 3, 6]
TAIL_HOURS = 6
LATENCY_MINUTES = 45
CLASSES = [10,20,30,40,50,60,70,80,90,95,100]
CHANNELS = [f"past_bin{b}_{v}" for b in range(6) for v in
            ["log_frp", "fire_fraction", "observable_fraction", "frp_measured_fraction"]]
CHANNELS += ["elevation", "slope", "aspect_sin", "aspect_cos", "terrain_valid"]
CHANNELS += [f"landcover_{c}" for c in CLASSES]
CHANNELS += [f"forecast_h{h}_{v}" for h in [0,*HORIZONS] for v in
             ["wind_east", "wind_north", "temperature", "humidity", "precipitation",
              "wind_east_valid", "wind_north_valid", "temperature_valid", "humidity_valid", "precipitation_valid"]]
CHANNELS += ["offset_east", "offset_north", "distance_from_observed_fire", "has_observed_fire", "hour_sin", "hour_cos"]


def validation_role(group):
    return "selection" if int(digest(["calibration-v1",group])[:8],16)%2 == 0 else "calibration"


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, default=str).encode()).hexdigest()


def write_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(value, indent=2, sort_keys=True, default=str) + "\n")
    os.replace(tmp, path)


def file_hash(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for b in iter(lambda: f.read(4 * 1024 * 1024), b""):
            h.update(b)
    return h.hexdigest()
