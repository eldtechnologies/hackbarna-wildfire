/** Native-grid thermal forecasts. This contract deliberately has no road-cut time. */
export const NATIVE_GEOSTATIONARY_PROJ4 = '+proj=geos +lon_0=0 +h=35786400 +x_0=0 +y_0=0 +ellps=GRS80 +units=m +no_defs';

export interface ThermalForecast {
  schema: 'thermal-forecast-v1';
  target: 'observed_thermal_detection_within_horizon';
  eventId: string;
  issuedAt: string;
  generatedAt: string;
  predictor: 'model' | 'persistence';
  status: 'forecast' | 'insufficient_observations';
  deployment: 'research_only';
  roadUse: 'unsupported';
  fallbackReason: string | null;
  grid: {
    projection: 'geostationary';
    proj4: typeof NATIVE_GEOSTATIONARY_PROJ4;
    width: 64;
    height: 64;
    row0: number;
    col0: number;
    /** Projected pixel CENTRES: x0, dx, row-x, y0, col-y, dy, metres. */
    centreTransform: [number, number, number, number, number, number];
    order: 'row_major_north_to_south';
  };
  horizons: Array<{ hours: 1 | 3 | 6; validUntil: string; probability: number[] | null }>;
  coverage: {
    /** Mean fraction observed across the past 3 hours, never a future label mask. */
    observedFraction: number[];
    terrainValidFraction: number;
    weatherValid: number[];
    historyStart: string;
    /** Scan-time bin, not an exact receipt time. */
    latestObservableBin: { start: string; end: string } | null;
    availabilityPolicy: string;
    stale: boolean;
  };
  identity: {
    datasetSha256: string;
    inputSha256: string;
    checkpointSha256: string | null;
    trainerSha256: string | null;
    calibrationSha256: string | null;
    producerSha256: string;
    acceptanceSha256: string | null;
  };
  uncertainty: {
    calibration: 'held_out_regions' | 'uncalibrated';
    epistemic: 'not_estimated';
    interpretation: 'conditional_on_label_observability';
  };
  limitations: string[];
}
