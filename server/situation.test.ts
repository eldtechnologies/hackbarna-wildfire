import test from 'node:test';
import assert from 'node:assert/strict';
import {situationFacts,getSituation} from './situation';
import {threatsCacheKey} from './threats';
import type {FiresResponse} from '../shared/fires';
import {ReplayProvider} from './providers/replay';

test('situation uses actual evidence time and always distinguishes missing data from no matches',async()=>{
  const fires=await new ReplayProvider().getFires();
  const report=await getSituation(fires.clusters[0].id);
  assert.ok(report);
  assert.equal(report.packet.evidenceAsOf,fires.asOf);
  assert.equal(report.packet.availabilityPolicy,fires.availability?.policy);
  assert.match(report.summary,/not evacuation orders or road-access decisions/);
  const packet=structuredClone(report.packet);packet.threats=[];
  packet.infrastructureStatus={state:'unavailable',loadedFiles:[],failedFiles:['towns.geojson'],rejectedFeatures:0};
  packet.infrastructureCoverage={label:'test coverage',bbox:[0,40,3,43]};
  const unavailable=situationFacts(packet).map(f=>f.text).join(' ');
  assert.match(unavailable,/Infrastructure data unavailable/);
  assert.doesNotMatch(unavailable,/No bundled infrastructure/);
  packet.infrastructureStatus.state='available';
  assert.match(situationFacts(packet).find(f=>f.id==='threats')!.text,/No bundled infrastructure/);
  packet.infrastructureCoverage=null;
  assert.match(situationFacts(packet).find(f=>f.id==='threats')!.text,/does not mean the area is safe/);
});

test('threat caching follows geometry rather than transport timestamps or cursor spellings',async()=>{
  const first=await new ReplayProvider().getFires();const id=first.clusters[0].id;
  const second=structuredClone(first);second.fetchedAt='2099-01-01T00:00:00Z';second.asOf='2026-07-11T12:00:00Z';
  assert.equal(threatsCacheKey(id,first),threatsCacheKey(id,second));
  second.clusters[0].centroid.lat+=1;
  assert.notEqual(threatsCacheKey(id,first),threatsCacheKey(id,second));
});

test('centroid screening never becomes observed containment or containment priority', async (t) => {
  const {getProvider} = await import('./providers');
  const {getInfrastructure} = await import('./infrastructure');
  const fires = await new ReplayProvider().getFires();
  const hospital = (await getInfrastructure()).assets.find(a => a.name === 'Hospital de Mataró')!;
  assert.ok(hospital);
  const cluster = {...fires.clusters[0], id: 'centroid-screening-probe', centroid: hospital.position};
  const evidence: FiresResponse = {...fires, clusters: [cluster], perimeters: [], spread: []};
  t.mock.method(getProvider(), 'getFires', async () => evidence);
  const report = await getSituation(cluster.id, 123456789);
  assert.ok(report);
  assert.equal(report.packet.hasPerimeter, false);
  assert.equal(report.packet.perimeterAreaKm2, null);
  const recommendation = report.recommendations.find(r => r.assetId === hospital.id)!;
  assert.ok(recommendation);
  assert.equal(recommendation.ring, 'inside');
  assert.equal(recommendation.priority, 2);
  assert.match(recommendation.reason, /50 m detection-centroid search disc/);
  assert.match(report.summary, /No satellite perimeter/);
  assert.match(report.summary, /within the 50 m detection-centroid search disc/);
  assert.doesNotMatch(report.summary + recommendation.reason, /inside (?:the |the observed )?(?:fire )?perimeter/);

  const {lat, lon} = hospital.position;
  evidence.perimeters.push({clusterId: cluster.id, observedAt: fires.asOf ?? null,
    partIndex: 0, partCount: 1, areaKm2: 1, polygon: [{lat:lat-.01,lon:lon-.01},{lat:lat-.01,lon:lon+.01},
      {lat:lat+.01,lon:lon+.01},{lat:lat+.01,lon:lon-.01},{lat:lat-.01,lon:lon-.01}]});
  const observed = await getSituation(cluster.id, 123456790);
  assert.ok(observed);
  assert.equal(observed.packet.hasPerimeter, true);
  assert.equal(observed.recommendations.find(r => r.assetId === hospital.id)?.priority, 1);
  assert.match(observed.summary, /inside the observed perimeter/);
});
