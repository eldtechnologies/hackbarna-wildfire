"""Execute a declared development-only comparison on an isolated worker."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor

from .common import file_hash, write_json
from .train import training_sources


def main():
    parser=argparse.ArgumentParser(__doc__)
    for name in ['data','protocol','out']:
        parser.add_argument('--'+name,type=Path,required=True)
    args=parser.parse_args()
    protocol=json.loads(args.protocol.read_text())
    if protocol['final_test_access'] is not False:raise ValueError('This runner is selection-only')
    if file_hash(args.data/'manifest.json')!=protocol['dataset_manifest_sha256']:
        raise ValueError('Unexpected data')
    args.out.mkdir(parents=True,exist_ok=False)
    write_json(args.out/'protocol.json',protocol)
    write_json(args.out/'source-lock.json',training_sources())
    env=dict(os.environ,OMP_NUM_THREADS='2',OPENBLAS_NUM_THREADS='2',MKL_NUM_THREADS='2')
    def run(spec):
        name=spec['name'];path=args.out/name
        command=[sys.executable,'-m','tools.next_run.train','train','--data',str(args.data),
                 '--out',str(path),*protocol['common_args'],*spec['args']]
        with (args.out/(name+'.log')).open('w') as log:
            result=subprocess.run(command,env=env,stdout=log,stderr=subprocess.STDOUT)
        report=dict(name=name,returncode=result.returncode)
        if result.returncode==0:
            report['summary']=json.loads((path/'summary.json').read_text())
        write_json(args.out/(name+'-status.json'),report)
        print(json.dumps(report),flush=True)
        return report
    with ThreadPoolExecutor(max_workers=protocol['concurrent_runs']) as pool:
        reports=list(pool.map(run,protocol['runs']))
    # Training jobs are finished before memory-heavy pooled diagnostics start.
    for report in reports:
        if report['returncode']:continue
        path=args.out/report['name']
        with (path/'diagnostic.log').open('w') as log:
            diagnostic=subprocess.run([sys.executable,'-m','tools.next_run.selection_report',
                '--data',str(args.data),'--checkpoint',str(path/'frozen.pt'),
                '--out',str(path/'selection-report.json')],env=env,stdout=log,stderr=subprocess.STDOUT)
        report['diagnostic_returncode']=diagnostic.returncode
    write_json(args.out/'completed.json',reports)


if __name__=='__main__':main()
