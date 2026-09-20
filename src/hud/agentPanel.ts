// Agent panel: shows the LLM/template-narrated situation report for the
// tracked fire. All figures rendered here come from the situation packet the
// server computed; the narrator only phrases them.

import { fetchSituation } from '../data/api';
import { CATEGORY_LABEL } from '../../shared/threats';
import type { SituationResponse } from '../../shared/situation';

export class AgentPanel {
  private request = 0;
  private trackedKey: string | null = null;
  private controller: AbortController | null = null;

  constructor(private panel: HTMLElement) {}

  /** The app owns selection and evidence time; this panel only renders them. */
  track(fireId: string | null, atSeconds?: number, evidenceKey='latest'): void {
    const key=fireId===null ? null : JSON.stringify([fireId,atSeconds,evidenceKey]);
    if (key===this.trackedKey) return;
    this.trackedKey=key;
    const seq=++this.request;
    this.controller?.abort();
    this.controller=new AbortController();
    if (!fireId) {
      this.panel.classList.remove('open');
      this.panel.replaceChildren();
      return;
    }
    this.renderLoading();
    fetchSituation(fireId,atSeconds,this.controller.signal)
      .then((situation) => {
        if (seq === this.request) this.render(situation);
      })
      .catch((err) => {
        if (seq!==this.request) return;
        console.error('[agent-panel] situation fetch failed:', err);
        if (seq === this.request) {
          this.renderError(fireId,atSeconds,evidenceKey);
        }
      });
  }

  private renderLoading(): void {
    this.panel.classList.add('open');
    this.panel.replaceChildren();
    this.panel.append(this.title('SITUATION AGENT'), this.body('ANALYZING...'));
  }

  private renderError(fireId: string, atSeconds?:number,evidenceKey?:string): void {
    this.panel.classList.add('open');
    this.panel.replaceChildren();
    this.panel.append(this.title(`SITUATION AGENT / ${fireId}`), this.body('REPORT UNAVAILABLE'));
    const retry=document.createElement('button');
    retry.className='hud-btn';retry.textContent='RETRY REPORT';
    retry.addEventListener('click',()=>{this.trackedKey=null;this.track(fireId,atSeconds,evidenceKey);});
    this.panel.appendChild(retry);
  }

  private title(text: string): HTMLElement {
    const node = document.createElement('div');
    node.className = 'threat-title';
    node.textContent = text;
    return node;
  }

  private body(text: string): HTMLElement {
    const node = document.createElement('div');
    node.className = 'threat-body';
    node.textContent = text;
    return node;
  }

  private render(situation: SituationResponse): void {
    this.panel.classList.add('open');
    this.panel.replaceChildren();

    const { packet } = situation;

    const header = document.createElement('div');
    header.className = 'agent-header';
    const heading = document.createElement('span');
    heading.textContent = `SITUATION AGENT / ${packet.fireName ?? packet.fireId}`;
    const badge = document.createElement('span');
    badge.className =
      'agent-badge ' + (situation.narrator === 'llm' ? 'agent-badge-llm' : 'agent-badge-template');
    badge.textContent = situation.narrator === 'llm' ? 'AI ORDERED FACTS' : 'COMPUTED FACTS';
    header.append(heading, badge);

    const summary = document.createElement('div');
    summary.className = 'agent-summary';
    summary.textContent = situation.summary;

    const spreadValue =
      packet.spreadHorizonHours > 0
        ? packet.spreadBearingDeg != null && packet.spreadCompass != null
          ? `${packet.spreadCompass} / ${packet.spreadHorizonHours} H`
          : `NO HEADING / ${packet.spreadHorizonHours} H`
        : 'NO PROJECTION';

    const figures = document.createElement('div');
    figures.className = 'agent-figures';
    const rows: [string, string][] = [
      ['PERIMETER', packet.perimeterAreaKm2 != null ? `${packet.perimeterAreaKm2.toFixed(0)} KM2` : 'NONE OBSERVED'],
      ['SPREAD', spreadValue],
      ['HOTSPOTS', String(packet.hotspotCount)],
      ['PROXIMITY MATCHES', String(packet.threats.length)],
      ['IN CORRIDOR', String(packet.corridorCount)],
    ];
    for (const [label, value] of rows) {
      const row = document.createElement('div');
      row.className = 'agent-figure';
      const left = document.createElement('span');
      left.textContent = label;
      const right = document.createElement('span');
      right.textContent = value;
      row.append(left, right);
      figures.appendChild(row);
    }

    // Outside infrastructure coverage, zero threats means no data there, not
    // a safe area; say so next to the figure. Inside coverage the caveat
    // names the coverage scope, mirroring the narrators' "bundled" wording:
    // the rectangle can include areas (e.g. Andorra) where the dataset has
    // no assets without the area being risk-free.
    if (packet.threats.length === 0 || packet.infrastructureStatus.state !== 'available') {
      const caveat = document.createElement('div');
      caveat.className = 'agent-caveat';
      caveat.textContent =
        packet.infrastructureStatus.state !== 'available'
          ? `INFRASTRUCTURE DATA ${packet.infrastructureStatus.state.toUpperCase()} — ASSESSMENT INCOMPLETE`
          : packet.infrastructureCoverage != null
          ? `NO BUNDLED ASSETS WITHIN 20 KM (COVERAGE: ${packet.infrastructureCoverage.label.toUpperCase()})`
          : 'NO INFRASTRUCTURE DATA FOR THIS REGION';
      figures.appendChild(caveat);
    }

    this.panel.append(header, summary, figures);

    if (situation.recommendations.length > 0) {
      const listTitle = document.createElement('div');
      listTitle.className = 'threat-ring-heading';
      listTitle.textContent = `PROXIMITY PRIORITY (${situation.recommendations.length})`;
      this.panel.appendChild(listTitle);

      const list = document.createElement('div');
      list.className = 'agent-list';
      situation.recommendations.forEach((rec, i) => {
        const row = document.createElement('div');
        row.className =
          'agent-rec' + (rec.priority === 1 ? ' urgent' : rec.priority === 2 ? ' elevated' : '');
        const rank = document.createElement('span');
        rank.className = 'agent-rec-rank';
        rank.textContent = String(i + 1).padStart(2, '0');
        const left = document.createElement('span');
        left.className = 'threat-asset-name';
        left.textContent = rec.name;
        const right = document.createElement('span');
        right.className = 'threat-asset-info';
        const dist = rec.ring === 'inside' ? '0 KM' : `${rec.distanceKm.toFixed(1)} KM`;
        right.textContent = `${CATEGORY_LABEL[rec.category].toUpperCase()} / ${dist}${rec.inSpreadCorridor ? ' / CORRIDOR' : ''}`;
        row.append(rank, left, right);
        list.appendChild(row);
      });
      this.panel.appendChild(list);
    }

    const footer = document.createElement('div');
    footer.className = 'agent-footer';
    const provenance = packet.dataProvenance === 'live' ? 'LIVE' : 'REPLAY';
    footer.textContent = `${provenance} DATA / EVIDENCE ${packet.evidenceAsOf??'TIME UNAVAILABLE'} / ${packet.availabilityPolicy??'PROVIDER OBSERVATIONS'} / PROXIMITY SCREENING, NOT EVACUATION ORDERS`;
    this.panel.appendChild(footer);
  }
}
