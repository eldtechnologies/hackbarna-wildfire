"""Detailed development-set diagnostics; never opens the final-test tensors."""
import argparse
import fcntl
import json
from pathlib import Path

import torch
from threadpoolctl import threadpool_limits

from .common import CHANNELS, file_hash, write_json
from .loading import LoaderOptions, make_loader
from .train import FireDataset, build_model, collect, score, training_sources


def evaluate(args,identity,dataset):
    torch.set_num_threads(2)
    saved=torch.load(args.checkpoint,map_location=args.device,weights_only=True)
    if saved['manifest_sha256']!=identity['manifest_sha256']:
        raise ValueError('Checkpoint/dataset mismatch')
    if saved['runtime_sources']!=identity['runtime_sources']:raise ValueError('Training source changed')
    model=build_model(len(CHANNELS),saved['model_config']).to(args.device)
    model.load_state_dict(saved['state'])
    options=LoaderOptions(workers=2,pin_memory=args.device.startswith('cuda'))
    report=dict(split='selection',exploratory=True,final_test_evaluated=False,
                checkpoint_sha256=identity['checkpoint_sha256'],identity=identity,
                novel_definition='no_past_detection_and_any_observed_history',
                checkpoint_selection=saved['selection_metrics'],domains={})
    with threadpool_limits(limits=2):
        for domain in ['all','novel']:
            records=collect(model,dataset,args.device,64,saved['calibration'],
                            loader=make_loader(dataset,64,options),target=domain)
            report['domains'][domain]=score(records)
            del records
    write_json(args.out,report)


def main():
    parser=argparse.ArgumentParser(__doc__)
    parser.add_argument('--data',type=Path,required=True)
    parser.add_argument('--checkpoint',type=Path,required=True)
    parser.add_argument('--out',type=Path,required=True)
    parser.add_argument('--device',default='cuda')
    args=parser.parse_args()
    args.out.parent.mkdir(parents=True,exist_ok=True)
    # Duplicate orchestration waits for the writer, then reuses verified output.
    with args.out.with_suffix(args.out.suffix+'.lock').open('a') as lock:
        fcntl.flock(lock,fcntl.LOCK_EX)
        identity=dict(checkpoint_sha256=file_hash(args.checkpoint),
                      manifest_sha256=file_hash(args.data/'manifest.json'),
                      runtime_sources=training_sources(),reporter_sha256=file_hash(__file__),
                      device=args.device,torch_version=str(torch.__version__))
        existing=json.loads(args.out.read_text()) if args.out.exists() else None
        if existing is not None and existing.get('identity')!=identity:
            raise FileExistsError('Existing diagnostic has different provenance; use a new output')
        # Recheck the actual selection tensor hashes even when a report is reused.
        dataset=FireDataset(args.data,'validation','selection')
        if existing is not None:
            if set(existing.get('domains',{}))!={'all','novel'}:
                raise ValueError('Incomplete diagnostic')
            print('Reused verified selection report',flush=True)
            return
        evaluate(args,identity,dataset)


if __name__=='__main__':main()
