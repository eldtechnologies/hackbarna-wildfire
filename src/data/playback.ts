import type { FiresResponse, ReplayTimeline } from '../../shared/fires';

export interface PlaybackState {
  data: FiresResponse | null;
  loading: boolean;
  playing: boolean;
  error: string | null;
}

export function replayTimeline(data: FiresResponse | null): ReplayTimeline | null {
  if (data?.provenance !== 'replay' || !data.timeline || !data.asOf) return null;
  const { start, end, durationSeconds } = data.timeline;
  const startMs = Date.parse(start), endMs = Date.parse(end), atMs = Date.parse(data.asOf);
  if (![startMs, endMs, atMs].every(Number.isFinite) ||
      !Number.isSafeInteger(durationSeconds) || durationSeconds <= 0 ||
      Math.ceil((endMs - startMs) / 1000) !== durationSeconds ||
      atMs < startMs || atMs > endMs) return null;
  return data.timeline;
}

export function replayPosition(data: FiresResponse | null): number {
  const timeline = replayTimeline(data);
  return timeline ? Math.min(timeline.durationSeconds,
    Math.ceil((Date.parse(data!.asOf!) - Date.parse(timeline.start)) / 1000)) : 0;
}

type LoadFires = (atSeconds?: number, signal?: AbortSignal) => Promise<FiresResponse>;

/** One committed snapshot feeds every layer. A seek cannot be overwritten by an older request. */
export class FirePlayback {
  private state: PlaybackState = { data: null, loading: false, playing: false, error: null };
  private readonly listeners = new Set<(state: PlaybackState) => void>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private request: AbortController | undefined;
  private generation = 0;
  private disposed = false;

  constructor(private readonly loadFires: LoadFires) {}

  subscribe(listener: (state: PlaybackState) => void): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => { this.listeners.delete(listener); };
  }

  getState(): PlaybackState { return this.state; }

  async start(): Promise<void> { await this.load(); }

  pause(): void {
    clearTimeout(this.timer);
    this.request?.abort();
    ++this.generation;
    this.update({ playing: false, loading: false });
  }

  async seek(seconds: number): Promise<void> {
    const timeline = replayTimeline(this.state.data);
    if (!timeline || !Number.isFinite(seconds) || this.disposed) return;
    clearTimeout(this.timer);
    await this.load(Math.min(timeline.durationSeconds, Math.max(0, Math.round(seconds))), false);
  }

  async play(): Promise<void> {
    const timeline = replayTimeline(this.state.data);
    if (!timeline || this.state.loading || this.state.playing || this.disposed) return;
    clearTimeout(this.timer);
    this.update({ playing: true });
    const current = replayPosition(this.state.data);
    await this.load(current >= timeline.durationSeconds ? 0 : Math.min(current + 1800, timeline.durationSeconds));
  }

  async retry(): Promise<void> {
    this.pause();
    await this.load(replayTimeline(this.state.data) ? replayPosition(this.state.data) : undefined);
  }

  dispose(): void {
    this.pause();
    this.disposed = true;
    this.listeners.clear();
  }

  private update(change: Partial<PlaybackState>): void {
    this.state = { ...this.state, ...change };
    for (const listener of this.listeners) listener(this.state);
  }

  private async load(seconds?: number, playing = this.state.playing): Promise<void> {
    if (this.disposed) return;
    clearTimeout(this.timer);
    this.request?.abort();
    const request = this.request = new AbortController();
    const generation = ++this.generation;
    this.update({ loading: true, error: null, playing });
    try {
      const data = await this.loadFires(seconds, request.signal);
      if (generation !== this.generation || this.disposed) return;
      const timeline = replayTimeline(data);
      if (seconds !== undefined && data.provenance === 'replay' &&
          (!timeline || Date.parse(data.asOf!) !== Math.min(Date.parse(timeline.start) + seconds * 1000, Date.parse(timeline.end)))) {
        throw new Error('The server returned a different observation time');
      }
      const playing = this.state.playing && timeline !== null && replayPosition(data) < timeline.durationSeconds;
      this.update({ data, loading: false, playing });
      if (playing) {
        // Backpressure: start the next step only after the current frame is committed.
        this.timer = setTimeout(() => {
          const next = Math.min(replayPosition(this.state.data) + 1800, timeline!.durationSeconds);
          void this.load(next);
        }, 500);
      } else if (data.provenance === 'live') {
        this.timer = setTimeout(() => void this.load(), 10 * 60 * 1000);
      }
    } catch (error) {
      if (generation !== this.generation || this.disposed) return;
      this.update({ loading: false, playing: false,
        error: error instanceof Error ? error.message : 'Fire data unavailable' });
    }
  }
}
