import type { Viewer } from 'cesium';
import type { FiresResponse } from '../../shared/fires';
import type { FireLayer } from '../fires/fireLayer';
import type { AgentPanel } from '../hud/agentPanel';
import type { FireSelectionLayer } from '../layers/fireSelection';
import { FirePlayback, replayPosition, replayTimeline } from './playback';

/** Commit evidence before layer notifications can request dependent reports. */
export function connectFireViews(playback: FirePlayback, views: {
  entities: Pick<Viewer['entities'], 'suspendEvents' | 'resumeEvents'>;
  hud: { setMode(mode: FiresResponse['provenance']): void };
  hotspots: { setData(data: FiresResponse): void };
  fires: Pick<FireLayer, 'onStateChange' | 'setData'>;
  selection: Pick<FireSelectionLayer, 'track' | 'setData'>;
  agent: Pick<AgentPanel, 'track'>;
}): void {
  let evidence: FiresResponse | null = null;
  views.fires.onStateChange(({selectedId}) => {
    const at = replayTimeline(evidence) ? replayPosition(evidence) : undefined;
    const key = evidence?.asOf ?? evidence?.fetchedAt ?? 'latest';
    views.selection.track(selectedId, at, key, evidence?.source);
    views.agent.track(selectedId, at, key, evidence?.source);
  });
  playback.subscribe(({data}) => {
    if (!data || data === evidence) return;
    evidence = data;
    views.hud.setMode(data.provenance);
    views.entities.suspendEvents();
    try {
      views.hotspots.setData(data);
      views.selection.setData(data);
      views.fires.setData(data);
    } finally {
      views.entities.resumeEvents();
    }
  });
}
