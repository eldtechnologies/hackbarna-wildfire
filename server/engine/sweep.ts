// The assumption sweep, and the confidence band it produces.
//
// The spike's published cut time for the Bédar exit road was 19:38 CEST at a 200 m
// buffer, 21:18 at 100 m, and 00:03 on polar data alone, and it treated that spread as
// a weakness. It is the answer. What ships is the band, plus the name of the
// configuration that produced each end, so a reader can argue with a specific choice
// rather than with a number that hides which choices were made.
//
// Each configuration exists to answer a question someone will actually ask:
//
//   * which sensors do you trust?       -> the source sets
//   * how far can the fire be from a detection? -> the radius scales
//   * what about weak detections?       -> the confidence floor
//   * how fragile is this really?       -> the 100 m worst case
//
// The band is the envelope of whole solves, not the per-segment extremes. A per-segment
// mixture is attained by no configuration at all, and because this is a bottleneck
// problem its pessimism is contagious: one edge that is early under some configuration
// drags a whole route down even when that route was fine under every single one.

import type { LatLon } from '../../shared/fires';
import type { Detection, SweepConfig } from './mask';
import { buildPairIndex, cutField, maxRadiusAcross } from './mask';
import { DEFAULT_LATENCY_SECONDS } from './time';

/**
 * The configuration whose numbers are reported as the headline. Chosen to be defensible
 * rather than flattering: every sensor, the sensor's own footprint, no filtering.
 */
export const NOMINAL_ID = 'all-1x';

export const SWEEP_CONFIGS: SweepConfig[] = [
  // Source sets at the nominal radius.
  { id: 'all-1x', label: 'all sensors, sensor footprint', sources: 'all', radiusScale: 1, minConfidence: null, includeStaticHeatSources: false },
  { id: 'all-0.5x', label: 'all sensors, half footprint', sources: 'all', radiusScale: 0.5, minConfidence: null, includeStaticHeatSources: false },
  { id: 'all-2x', label: 'all sensors, double footprint', sources: 'all', radiusScale: 2, minConfidence: null, includeStaticHeatSources: false },
  { id: 'geopolar-1x', label: 'geostationary + polar, sensor footprint', sources: 'geo+polar', radiusScale: 1, minConfidence: null, includeStaticHeatSources: false },
  { id: 'geopolar-2x', label: 'geostationary + polar, double footprint', sources: 'geo+polar', radiusScale: 2, minConfidence: null, includeStaticHeatSources: false },
  // The axis that actually moves the answer: dropping the 10-minute geostationary layer.
  { id: 'geo-1x', label: 'geostationary only, sensor footprint', sources: 'geo', radiusScale: 1, minConfidence: null, includeStaticHeatSources: false },
  { id: 'geo-2x', label: 'geostationary only, double footprint', sources: 'geo', radiusScale: 2, minConfidence: null, includeStaticHeatSources: false },
  { id: 'polar-1x', label: 'polar only, sensor footprint', sources: 'polar', radiusScale: 1, minConfidence: null, includeStaticHeatSources: false },
  { id: 'polar-2x', label: 'polar only, double footprint', sources: 'polar', radiusScale: 2, minConfidence: null, includeStaticHeatSources: false },
  // Perturbations of the nominal, each answering one question.
  { id: 'all-1x-highconf', label: 'all sensors, HIGH confidence only', sources: 'all', radiusScale: 1, minConfidence: 0.9, includeStaticHeatSources: false },
  { id: 'all-1x-withstatic', label: 'all sensors, persistent heat NOT removed', sources: 'all', radiusScale: 1, minConfidence: null, includeStaticHeatSources: true },
  // The spike's own most fragile configuration. It ships as the pessimistic end and as
  // the demonstration of why a point estimate was never defensible.
  { id: 'all-100m', label: 'all sensors, flat 100 m buffer (most fragile)', sources: 'all', radiusScale: 1, minConfidence: null, includeStaticHeatSources: false, fixedRadiusM: 100 },
];

export interface BandedField {
  /** Cut times under the nominal configuration, seconds since origin. */
  nominalCutAtSeconds: number[];
  nominalEvidence: string[][];
  /** The nominal configuration's detections that reached a road, by id. See `CutField`. */
  nominalUsedDetectionIds: string[];
  /** Earliest and latest cut per segment across the whole sweep. */
  earliestCutAtSeconds: number[];
  latestCutAtSeconds: number[];
  /** Which configuration produced each extreme, for the basis string. */
  earliestConfigId: string[];
  latestConfigId: string[];
  /**
   * Per segment, how many configurations produced a finite cut inside the window.
   *
   * The basis string has to report this, for the same reason the route band does: a
   * configuration that never closes a segment contributes nothing to its band, and
   * claiming all twelve while a third of them stood down overstates the evidence behind
   * the number. Measured on the committed capture, fewer than twelve configurations cut
   * most segments.
   */
  contributorCount: number[];
}

/**
 * Run every configuration over one pair index.
 *
 * The pair index is built once at the largest radius any configuration uses, so the
 * expensive distance measurements happen once and each configuration is a filter over
 * the resulting list.
 */
export interface SweepResult {
  field: BandedField;
  /** Each configuration's own cut field, kept so a solve can use the right one. */
  cutByConfig: Map<string, Float64Array>;
  /** Each configuration's node cut field, for destination deadlines. */
  nodeCutByConfig: Map<string, Float64Array>;
  /**
   * Per configuration, the delivery latency of the detection that set each segment's cut.
   *
   * Kept per configuration because it is not the same detection. Applying one
   * configuration's latency to another's cuts was wrong on 39-75% of cut edges in
   * measurement, and it moves the published band — and therefore the verdict — in a way
   * that is not always toward caution.
   */
  latencyByConfig: Map<string, Float64Array>;
  usedByConfig: Map<string, number>;
}

