"""Detailed development-set diagnostics; never opens the final-test tensors."""
import argparse
import json
from pathlib import Path

import torch
from threadpoolctl import threadpool_limits

from .common import CHANNELS, file_hash, write_json
from .loading import LoaderOptions, make_loader
from .train import FireDataset, build_model, collect, score, training_sources


def main():
    parser=argparse.ArgumentParser(__doc__)
    parser.add_argument('--data',type=Path,required=True)
    parser.add_argument('--checkpoint',type=Path,required=True)
    parser.add_argument('--out',type=Path,required=True)
    parser.add_argument('--device',default='cuda')
    args=parser.parse_args()
    if args.out.exists():raise FileExistsError('Use a new diagnostic output')
    torch.set_num_threads(2)
    saved=torch.load(args.checkpoint,map_location=args.device,weights_only=True)
    if saved['manifest_sha256']!=file_hash(args.data/'manifest.json'):
        raise ValueError('Checkpoint/dataset mismatch')
    if saved['runtime_sources']!=training_sources():raise ValueError('Training source changed')
    model=build_model(len(CHANNELS),saved['model_config']).to(args.device)
    model.load_state_dict(saved['state'])
    dataset=FireDataset(args.data,'validation','selection')
    options=LoaderOptions(workers=2,pin_memory=args.device.startswith('cuda'))
    report=dict(split='selection',exploratory=True,final_test_evaluated=False,
                checkpoint_sha256=file_hash(args.checkpoint),
                novel_definition='no_past_detection_and_any_observed_history',
                checkpoint_selection=saved['selection_metrics'],domains={})
    with threadpool_limits(limits=2):
        for domain in ['all','novel']:
            records=collect(model,dataset,args.device,64,saved['calibration'],
                            loader=make_loader(dataset,64,options),target=domain)
            report['domains'][domain]=score(records)
            del records
    write_json(args.out,report)


if __name__=='__main__':main()
