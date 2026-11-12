/*
 * The Map (spec 2026-11-11): every project that has the five areas, grouped by area as on the Projects page, against
 * the five areas, with the next thing to learn on top and a short weekly history below. Opened on purpose from the
 * Projects page; it is never the home.
 */
import type { AreaSection } from '../projects/service.js';
import { AREA_LABELS } from '../projects/types.js';
import { CHECK_AREAS, CHECK_LABELS, STATUS_LABELS, type AreaState, type CheckArea, type ShownStatus } from '../learning/types.js';
import { html, type SafeHtml } from './html.js';
import { areaRing } from './projectsViews.js';
import { timeAgo } from './when.js';

export interface MapRow { name: string; areas: AreaState[]; next: string | null }
export interface MapView {
  sections: { area: AreaSection['area']; rows: MapRow[] }[];
  total: number;
  /** The next area to learn and the project it is on, or null when nothing waits. */
  learnNext: { area: CheckArea; project: string } | null;
  history: { week: string; area: CheckArea; status: ShownStatus; count: number }[];
  now: Date;
}

const panelAreas = (name: string): string => `/?project=${encodeURIComponent(name)}#p-areas`;

function cell(name: string, a: AreaState, now: Date): SafeHtml {
  const mark = a.status === 'not_needed' ? html`<span class="adash" aria-hidden="true">–</span>` : html`<span class="pdot a-st-${a.status}" aria-hidden="true"></span>`;
  const words = [STATUS_LABELS[a.status], a.note].filter((x): x is string => x !== null && x !== '').join(' · ');
  const title = `${CHECK_LABELS[a.area].name}: ${words}`;
  return html`<td class="mcell st-${a.status}" title="${title}"><a class="mlink" href="${panelAreas(name)}" aria-label="${title}">${mark}</a><span class="mnote">${words}${a.setAt ? html` · ${timeAgo(a.setAt, now)}` : ''}</span></td>`;
}

/** Per area, how many projects had it done in each recorded week: small bars, the numbers in the label. */
function historyLines(v: MapView): SafeHtml {
  const weeks = [...new Set(v.history.map((h) => h.week))];
  if (weeks.length === 0) return html``;
  const done = (area: CheckArea, week: string) => v.history.find((h) => h.area === area && h.week === week && h.status === 'done')?.count ?? 0;
  const max = Math.max(1, ...weeks.flatMap((w) => CHECK_AREAS.map((a) => done(a, w))));
  return html`<h2 class="mhist-h">Done, week by week</h2>
<ul class="mhist plain-list">${CHECK_AREAS.map((a) => {
    const now = done(a, weeks.at(-1)!);
    const label = `${CHECK_LABELS[a].name}: done on ${now} ${now === 1 ? 'project' : 'projects'} this week`;
    return html`<li><span class="mhist-name">${CHECK_LABELS[a].name}</span><span class="bars" role="img" aria-label="${label}">${weeks.map((w) => html`<i class="h${Math.round((done(a, w) / max) * 10)}"></i>`)}</span><span class="mhist-n">${now}</span></li>`;
  })}</ul>`;
}

export function mapView(v: MapView): SafeHtml {
  const lead = v.learnNext
    ? html`${v.total} ${v.total === 1 ? 'project' : 'projects'} · next to learn: ${CHECK_LABELS[v.learnNext.area].name}, on <a href="${panelAreas(v.learnNext.project)}">${v.learnNext.project}</a>.`
    : html`${v.total} ${v.total === 1 ? 'project' : 'projects'} · Nothing waiting to learn.`;
  return html`<div class="mapv">
<h1>Map</h1>
<p class="map-lead">${lead} <a href="/?project=developer-handbook#panel">Your handbook</a></p>
${v.total === 0 ? html`<p class="quiet empty">No project has the five areas yet: open projects outside Personal get them.</p>` : ''}
${v.sections.map((s) => html`<section class="map-area" aria-labelledby="map-${s.area ?? 'unsorted'}">
<h2 id="map-${s.area ?? 'unsorted'}">${areaRing(s.area)}${s.area ? AREA_LABELS[s.area] : 'Unsorted'}</h2>
<div class="map-scroll"><table class="map-table">
<thead><tr><th scope="col">Project</th>${CHECK_AREAS.map((a) => html`<th scope="col" title="${CHECK_LABELS[a].term}">${CHECK_LABELS[a].name}</th>`)}<th scope="col">Next</th></tr></thead>
<tbody>${s.rows.map((r) => html`<tr><th scope="row"><a href="${panelAreas(r.name)}">${r.name}</a></th>${CHECK_AREAS.map((a) => cell(r.name, r.areas.find((x) => x.area === a)!, v.now))}<td class="mnext">${r.next ?? ''}</td></tr>`)}</tbody>
</table></div>
</section>`)}
${historyLines(v)}
</div>`;
}
