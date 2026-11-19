import type { GraphList, GraphListRow } from '../graph/data.js';
import { asset, html, type SafeHtml } from './html.js';
import { metaLine } from './metaLine.js';
import { t, tHtml } from '../i18n/index.js';
import { AREAS, type Area } from '../projects/types.js';
import { placeName } from './projectsViews.js';

const panelHref = (name: string): string => `/?project=${encodeURIComponent(name)}#panel`;

/** "38 projects in 5 areas", Unsorted not counted; with no area yet, just "3 projects". */
function counted(list: GraphList): string {
  const s = list.summary;
  return `${t('graph.projects', { count: s.projects })}${s.areas > 0 ? ` ${t('graph.inAreas', { count: s.areas })}` : ''}`;
}

/** "Graph of 38 projects in 5 areas": the window's name, and the start of the list's heading line. */
export function graphName(list: GraphList): string {
  return t('graph.name', { counted: counted(list) });
}

function lede(list: GraphList): string {
  const s = list.summary;
  const parts = [counted(list)];
  if (s.facts > 0) parts.push(t('graph.facts', { count: s.facts }));
  if (s.pages > 0) parts.push(t('graph.pages', { count: s.pages }));
  if (s.threads > 0) parts.push(t('graph.threads', { count: s.threads }));
  if (s.waiting > 0) parts.push(t('graph.waitingOnYou', { count: s.waiting }));
  return parts.join(' · ');
}

const touched = (days: number): string => (days === 0 ? t('graph.touchedToday') : days === 1 ? t('graph.touchedYesterday') : t('graph.touchedDays', { count: days }));
const stateWord = (state: GraphListRow['state']): string => (state === 'idea' ? t('graph.state.idea') : state === 'parked' ? t('graph.state.parked') : '');

function row(r: GraphListRow): SafeHtml {
  const tag = r.onTheGo ? t('graph.onTheGo') : stateWord(r.state);
  // One meta line, as on the card: waiting, late, Touched, Runs on (an empty part left out).
  const meta = metaLine([
    r.waiting > 0 ? t('graph.waiting', { count: r.waiting }) : null,
    r.late > 0 ? html`<span class="late-text">${t('graph.late', { count: r.late })}</span>` : null,
    touched(r.days),
    r.runsOn.length > 0 ? t('graph.runsOn', { places: r.runsOn.join(', ') }) : null,
  ]);
  return html`<li id="g-${r.name}">
<p class="graph-row-head"><a href="${panelHref(r.name)}">${r.name}</a>${tag ? html` <span class="quiet">${tag}</span>` : ''}</p>
${r.oneLiner ? html`<p class="graph-row-one">${r.oneLiner}</p>` : ''}
${r.next ? html`<p class="graph-row-next">${t('graph.next', { next: r.next })}</p>` : ''}
${meta}
${r.related.length > 0 ? html`<p class="graph-row-related">${tHtml('graph.related', { list: html`${r.related.map((n, i) => html`${i > 0 ? ', ' : ''}<a href="#g-${n}">${n}</a>`)}` })}</p>` : ''}
</li>`;
}

/** One Personal section: pinned projects under the heading, the others in a closed fold that never names them outside. */
function personalSection(pinned: GraphListRow[], folded: GraphListRow[]): SafeHtml {
  const fold = (summary: string) => html`<details class="fold"><summary>${summary} <span class="n">${folded.length}</span><span class="chev"></span></summary>
<ul class="graph-rows">${folded.map(row)}</ul></details>`;
  if (pinned.length === 0) return fold(t('graph.personal'));
  return html`<h2>${t('graph.personal')}</h2>
<ul class="graph-rows">${pinned.map(row)}</ul>
${folded.length > 0 ? fold(t('graph.notPinned')) : ''}`;
}

function listBody(list: GraphList, opts: { inWindowPage: boolean }): SafeHtml {
  const empty = list.summary.projects === 0 && list.done.length === 0;
  return html`<section class="graph-list" aria-labelledby="graph-list-title">
<h1 id="graph-list-title">${t('graph.title')}</h1>
${empty ? html`<p class="lede">${t('graph.empty')}</p>` : html`<p class="lede">${lede(list)}</p>`}
${opts.inWindowPage ? '' : html`<p><a class="more-link" href="/graph?view=3d">${t('graph.show3d')}</a></p>`}
${list.areas.map((a) => (a.area === 'personal' ? personalSection(a.rows, list.personal) : html`<h2>${a.area === null || (AREAS as readonly string[]).includes(a.area) ? placeName(a.area as Area | null) : a.label}</h2>
<ul class="graph-rows">${a.rows.map(row)}</ul>`))}
${list.done.length > 0 ? html`<details class="fold"><summary>${t('graph.doneArchived')} <span class="n">${list.done.length}</span><span class="chev"></span></summary>
<ul class="graph-done">${list.done.map((d) => html`<li><a href="${panelHref(d.name)}">${d.name}</a> <span class="quiet">${d.state === 'done' ? t('graph.done') : t('graph.archived')}</span></li>`)}</ul></details>` : ''}
</section>`;
}

/**
 * The Graph tab: the dark 3D window (sent hidden; graph3d.js shows it and hides the list once its first frame is
 * drawn) and the list, which is what shows without script, with a blocked script or a failed fetch.
 */
export function graphPage(v: { list: GraphList; focus?: string }): SafeHtml {
  return html`<div class="graph" role="application" aria-roledescription="${t('graph.roleDescription')}" aria-label="${graphName(v.list)}" aria-describedby="graph-keys" tabindex="0" hidden${v.focus ? html` data-project="${v.focus}"` : ''}>
<h1 class="visually-hidden">${t('graph.title')}</h1>
<div class="graph-bar">
<a class="graph-btn" href="/graph?view=list">${t('graph.showList')}</a>
<button type="button" class="graph-btn" data-act="related" aria-pressed="true">${t('graph.relatedBtn')}</button>
<button type="button" class="graph-btn" data-act="turn" aria-pressed="false">${t('graph.turn')}</button>
<button type="button" class="graph-btn graph-back" data-act="back" hidden>${t('graph.back')}</button>
</div>
<form class="graph-find" role="search"><label for="graph-q" class="visually-hidden">${t('graph.find')}</label><input id="graph-q" type="search" maxlength="200" autocomplete="off" placeholder="${t('graph.find')}"><output class="graph-count" aria-live="polite"></output></form>
<canvas class="graph-canvas" aria-hidden="true"></canvas>
<div class="graph-card" aria-live="polite" hidden></div>
<div class="graph-sheet" hidden><button type="button" class="graph-grab" aria-label="${t('graph.close')}"></button><button type="button" class="graph-close" aria-label="${t('graph.back')}">×</button><div class="graph-sheet-body" aria-live="polite"></div></div>
<p class="graph-hint" hidden>${t('graph.hint')}</p>
<p id="graph-keys" class="graph-keys">${t('graph.keys')}</p>
</div>
${listBody(v.list, { inWindowPage: true })}
<script type="module" src="${asset('graph3d.js')}"></script>`;
}

/** The list view (/graph?view=list, remembered): the same data as plain HTML, with no canvas. */
export function graphListPage(list: GraphList): SafeHtml {
  return listBody(list, { inWindowPage: false });
}
