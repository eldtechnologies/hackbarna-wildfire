"""Load only hash-verified source copies, and verify the fixed paired inputs."""
from contextlib import contextmanager
import hashlib
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import uuid

EVIDENCE = Path(__file__).resolve().parents[2] / 'docs/validation'


def checked_bytes(path, expected):
    data = Path(path).read_bytes()
    if hashlib.sha256(data).hexdigest() != expected:
        raise ValueError(f'Frozen identity mismatch: {path}')
    return data


@contextmanager
def frozen_trainer(root):
    # Import from a private copy, not the caller's sys.path. Sibling source,
    # package initializers, bytecode and native modules cannot bypass the lock.
    lock = json.loads((EVIDENCE / 'trainer-source-lock.json').read_text())
    namespace = '_frozen_trainer_' + uuid.uuid4().hex
    with tempfile.TemporaryDirectory(prefix='wildfire-trainer-') as directory:
        package = Path(directory)
        for filename, expected in lock.items():
            data = checked_bytes(Path(root) / 'tools/next_run' / filename, expected)
            (package / filename).write_bytes(data)
        spec = importlib.util.spec_from_file_location(namespace, package / '__init__.py',
                                                      submodule_search_locations=[str(package)])
        module = importlib.util.module_from_spec(spec)
        sys.modules[namespace] = module
        try:
            spec.loader.exec_module(module)
            yield namespace
        finally:
            for name in list(sys.modules):
                if name == namespace or name.startswith(namespace + '.'):
                    del sys.modules[name]


def paired_inputs(run, archive):
    lock = json.loads((EVIDENCE / 'deepfire-paired/SHA256SUMS.json').read_text())
    protocol = json.loads(checked_bytes(run / 'protocol.json', lock['protocol.json']))
    rows = json.loads(checked_bytes(run / 'eligible.json', lock['eligible.json']))
    identities = [row['id'] for row in rows]
    if len(identities) != len(set(identities)) or identities != protocol['eligible_simulation_ids']:
        raise ValueError('Eligible cases differ from the frozen protocol')
    for name, expected in lock.items():
        if name.startswith('weather/'):
            checked_bytes(run / name, expected)
    for identity in identities:
        filename = identity + '-simulation.json'
        checked_bytes(archive / filename, lock['simulations/' + filename])
    return protocol, rows


def load_checkpoint(path):
    import torch
    return torch.load(path, map_location='cpu', weights_only=True)
