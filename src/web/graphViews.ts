import type { GraphList, GraphListRow } from '../graph/data.js';
import { asset, html, type SafeHtml } from './html.js';
import { metaLine } from './metaLine.js';

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const panelHref = (name: string): string => `/?project=${encodeURIComponent(name)}#panel`;

/** "38 projects in 5 areas", Unsorted not counted; with no area yet, just "3 projects". */
function counted(list: GraphList): string {
  const s = list.summary;
  return `${plural(s.projects, 'project', 'projects')}${s.areas > 0 ? ` in ${plural(s.areas, 'area', 'areas')}` : ''}`;
}

/** "Graph of 38 projects in 5 areas": the window's name, and the start of the list's heading line. */
export function graphName(list: GraphList): string {
  return `Graph of ${counted(list)}`;
}

function lede(list: GraphList): string {
  const s = list.summary;
  const parts = [counted(list)];
  if (s.facts > 0) parts.push(plural(s.facts, 'fact', 'facts'));
  if (s.pages > 0) parts.push(plural(s.pages, 'page', 'pages'));
  if (s.threads > 0) parts.push(plural(s.threads, 'thread', 'threads'));
  if (s.waiting > 0) parts.push(`${s.waiting} waiting on you`);
  return parts.join(' · ');
}

const touched = (days: number): string => (days === 0 ? 'Touched today' : days === 1 ? 'Touched yesterday' : `Touched ${days} days ago`);
const STATE_WORD: Record<GraphListRow['state'], string> = { open: '', idea: 'Idea', parked: 'Parked' };

function row(r: GraphListRow): SafeHtml {
  const tag = r.onTheGo ? 'On the go' : STATE_WORD[r.state];
  // One meta line, as on the card: waiting, late, Touched, Runs on (an empty part left out).
  const meta = metaLine([
    r.waiting > 0 ? `${r.waiting} waiting` : null,
    r.late > 0 ? html`<span class="late-text">${r.late} late</span>` : null,
    touched(r.days),
    r.runsOn.length > 0 ? `Runs on ${r.runsOn.join(', ')}` : null,
  ]);
  return html`<li id="g-${r.name}">
<p class="graph-row-head"><a href="${panelHref(r.name)}">${r.name}</a>${tag ? html` <span class="quiet">${tag}</span>` : ''}</p>
${r.oneLiner ? html`<p class="graph-row-one">${r.oneLiner}</p>` : ''}
${r.next ? html`<p class="graph-row-next">Next: ${r.next}</p>` : ''}
${meta}
${r.related.length > 0 ? html`<p class="graph-row-related">Related: ${r.related.map((n, i) => html`${i > 0 ? ', ' : ''}<a href="#g-${n}">${n}</a>`)}</p>` : ''}
</li>`;
}

/** One Personal section: pinned projects under the heading, the others in a closed fold that never names them outside. */
function personalSection(pinned: GraphListRow[], folded: GraphListRow[]): SafeHtml {
  const fold = (summary: string) => html`<details class="fold"><summary>${summary} <span class="n">${folded.length}</span><span class="chev"></span></summary>
<ul class="graph-rows">${folded.map(row)}</ul></details>`;
  if (pinned.length === 0) return fold('Personal');
  return html`<h2>Personal</h2>
<ul class="graph-rows">${pinned.map(row)}</ul>
${folded.length > 0 ? fold('Not pinned') : ''}`;
}

function listBody(list: GraphList, opts: { inWindowPage: boolean }): SafeHtml {
  const empty = list.summary.projects === 0 && list.done.length === 0;
  return html`<section class="graph-list" aria-labelledby="graph-list-title">
<h1 id="graph-list-title">Graph</h1>
${empty ? html`<p class="lede">No projects yet.</p>` : html`<p class="lede">${lede(list)}</p>`}
${opts.inWindowPage ? '' : html`<p><a class="more-link" href="/graph?view=3d">Show in 3D</a></p>`}
${list.areas.map((a) => (a.area === 'personal' ? personalSection(a.rows, list.personal) : html`<h2>${a.label}</h2>
<ul class="graph-rows">${a.rows.map(row)}</ul>`))}
${list.done.length > 0 ? html`<details class="fold"><summary>Done and archived <span class="n">${list.done.length}</span><span class="chev"></span></summary>
<ul class="graph-done">${list.done.map((d) => html`<li><a href="${panelHref(d.name)}">${d.name}</a> <span class="quiet">${d.state === 'done' ? 'Done' : 'Archived'}</span></li>`)}</ul></details>` : ''}
</section>`;
}

/**
 * The Graph tab: the dark 3D window (sent hidden; graph3d.js shows it and hides the list once its first frame is
 * drawn) and the list, which is what shows without script, with a blocked script or a failed fetch.
 */
export function graphPage(v: { list: GraphList; focus?: string }): SafeHtml {
  return html`<div class="graph" role="application" aria-roledescription="3D graph" aria-label="${graphName(v.list)}" aria-describedby="graph-keys" tabindex="0" hidden${v.focus ? html` data-project="${v.focus}"` : ''}>
<h1 class="visually-hidden">Graph</h1>
<div class="graph-bar">
<a class="graph-btn" href="/graph?view=list">Show as list</a>
<button type="button" class="graph-btn" data-act="related" aria-pressed="true">Related</button>
<button type="button" class="graph-btn" data-act="turn" aria-pressed="false">Turn slowly</button>
<button type="button" class="graph-btn graph-back" data-act="back" hidden>Back to all projects</button>
</div>
<form class="graph-find" role="search"><label for="graph-q" class="visually-hidden">Find in the graph</label><input id="graph-q" type="search" maxlength="200" autocomplete="off" placeholder="Find in the graph"><output class="graph-count" aria-live="polite"></output></form>
<canvas class="graph-canvas" aria-hidden="true"></canvas>
<div class="graph-card" aria-live="polite" hidden></div>
<div class="graph-sheet" hidden><button type="button" class="graph-grab" aria-label="Close"></button><button type="button" class="graph-close" aria-label="Back to all projects">×</button><div class="graph-sheet-body" aria-live="polite"></div></div>
<p class="graph-hint" hidden>Drag to turn · pinch to zoom · tap a project</p>
<p id="graph-keys" class="graph-keys">← → step through projects · ↑ ↓ tilt · + − zoom · Enter fly in · Esc back · R related</p>
</div>
${listBody(v.list, { inWindowPage: true })}
<script type="module" src="${asset('graph3d.js')}"></script>`;
}

/** The list view (/graph?view=list, remembered): the same data as plain HTML, with no canvas. */
export function graphListPage(list: GraphList): SafeHtml {
  return listBody(list, { inWindowPage: false });
}
