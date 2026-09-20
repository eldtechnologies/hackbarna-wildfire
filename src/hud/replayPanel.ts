import { FirePlayback, replayPosition, replayTimeline } from '../data/playback';

function timestamp(iso: string): string {
  return new Date(iso).toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
}

export function initReplayPanel(playback: FirePlayback, root: HTMLElement): void {
  const panel = document.createElement('section');
  panel.className = 'hud-panel hud-replay';
  panel.setAttribute('aria-label', 'Observation replay');
  panel.innerHTML = `
    <div class="hud-panel-title">OBSERVATION REPLAY</div>
    <div class="replay-time"></div>
    <div class="hud-scrubber-controls">
      <button class="hud-btn" data-action="start" aria-label="Go to replay start">START</button>
      <button class="hud-btn" data-action="back" aria-label="Back one hour">−1H</button>
      <button class="hud-btn" data-action="play">PLAY</button>
      <button class="hud-btn" data-action="forward" aria-label="Forward one hour">+1H</button>
      <button class="hud-btn" data-action="end" aria-label="Go to replay end">END</button>
    </div>
    <input class="replay-slider" type="range" min="0" step="1" aria-label="Observation time">
    <div class="replay-range"><span></span><span></span></div>
    <div class="replay-status" role="status"></div>
    <button class="hud-btn replay-retry" hidden>RETRY</button>`;
  root.appendChild(panel);
  const time = panel.querySelector<HTMLElement>('.replay-time')!;
  const status = panel.querySelector<HTMLElement>('.replay-status')!;
  const slider = panel.querySelector<HTMLInputElement>('input')!;
  const buttons = Object.fromEntries([...panel.querySelectorAll<HTMLButtonElement>('[data-action]')]
    .map(button => [button.dataset.action!, button]));
  const retry = panel.querySelector<HTMLButtonElement>('.replay-retry')!;
  const range = panel.querySelectorAll<HTMLElement>('.replay-range span');

  buttons.start.onclick = () => { void playback.seek(0); };
  buttons.back.onclick = () => { void playback.seek(replayPosition(playback.getState().data) - 3600); };
  buttons.forward.onclick = () => { void playback.seek(replayPosition(playback.getState().data) + 3600); };
  buttons.end.onclick = () => { void playback.seek(replayTimeline(playback.getState().data)?.durationSeconds ?? 0); };
  buttons.play.onclick = () => {
    if (playback.getState().playing) playback.pause();
    else void playback.play();
  };
  slider.oninput = () => { void playback.seek(Number(slider.value)); };
  retry.onclick = () => { void playback.retry(); };

  playback.subscribe(state => {
    const timeline = replayTimeline(state.data);
    const position = replayPosition(state.data);
    const duration = timeline?.durationSeconds ?? 0;
    const unavailable = !timeline;
    time.textContent = state.data?.asOf ? timestamp(state.data.asOf) : '';
    buttons.start.disabled = buttons.back.disabled = unavailable || position === 0;
    buttons.end.disabled = buttons.forward.disabled = unavailable || position >= duration;
    buttons.play.disabled = unavailable || (state.loading && !state.playing);
    buttons.play.textContent = state.playing ? 'PAUSE' : position >= duration && timeline ? 'REPLAY' : 'PLAY';
    slider.disabled = unavailable;
    slider.max = String(duration);
    // Keep the requested thumb position while its snapshot loads. The time above
    // always describes the committed map, never an unfulfilled request.
    if (!state.loading) slider.value = String(position);
    slider.setAttribute('aria-valuetext', time.textContent);
    range[0].textContent = timeline ? timestamp(timeline.start) : '';
    range[1].textContent = timeline ? timestamp(timeline.end) : '';
    status.textContent = state.error ? 'Could not load observations. The map shows the last loaded time.'
      : state.loading ? 'Loading observations…'
      : timeline ? `${state.data!.hotspots.length.toLocaleString()} detections available · ${state.playing ? 'Playing' : 'Paused'} · recorded observations`
      : state.data?.provenance === 'live' ? 'Live observations · historical replay unavailable'
      : 'No observation timeline available';
    retry.hidden = !state.error;
    panel.setAttribute('aria-busy', String(state.loading));
  });
}
