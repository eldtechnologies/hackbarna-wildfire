import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SWEEP_CONFIGS, NOMINAL_ID, basisFor, sweepField } from './sweep';
import type { Detection } from './mask';
import type { LatLon } from '../../shared/fires';

// sweep.ts had no test file: its invariants were visible only through the pipeline, where
// a broken envelope shows up as a band that reads oddly rather than as a failure.

const ORIGIN = 1_000_000;
const at = (seconds: number): number => ORIGIN + seconds;

const detection = (id: string, lat: number, lon: number, seconds: number, source = 'MTG_I1'): Detection => ({
  id, lat, lon, atSeconds: at(seconds), source, confidence: 0.9, clusterId: 'fire',
});

const SEGMENT: LatLon[] = [{ lat: 37.19, lon: -1.98 }, { lat: 37.19, lon: -1.979 }];

test('the envelope contains every configuration that produced an answer', () => {
  // The invariant the band rests on, and which nothing asserted: the nominal value must
  // sit between the two ends, and neither end may come from a configuration that
  // produced nothing.
  const detections = [
    detection('a', 37.1901, -1.9801, 100),
    detection('b', 37.1902, -1.9802, 200),
    detection('c', 37.1903, -1.9803, 300, 'VIIRS_SNPP_NRT'),
  ];
  const { field } = sweepField([SEGMENT], [], detections);

  for (let i = 0; i < 1; i++) {
    const early = field.earliestCutAtSeconds[i];
    const late = field.latestCutAtSeconds[i];
    const nominal = field.nominalCutAtSeconds[i];
    assert.ok(Number.isFinite(early) && Number.isFinite(late), 'a cut segment has both ends');
    assert.ok(early <= nominal, `earliest ${early} must not be later than the nominal ${nominal}`);
    assert.ok(late >= nominal, `latest ${late} must not be earlier than the nominal ${nominal}`);
    assert.ok(field.earliestConfigId[i].length > 0 && field.latestConfigId[i].length > 0);
  }
});

test('a configuration asking to keep persistent heat really does run against the raw set', () => {
  // The finding this guards: `includeStaticHeatSources` was never read, so
  // `all-1x-withstatic` was a byte-identical copy of the nominal and the sweep advertised
  // a sensitivity check that did not exist. On the July capture the two sets happen to be
  // equal — the subtraction removes 0 of 2,660 detections — so the defect was invisible
  // there and only shows with data where they differ.
  const subtracted = [detection('real', 37.1901, -1.9801, 100)];
  const withHeat = [...subtracted, detection('flare', 37.1901, -1.9801, 50)];

  const { cutByConfig } = sweepField([SEGMENT], [], subtracted, undefined, undefined, withHeat);
  const nominal = cutByConfig.get(NOMINAL_ID)!;
  const raw = cutByConfig.get('all-1x-withstatic')!;

  assert.equal(nominal[0], at(100), 'the subtracted set must not see the flare');
  assert.equal(raw[0], at(50), 'the raw set must, because the flare is earlier');
  assert.notEqual(nominal[0], raw[0], 'the two configurations must not be the same computation');
});

test('without a raw set the flag degrades to the subtracted set rather than throwing', () => {
  const subtracted = [detection('real', 37.1901, -1.9801, 100)];
  const { cutByConfig } = sweepField([SEGMENT], [], subtracted);
  assert.equal(cutByConfig.get('all-1x-withstatic')![0], at(100));
});

test('the basis names the contributing configurations and counts only those that contributed', () => {
  const full = basisFor('all-1x', 'polar-1x');
  assert.match(full, /across 12 configurations/);
  assert.match(full, /earliest from all sensors, sensor footprint/);

  const partial = basisFor('all-1x', 'polar-1x', 9);
  assert.match(partial, /across 9 of 12 configurations/);
  assert.match(partial, /3 never close this route inside the window/,
    'a configuration that contributes nothing must be named as such, not silently dropped');
});

test('every configuration is identified, labelled and distinct', () => {
  const ids = SWEEP_CONFIGS.map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length, 'configuration ids must be unique');
  for (const config of SWEEP_CONFIGS) {
    assert.ok(config.label.length > 0, `${config.id} needs a label a reader can act on`);
    assert.ok(config.radiusScale > 0);
  }
  assert.ok(ids.includes(NOMINAL_ID), 'the nominal configuration must be in the sweep');
});
