// Replay provider: serves a cached snapshot from data/snapshots/. Two
// formats are supported:
//   - flat snapshot (raw Deepfire shape + scenario), like
//     castelltallat-2025.json, serving one static moment.
//   - recording: { scenario, recordedAt, frames: [{ t, hotspots, clusters,
//     spread }] } captured by scripts/record-snapshot.mjs. Frame selection
//     via getFires(atSeconds) enables accelerated timeline playback.
// All frames pass through the same normalize() as the live path, which keeps
// the demo honest when keys or wifi are missing.

import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { normalize, type RawFiresPayload } from './normalize';
import type {
  FireDataProvider,
  FiresResponse,
  ReplayTimeline,
} from '../../shared/fires';

const SNAPSHOTS_DIR = path.resolve(process.cwd(), 'data/snapshots');
const SNAPSHOT_FILE = process.env.REPLAY_SNAPSHOT ?? '';

interface SnapshotFile extends RawFiresPayload {
  scenario?: string;
}

interface RecordingFile {
  scenario?: string;
  recordedAt?: string;
  frames?: Array<{ t: string } & RawFiresPayload>;
}

function isRecording(file: unknown): file is RecordingFile {
  return (
    typeof file === 'object' &&
    file !== null &&
    Array.isArray((file as RecordingFile).frames)
  );
}

// Recording frame as written by the record script: raw payload + t.
interface FrameFile extends RawFiresPayload {
  t: string;
}

// Pick which snapshot file to serve:
//   1. REPLAY_SNAPSHOT naming a file in data/snapshots/ exactly.
//   2. REPLAY_SNAPSHOT as a scenario prefix (<name>-*.json), newest match.
//      When REPLAY_SNAPSHOT is set but matches nothing, that is an error:
//      a curated demo must not silently serve a different scenario.
//   3. no setting: the newest .json in the directory, so a fresh recording
//      automatically becomes the demo scenario.
async function pickSnapshot(): Promise<string | null> {
  let entries: string[];
  try {
    entries = await readdir(SNAPSHOTS_DIR);
  } catch {
    return null;
  }
  const jsonFiles = entries.filter((name) => name.endsWith('.json'));
  if (jsonFiles.length === 0) return null;

  if (SNAPSHOT_FILE) {
    const exact = jsonFiles.find((name) => name === SNAPSHOT_FILE);
    if (exact) return exact;
    const prefix = jsonFiles
      .filter((name) => name.startsWith(`${SNAPSHOT_FILE}-`))
      .sort();
    if (prefix.length > 0) return prefix[prefix.length - 1];
    throw new Error(
      `REPLAY_SNAPSHOT '${SNAPSHOT_FILE}' matches no snapshot in data/snapshots/`,
    );
  }

  const withMtime = await Promise.all(
    jsonFiles.map(async (name) => ({
      name,
      mtime: (await stat(path.join(SNAPSHOTS_DIR, name))).mtimeMs,
    })),
  );
  withMtime.sort((a, b) => a.mtime - b.mtime);
  return withMtime[withMtime.length - 1].name;
}

function buildTimeline(scenario: string, frames: FrameFile[]): ReplayTimeline {
  const times = frames.map((f) => f.t).sort();
  const startMs = Date.parse(times[0]);
  const endMs = Date.parse(times[times.length - 1]);
  return {
    scenario,
    start: times[0],
    end: times[times.length - 1],
    durationSeconds: Math.max(0, Math.round((endMs - startMs) / 1000)),
    frames: times,
  };
}

// Frame selection for accelerated playback: the latest frame at or before
// eventStart + atSeconds. Clamped to [0, durationSeconds].
function frameAt(frames: FrameFile[], atSeconds: number): FrameFile {
  const sorted = [...frames].sort((a, b) => Date.parse(a.t) - Date.parse(b.t));
  const startMs = Date.parse(sorted[0].t);
  const targetMs = startMs + Math.max(0, atSeconds) * 1000;
  let chosen = sorted[0];
  for (const f of sorted) {
    if (Date.parse(f.t) <= targetMs) chosen = f;
    else break;
  }
  return chosen;
}

export class ReplayProvider implements FireDataProvider {
  readonly mode = 'replay' as const;

  async getFires(atSeconds?: number): Promise<FiresResponse> {
    const file = await pickSnapshot();
    if (!file) {
      throw new Error('no snapshot found in data/snapshots/');
    }
    const parsed = JSON.parse(
      await readFile(path.join(SNAPSHOTS_DIR, file), 'utf8'),
    ) as SnapshotFile | RecordingFile;

    if (isRecording(parsed)) {
      const frames = (parsed.frames ?? []) as FrameFile[];
      if (frames.length === 0) {
        throw new Error(`recording ${file} has no frames`);
      }
      const scenario = parsed.scenario ?? path.basename(file, '.json');
      const frame =
        atSeconds === undefined
          ? [...frames].sort((a, b) => Date.parse(a.t) - Date.parse(b.t))[
              frames.length - 1
            ]
          : frameAt(frames, atSeconds);
      const response = normalize(frame, 'replay', scenario);
      response.timeline = buildTimeline(scenario, frames);
      return response;
    }

    const flat = parsed as SnapshotFile;
    return normalize(flat, 'replay', flat.scenario ?? path.basename(file, '.json'));
  }
}
