import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { ThermalForecast } from '../../shared/forecast';
import { NATIVE_GEOSTATIONARY_PROJ4 } from '../../shared/forecast';
import { epoch } from '../providers/availability';

interface Entry { eventId: string; issuedAt: string; file: string; sha256: string }
const probability = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x) && x >= 0 && x <= 1;
const vector = (x: unknown, n: number): x is number[] => Array.isArray(x) && x.length === n && x.every(probability);
const hash = (x: unknown): x is string => typeof x === 'string' && /^[a-f0-9]{64}$/.test(x);

export function validateForecast(v: any): ThermalForecast {
  if (v?.schema !== 'thermal-forecast-v1' || v.target !== 'observed_thermal_detection_within_horizon'
      || v.deployment !== 'research_only' || v.roadUse !== 'unsupported'
      || !['model','persistence'].includes(v.predictor) || typeof v.eventId !== 'string'
      || epoch(v.issuedAt) === null || epoch(v.generatedAt) === null) throw new Error('Invalid forecast identity or target');
  const g=v.grid;
  if (g?.width!==64 || g.height!==64 || g.projection!=='geostationary' || g.proj4!==NATIVE_GEOSTATIONARY_PROJ4
      || g.order!=='row_major_north_to_south' || !Number.isInteger(g.row0) || !Number.isInteger(g.col0)
      || g.row0 < -32 || g.col0 < -32 || g.row0 > 11103 || g.col0 > 11103
      || !Array.isArray(g.centreTransform) || g.centreTransform.length!==6 || !g.centreTransform.every(Number.isFinite)) throw new Error('Invalid forecast grid');
  const transform=[(g.col0-5567.5)*1000,1000,0,(5567.5-g.row0)*1000,0,-1000];
  if (!g.centreTransform.every((n:number,i:number)=>n===transform[i])) throw new Error('Grid transform does not match native indices');
  const coverage=v.coverage;
  if (!vector(coverage?.observedFraction,4096) || !vector(coverage.weatherValid,20)
      || !probability(coverage.terrainValidFraction) || typeof coverage.stale!=='boolean'
      || typeof coverage.availabilityPolicy!=='string') throw new Error('Invalid input coverage');
  const issue=epoch(v.issuedAt)!;
  if (epoch(coverage.historyStart)!==issue-3*3_600_000 || coverage.stale!==!coverage.observedFraction.some((n:number)=>n>0)) throw new Error('Invalid observation history');
  const bin=coverage.latestObservableBin;
  if (coverage.stale ? bin!==null : (!bin || epoch(bin.start)===null || epoch(bin.end)===null
      || epoch(bin.start)!<epoch(coverage.historyStart)! || epoch(bin.end)!>issue
      || (epoch(bin.end)!-epoch(bin.start)!)!==30*60_000)) throw new Error('Invalid observation age');
  if (v.status !== (coverage.stale ? 'insufficient_observations' : 'forecast')) throw new Error('Inconsistent observation status');
  if (!Array.isArray(v.horizons) || v.horizons.length!==3) throw new Error('Missing forecast horizons');
  for (const [i,h] of v.horizons.entries()) {
    if (h.hours!==[1,3,6][i] || epoch(h.validUntil)!==epoch(v.issuedAt)!+h.hours*3_600_000
        || (coverage.stale ? h.probability!==null : !vector(h.probability,4096))) throw new Error('Invalid horizon or probabilities');
    if (!coverage.stale && i>0 && h.probability.some((p:number,j:number)=>p<v.horizons[i-1].probability[j])) throw new Error('Nonmonotonic forecast');
  }
  if (!hash(v.identity?.datasetSha256) || !hash(v.identity.inputSha256) || !hash(v.identity.producerSha256)
      || !['held_out_regions','uncalibrated'].includes(v.uncertainty?.calibration)
      || v.uncertainty?.epistemic!=='not_estimated'
      || v.uncertainty?.interpretation!=='conditional_on_label_observability'
      || !Array.isArray(v.limitations) || !v.limitations.every((s:unknown)=>typeof s==='string')) throw new Error('Invalid forecast provenance');
  if (v.predictor==='model' && (!hash(v.identity.checkpointSha256) || !hash(v.identity.trainerSha256)
      || !hash(v.identity.calibrationSha256) || !hash(v.identity.acceptanceSha256)
      || v.fallbackReason!==null || v.uncertainty.calibration!=='held_out_regions' || coverage.stale)) throw new Error('Unaccepted model artifact');
  if (v.predictor==='persistence' && (typeof v.fallbackReason!=='string' || v.uncertainty.calibration!=='uncalibrated')) throw new Error('Unlabelled fallback');
  return v as ThermalForecast;
}

async function boundedRead(path: string, maximum: number): Promise<Buffer> {
  // All paths come from the operator-owned store and a strict content-key filename.
  const file=await open(path,'r');
  try {
    const expected=(await file.stat()).size;
    if(expected>maximum) throw new Error('Forecast artifact exceeds size limit');
    const buffer=Buffer.alloc(expected+1);
    let size=0;
    while(size<buffer.length) {
      const {bytesRead}=await file.read(buffer,size,buffer.length-size,null);
      if(!bytesRead) break;
      size+=bytesRead;
    }
    if(size!==expected) throw new Error('Forecast artifact changed while reading');
    return buffer.subarray(0,size);
  } finally { await file.close(); }
}

export class ForecastStore {
  constructor(private readonly root: string | undefined = process.env.FORECAST_DIR) {}

  private async entries(): Promise<Entry[]> {
    if (!this.root) return [];
    const value=JSON.parse((await boundedRead(resolve(this.root,'index.json'),4_000_000)).toString());
    if (value.schema!=='thermal-forecast-index-v1' || !Array.isArray(value.entries) || value.entries.length>10000
        || !value.entries.every((e:Entry)=>typeof e.eventId==='string' && epoch(e.issuedAt)!==null
          && /^[a-f0-9]{64}\.json$/.test(e.file) && hash(e.sha256))) throw new Error('Invalid forecast index');
    return value.entries;
  }

  async list(): Promise<Array<{eventId:string;issuedAt:string}>> {
    return (await this.entries()).map(({eventId,issuedAt})=>({eventId,issuedAt}));
  }

  async get(eventId:string, issue:string):Promise<ThermalForecast|null> {
    const entry=(await this.entries()).find(e=>e.eventId===eventId && epoch(e.issuedAt)===epoch(issue));
    if (!entry || !this.root) return null;
    const bytes=await boundedRead(resolve(this.root,entry.file),2_000_000);
    if (createHash('sha256').update(bytes).digest('hex')!==entry.sha256) throw new Error('Forecast checksum mismatch');
    const artifact=validateForecast(JSON.parse(bytes.toString()));
    if(artifact.eventId!==eventId || epoch(artifact.issuedAt)!==epoch(issue)) throw new Error('Forecast request mismatch');
    return artifact;
  }
}
