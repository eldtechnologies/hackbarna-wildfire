// Exercise the actual serving estimator against later detections in the real capture.
// A diagnostic on one incident: the target remains centroid motion, not a fire front.
import { readFileSync, writeFileSync } from 'node:fs';
import { causalResponse, captureTimeline, type HistoricalCapture } from '../server/providers/causal';
import { normalize } from '../server/providers/normalize';
import { growthFor } from '../server/model';
import { observedGrowth } from '../server/model/growth';
import { epoch } from '../server/providers/availability';

const capturePath=process.argv[2] ?? 'data/snapshots/los-gallardos-2026-07-09.json';
const out=process.argv[3] ?? 'data/model/serving-replay-validation.json';
const raw=JSON.parse(readFileSync(capturePath,'utf8')) as HistoricalCapture;
const scenario=raw.scenario ?? 'replay';
const timeline=captureTimeline(raw,scenario);
const start=Date.parse(timeline.start),end=Date.parse(timeline.end);
const rows:Array<{hours:number;issue:string;clusterId:string;bearingError:number;rateError:number;constantRateError:number;zeroRateError:number}>=[];
let unavailable=0;
for(let issue=start;issue+6*3_600_000<=end;issue+=3_600_000){
  const evidence=causalResponse(raw,scenario,issue);
  for(const cluster of evidence.clusters){
    const response=growthFor(cluster.id,evidence,new Date(issue))!;
    const prediction=response.baselines[0],constant=response.baselines[1];
    for(const hours of [1,3,6]){
      const targetEnd=issue+hours*3_600_000,targetStart=targetEnd-3_600_000;
      const future=raw.hotspots.filter(h=>h.properties.cluster_id===cluster.id &&
        epoch(h.properties.observed_at)!>=targetStart && epoch(h.properties.observed_at)!<targetEnd);
      const target=observedGrowth(cluster.id,normalize({hotspots:future,clusters:[],perimeters:[]},'replay',scenario).hotspots,new Date(targetEnd));
      if(prediction.bearingDeg===null || prediction.rateKmh===null || target.bearingDeg===null || target.rateKmh===null){unavailable++;continue;}
      rows.push({hours,issue:new Date(issue).toISOString(),clusterId:cluster.id,
        bearingError:Math.abs((target.bearingDeg-prediction.bearingDeg+540)%360-180),
        rateError:Math.abs(target.rateKmh-prediction.rateKmh),constantRateError:Math.abs(target.rateKmh-constant.rateKmh!),
        zeroRateError:target.rateKmh});
    }
  }
}
const mean=(a:number[])=>a.length?a.reduce((s,v)=>s+v,0)/a.length:null;
const median=(a:number[])=>{if(!a.length)return null;const s=a.toSorted((a,b)=>a-b),m=Math.floor(s.length/2);return s.length%2?s[m]:(s[m-1]+s[m])/2;};
const report={schema:'served-motion-diagnostic-v1',scenario,independentIncidents:1,
  status:'diagnostic_only',target:'future_one_hour_detection_centroid_motion',futureWindowHours:1,
  unavailableComparisons:unavailable,
  limitations:['Same event examined during development; no independent held-out performance claim.',
    'Future detections are a sensor-dependent motion proxy, not independently measured fire-front direction.',
    'Insufficient future observations are unscored, never treated as no fire.'],
  horizons:[1,3,6].map(hours=>{const r=rows.filter(x=>x.hours===hours);return {hours,comparisons:r.length,
    medianBearingErrorDeg:median(r.map(x=>x.bearingError)),rateMaeKmh:mean(r.map(x=>x.rateError)),
    constantRateMaeKmh:mean(r.map(x=>x.constantRateError)),zeroMotionRateMaeKmh:mean(r.map(x=>x.zeroRateError))};}),rows};
writeFileSync(out,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report.horizons,null,2));