export function sweepField(
  segments: LatLon[][],
  nodes: LatLon[],
  detections: Detection[],
  configs: SweepConfig[] = SWEEP_CONFIGS,
  latencyOf: (source: string) => number = () => DEFAULT_LATENCY_SECONDS,
  /**
   * The detection set for a configuration that asks to keep persistent heat in the mask.
   *
   * Subtraction normally happens once, before the sweep, so a configuration carrying
   * `includeStaticHeatSources: true` had nothing to act on and was bit-identical to the
   * nominal one — the sweep advertised a sensitivity check that did not exist, and the
   * configuration list published over the API claimed it. Where this is supplied, that
   * configuration really does run against the unsubtracted set.
   */
  withStaticHeat?: Detection[],
): SweepResult {
  const total = segments.length + nodes.length;
  const nodePolylines: LatLon[][] = nodes.map((n) => [n]);
  const maxRadius = maxRadiusAcross(configs);
  const pairs = buildPairIndex([...segments, ...nodePolylines], detections, maxRadius);
  // A configuration may run against a different detection set, so the pair index has to
  // cover that set too. The two sets normally differ by nothing, and when they differ it
  // is by the handful of detections that sit on known persistent heat.
  const altPairs =
    withStaticHeat !== undefined && withStaticHeat.length !== detections.length
      ? buildPairIndex([...segments, ...nodePolylines], withStaticHeat, maxRadius)
      : null;
  const sourceById = new Map(detections.map((d) => [d.id, d.source]));
  for (const d of withStaticHeat ?? []) sourceById.set(d.id, d.source);

  const earliest = new Array<number>(segments.length).fill(Number.POSITIVE_INFINITY);
  const latest = new Array<number>(segments.length).fill(Number.NEGATIVE_INFINITY);
  const earliestConfig = new Array<string>(segments.length).fill('');
  const latestConfig = new Array<string>(segments.length).fill('');
  // How many configurations produced a finite cut for each segment.
  const contributors = new Array<number>(segments.length).fill(0);
  const cutByConfig = new Map<string, Float64Array>();
  const nodeCutByConfig = new Map<string, Float64Array>();
  const latencyByConfig = new Map<string, Float64Array>();
  const usedByConfig = new Map<string, number>();

  let nominalCut = new Array<number>(segments.length).fill(Number.POSITIVE_INFINITY);
  let nominalEvidence: string[][] = Array.from({ length: segments.length }, () => []);
  let nominalUsedDetectionIds: string[] = [];

  for (const config of configs) {
    const useRaw = config.includeStaticHeatSources && altPairs !== null;
    const all = cutField(
      useRaw ? altPairs : pairs,
      useRaw ? withStaticHeat! : detections,
      total,
      config,
    );
    const cut = all.cutAtSeconds.slice(0, segments.length);
    cutByConfig.set(config.id, Float64Array.from(cut));
    nodeCutByConfig.set(config.id, Float64Array.from(all.cutAtSeconds.slice(segments.length)));
    usedByConfig.set(config.id, all.usedDetections);

    // The latency of the detection that actually set each cut under THIS configuration.
    const latency = new Float64Array(total);
    for (let i = 0; i < total; i++) {
      const first = all.evidenceDetectionIds[i]?.[0];
      latency[i] = first === undefined ? DEFAULT_LATENCY_SECONDS : latencyOf(sourceById.get(first) ?? '');
    }
    latencyByConfig.set(config.id, latency);

    if (config.id === NOMINAL_ID) {
      nominalCut = cut;
      nominalEvidence = all.evidenceDetectionIds.slice(0, segments.length);
      nominalUsedDetectionIds = all.usedDetectionIds;
    }

    for (let i = 0; i < segments.length; i++) {
      const c = cut[i];
      if (c === Number.POSITIVE_INFINITY) continue;
      contributors[i] += 1;
      if (c < earliest[i]) {
        earliest[i] = c;
        earliestConfig[i] = config.id;
      }
      if (c > latest[i]) {
        latest[i] = c;
        latestConfig[i] = config.id;
      }
    }
  }

  return {
    field: {
      nominalCutAtSeconds: nominalCut,
      nominalEvidence,
      nominalUsedDetectionIds,
      earliestCutAtSeconds: earliest,
      latestCutAtSeconds: latest,
      earliestConfigId: earliestConfig,
      latestConfigId: latestConfig,
      contributorCount: contributors,
    },
    cutByConfig,
    nodeCutByConfig,
    latencyByConfig,
    usedByConfig,
  };
}

/**
 * Human-readable description of what was swept, printed beside every band.
 *
 * `contributors` is the number of configurations that actually produced a finite answer
 * for this band. It has to be passed in and reported, because a configuration under which
 * the route is never cut contributes Infinity and used to be dropped silently — so the
 * string claimed all twelve while the band was built from fewer. A provenance line that
 * overstates the evidence is worse than no line.
 */
export function configLabel(id: string): string {
  return SWEEP_CONFIGS.find((c) => c.id === id)?.label ?? id;
}

export function basisFor(earliestId: string, latestId: string, contributors?: number): string {
  const label = configLabel;
  const total = SWEEP_CONFIGS.length;
  const scope =
    contributors === undefined || contributors >= total
      ? `across ${total} configurations`
      : `across ${contributors} of ${total} configurations (${total - contributors} never close this route inside the window)`;
  if (earliestId === latestId) return `all contributing configurations agree (${label(earliestId)}); ${scope}`;
  return `earliest from ${label(earliestId)}; latest from ${label(latestId)}; ${scope}`;
}
