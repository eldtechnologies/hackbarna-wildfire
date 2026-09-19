// Replay provider: serves a cached snapshot from data/snapshots/. Snapshots
// are stored in the raw Deepfire shape so they exercise the same normalizer as
// the live path, which keeps the demo honest when keys or wifi are missing.

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { normalize, type RawFiresPayload } from './normalize';
import type { FireDataProvider, FiresResponse } from '../../shared/fires';

const SNAPSHOTS_DIR = path.resolve(process.cwd(), 'data/snapshots');
// Default scenario: the real Los Gallardos fire, 9-11 Jul 2026, captured from the
// Deepfire API. The previous default (castelltallat-2025.json) was synthetic.
const SNAPSHOT_FILE = process.env.REPLAY_SNAPSHOT ?? 'los-gallardos-2026-07-09.json';

interface SnapshotFile extends RawFiresPayload {
  scenario: string;
}

export class ReplayProvider implements FireDataProvider {
  readonly mode = 'replay' as const;

  async getFires(): Promise<FiresResponse> {
    const file = path.join(SNAPSHOTS_DIR, path.basename(SNAPSHOT_FILE));
    const parsed = JSON.parse(await readFile(file, 'utf8')) as SnapshotFile;
    return normalize(parsed, 'replay', parsed.scenario ?? SNAPSHOT_FILE);
  }
}
