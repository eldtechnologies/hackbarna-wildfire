// Replay provider: serves a cached snapshot from data/snapshots/. Two
// formats are supported:
//   - flat snapshot (raw Deepfire shape + scenario), like
//     los-gallardos-2026-07-09.json, serving one static moment.
//   - recording: { scenario, recordedAt, frames: [{ t, hotspots, clusters,
//     spread }] } captured by scripts/record-snapshot.mjs. Frame selection
//     via getFires(atSeconds) enables accelerated timeline playback.
// All frames pass through the same normalize() as the live path, which keeps
// the demo honest when keys or wifi are missing.

import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import type { RawFiresPayload } from './normalize';
import { captureTimeline, causalResponse, type HistoricalCapture } from './causal';
import type {
  FireDataProvider,
  FiresResponse,
  ReplayTimeline,
} from '../../shared/fires';

const SNAPSHOTS_DIR = path.resolve(process.cwd(), 'data/snapshots');
// Default scenario: the real Los Gallardos fire, 9-11 Jul 2026, captured from
// the Deepfire API. Falling back to the newest file by mtime would be
// nondeterministic on a fresh checkout, where all mtimes are equal.
const SNAPSHOT_FILE = process.env.REPLAY_SNAPSHOT ?? 'los-gallardos-2026-07-09.json';

type SnapshotFile = HistoricalCapture;

// Recording frame as written by the record script: raw payload + t.
interface FrameFile extends RawFiresPayload {
  t: string;
}

interface RecordingFile {
  scenario?: string;
  recordedAt?: string;
  dataKind?: string;
  frames?: FrameFile[];
}

function isRecording(file: unknown): file is RecordingFile {
  return (
    typeof file === 'object' &&
    file !== null &&
    Array.isArray((file as RecordingFile).frames)
  );
}

// Pick which snapshot file to serve:
//   1. REPLAY_SNAPSHOT naming a file in data/snapshots/ exactly.
//   2. REPLAY_SNAPSHOT as a scenario prefix (<name>-*.json), newest match.
//      When REPLAY_SNAPSHOT is set but matches nothing, that is an error:
//      a curated demo must not silently serve a different scenario.
//   3. REPLAY_SNAPSHOT set to an empty value: the newest .json in the
//      directory, so a fresh recording automatically becomes the demo
//      scenario. Unset serves the pinned default above.
async function pickSnapshot(snapshotFile: string): Promise<string | null> {
  let entries: string[];
  try {
    entries = await readdir(SNAPSHOTS_DIR);
  } catch {
    return null;
  }
  const jsonFiles = entries.filter((name) => name.endsWith('.json'));
  if (jsonFiles.length === 0) return null;

  if (snapshotFile) {
    const exact = jsonFiles.find((name) => name === snapshotFile);
    if (exact) return exact;
    const prefix = jsonFiles
      .filter((name) => name.startsWith(`${snapshotFile}-`))
      .sort();
    if (prefix.length > 0) return prefix[prefix.length - 1];
    throw new Error(
      `REPLAY_SNAPSHOT '${snapshotFile}' matches no snapshot in data/snapshots/`,
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

export function sortedFrames(frames: FrameFile[]): FrameFile[] {
  return [...frames].sort((a, b) => Date.parse(a.t) - Date.parse(b.t));
}

export function buildTimeline(scenario: string, frames: FrameFile[]): ReplayTimeline {
  const times = sortedFrames(frames).map((f) => f.t);
  const startMs = Date.parse(times[0]);
  const endMs = Date.parse(times[times.length - 1]);
  return {
    scenario,
    start: times[0],
    end: times[times.length - 1],
    // Ceil, so ?at=durationSeconds actually reaches the final frame; rounding
    // down would leave the tail of the last interval unreachable.
    durationSeconds: Math.max(0, Math.ceil((endMs - startMs) / 1000)),
    frames: times,
  };
}

// Frame selection for accelerated playback: the latest frame at or before
// eventStart + atSeconds. The lower bound clamps to the first frame; a time
// past the last frame returns the last frame.
export function frameAt(frames: FrameFile[], atSeconds: number): FrameFile {
  const sorted = sortedFrames(frames);
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

  constructor(private readonly snapshotFile = SNAPSHOT_FILE) {}

  async getFires(atSeconds?: number): Promise<FiresResponse> {
    const file = await pickSnapshot(this.snapshotFile);
    if (!file) {
      throw new Error('no snapshot found in data/snapshots/');
    }
    const parsed = JSON.parse(
      await readFile(path.join(SNAPSHOTS_DIR, file), 'utf8'),
    ) as SnapshotFile | RecordingFile;

    const dataKind = (parsed as RecordingFile).dataKind;
    if (dataKind !== undefined && dataKind !== 'observations') {
      throw new Error(`recording ${file} does not contain satellite observations`);
    }
    const scenario = parsed.scenario ?? path.basename(file, '.json');
    let payload:RawFiresPayload;
    let timeline:ReplayTimeline;
    if (isRecording(parsed)) {
      const frames = (parsed.frames ?? []) as FrameFile[];
      if (frames.length === 0) {
        throw new Error(`recording ${file} has no frames`);
      }
      payload =
        atSeconds === undefined
          ? sortedFrames(frames)[frames.length - 1]
          : frameAt(frames, atSeconds);
      timeline = buildTimeline(scenario, frames);
    } else {
      payload = parsed as SnapshotFile;
      timeline = captureTimeline(parsed as SnapshotFile, scenario);
    }
    const offset = atSeconds === undefined ? timeline.durationSeconds : Math.min(timeline.durationSeconds, Math.max(0, atSeconds));
    const issue = Math.min(Date.parse(timeline.end), Date.parse(timeline.start) + offset * 1000);
    return {...causalResponse(payload, scenario, issue), timeline};
  }
}
