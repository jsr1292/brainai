import { CHECK_LABELS, CHECK_STATUSES, MAX_NOTE, STATUS_LABELS, type CheckStatus, type ShownStatus } from '../learning/types.js';
import type { Health } from '../health/health.js';
import type { AreaSection, Home, HomeSuggestion, ProjectCard, ProjectDetail } from '../projects/service.js';
import { localDay, longDate } from '../timezone.js';
import { AREAS, AREA_LABELS, type Project } from '../projects/types.js';
import { withFrom } from './back.js';
import { errorBlock, plural, writer } from './dashboardViews.js';
import { replacedFold } from './factViews.js';
import { html, type SafeHtml } from './html.js';
import { forYouCard, forYouRows, type ApprovalSummary } from './forYou.js';
import { disagreeGroup } from './disagreeViews.js';
import { staleChip } from './freshnessViews.js';
import { metaLine } from './metaLine.js';
import { stripProjectPrefix } from './stripProject.js';
import { dueChip, pastLabel, timeAgo } from './when.js';

const DAY_MS = 24 * 60 * 60 * 1000;
export const ALSO_OPEN_SHOWN = 6;
const day = localDay;
const daysBetween = (from: string, to: string): number => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);
const panelHref = (name: string): string => `/?project=${encodeURIComponent(name)}#panel`;
const action = (name: string, what: string): string => `/projects/${encodeURIComponent(name)}/${what}`;

/** A tile's chip: only something late or due within a week (the amber dot already says that something waits). */
function dueOnly(c: ProjectCard, now: Date): SafeHtml {
  const today = day(now);
  const due = c.soonestDue !== null && (c.late > 0 || (c.soonestDue >= today && daysBetween(today, c.soonestDue) <= 7));
  return due ? waitChip(c, now) : html``;
}

/** The one chip a card carries: late in red, soon in amber, otherwise how many items wait for you. */
function waitChip(c: ProjectCard, now: Date): SafeHtml {
  const today = day(now);
  if (c.late > 0 && c.soonestDue) return dueChip(c.soonestDue, today);
  if (c.soonestDue && c.soonestDue >= today && daysBetween(today, c.soonestDue) <= 7) return dueChip(c.soonestDue, today);
  return c.waiting > 0 ? html`<span class="chip you">${c.waiting} for you</span>` : html``;
}

/** An area's hollow ring (writers get a filled dot). Unsorted is a grey ring. */
export const areaRing = (area: string | null): SafeHtml => html`<span class="ring a-${area ?? 'unsorted'}" aria-hidden="true"></span>`;
const areaDot = (p: Project): SafeHtml => areaRing(p.area);
const areaName = (p: Project): string => (p.area ? AREA_LABELS[p.area] : 'Unsorted');

/** The state dot: green while it is being worked on, amber when something waits on the owner, grey when quiet. */
const DOT_LABEL: Record<ProjectCard['dot'], string> = { on: 'being worked on', wait: 'waiting on you', quiet: 'quiet' };
const stateDot = (c: ProjectCard): SafeHtml => html`<span class="pdot d-${c.dot}" role="img" aria-label="${DOT_LABEL[c.dot]}" title="${DOT_LABEL[c.dot]}"></span>`;
/** The one learning mark on the home page: work that exists only on the Mac (spec 2026-11-11). */
const safeMark = (c: ProjectCard): SafeHtml => {
  if (!c.safeWarning) return html``;
  const why = c.notPushed ? 'Work not safe: not pushed' : 'Work not safe: not in git';
  return html`<span class="pwarn" role="img" aria-label="${why}" title="${why}">!</span>`;
};

/** A live project as a tile: dot and name (and the warning mark), the one-liner, the next step. */
function tile(c: ProjectCard, now: Date, selected: string | undefined): SafeHtml {
  const p = c.project;
  return html`<li><a class="pcard ptile${selected === p.name ? ' is-selected' : ''}" href="${panelHref(p.name)}"${selected === p.name ? html` aria-current="true"` : ''}>
  <span class="ptile-head">${stateDot(c)}<span class="pcard-name">${p.name}</span>${dueOnly(c, now)}${safeMark(c)}</span>
  ${p.oneLiner ? html`<span class="pcard-one">${p.oneLiner}</span>` : ''}
  ${c.next ? html`<span class="pcard-line">${c.next}</span>` : ''}
</a></li>`;
}

/**
 * A row of Also open and the folds: ring, name, next, one chip (waiting first, else not pushed), when. With `one`
 * (Also open on the plain home) it also carries the one-liner, hidden: the desktop row shows it instead of Next.
 */
function row(c: ProjectCard, now: Date, selected: string | undefined, one = false): SafeHtml {
  const p = c.project;
  const note = c.newActivity ? html`<span class="row-note">new activity</span>`
    : c.quietDays !== null ? html`<span class="row-note">quiet · ${c.quietDays < 21 ? `${c.quietDays} days` : `${Math.floor(c.quietDays / 7)} weeks`}</span>` : html``;
  const wait = waitChip(c, now);
  // The waiting chip and the work-not-safe mark side by side: the mark is the one signal never dropped.
  const chip = html`${wait}${safeMark(c)}`;
  return html`<li><a class="row prow${selected === p.name ? ' is-selected' : ''}" href="${panelHref(p.name)}"${selected === p.name ? html` aria-current="true"` : ''}>${stateDot(c)}<span class="prow-name">${p.name}</span>${one ? html`<span class="prow-one" hidden>${p.oneLiner ?? ''}</span>` : ''}<span class="prow-next">${c.next ?? p.oneLiner ?? (c.roadmap ? '' : html`<span class="quiet">no roadmap yet</span>`)}${note}</span><span class="prow-chip">${chip}</span><span class="prow-when">${pastLabel(c.lastTouched, now)}</span></a></li>`;
}

/** A shelf's last line (desktop, 1920 px and up; hidden below): "N more" past the three names it shows, else "Open". */
const shelfMore = (href: string, count: number): SafeHtml =>
  html`<a class="shelf-more" href="${href}" hidden>${count > 3 ? `${count - 3} more` : 'Open'}<span class="chev"></span></a>`;

const AREA_KEY = (area: string | null): string => area ?? 'unsorted';
const plainCount = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/**
 * The fold line under an area: "+3 quiet · 1 idea · 2 parked · 1 done" (only what there is), opening in place to their
 * rows; open when it holds the selected project. Personal adds its areas of life as one more line.
 */
function areaFolds(sec: AreaSection, now: Date, selected: string | undefined): SafeHtml {
  const rest = [...sec.quiet, ...sec.ideas, ...sec.parked, ...sec.done];
  const parts = [
    sec.quiet.length > 0 ? `+${sec.quiet.length} quiet` : null,
    sec.ideas.length > 0 ? plainCount(sec.ideas.length, 'idea') : null,
    sec.parked.length > 0 ? `${sec.parked.length} parked` : null,
    sec.done.length > 0 ? `${sec.done.length} done` : null,
  ].filter((x): x is string => x !== null);
  const fold = (label: string, cards: ProjectCard[]) => {
    const open = cards.some((c) => c.project.name === selected);
    return html`<li><details class="fold"${open ? html` open` : ''}><summary class="row nolead">${label}<span class="chev"></span></summary><ul class="fold-list">${cards.map((c) => row(c, now, selected))}</ul></details></li>`;
  };
  if (rest.length === 0 && sec.lifeAreas.length === 0) return html``;
  return html`<ul class="group pfolds">${rest.length > 0 ? fold(parts.join(' · '), rest) : ''}${sec.lifeAreas.length > 0 ? fold(`Areas of life: ${sec.lifeAreas.map((c) => c.project.name).join(', ')}`, sec.lifeAreas) : ''}</ul>`;
}

/** One area of the Projects page: its live projects as tiles (compact rows beside an open project), the rest folded. */
function areaSection(sec: AreaSection, now: Date, selected: string | undefined, mode: ListMode): SafeHtml {
  const key = AREA_KEY(sec.area);
  const label = sec.area ? AREA_LABELS[sec.area] : 'Unsorted';
  const live = sec.live.length === 0 ? html``
    : mode === 'home' ? html`<ul class="pcards ptiles">${sec.live.map((c) => tile(c, now, selected))}</ul>`
    : html`<ul class="group prows">${sec.live.map((c) => row(c, now, selected))}</ul>`;
  return html`<section class="parea" aria-labelledby="pa-${key}"><h2 id="pa-${key}">${areaRing(sec.area)}${label}${sec.live.length > 0 ? html` <span class="n">${sec.live.length}</span>` : ''}</h2>
  ${live}${areaFolds(sec, now, selected)}</section>`;
}

/**
 * The last row: All discussions. It carries, hidden, its count (shown from 1100 px); on the plain home also, for the
 * 1920 px shelf, the first three titles and "N more" or "Open".
 */
function allDiscussions(items: { id: string; title: string }[], mode: ListMode): SafeHtml {
  const plain = mode === 'home';
  return html`<li><a class="row nolead" href="/discussions"><span class="txt"><b>All discussions</b>${items.length > 0 ? html`<span class="n" hidden>${items.length}</span>` : ''}</span><span class="chev"></span></a>${plain && items.length > 0 ? html`<ul class="shelf-names" hidden>${items.slice(0, 3).map((d) => html`<li><a href="/discussions/${d.id}">${d.title}</a></li>`)}</ul>` : ''}${plain ? shelfMore('/discussions', items.length) : ''}</li>`;
}

function stateButtons(p: Project): SafeHtml {
  const to = (state: string, label: string) =>
    html`<form method="post" action="${action(p.name, 'state')}"><input type="hidden" name="state" value="${state}"><button type="submit" class="${state === 'archived' ? 'danger' : 'sm'}">${label}</button></form>`;
  const pin = p.state === 'open'
    ? html`<form method="post" action="${action(p.name, p.pinnedAt ? 'unpin' : 'pin')}"><button type="submit" class="sm">${p.pinnedAt ? 'Unpin' : 'Pin to the top'}</button></form>`
    : html``;
  const byState: Record<Project['state'], SafeHtml> = {
    idea: html`${to('open', 'Start it')}${to('archived', 'Archive')}`,
    open: html`${pin}${to('parked', 'Park')}${to('done', 'Mark done')}${to('archived', 'Archive')}`,
    parked: html`${to('open', 'Reopen')}${to('done', 'Mark done')}${to('archived', 'Archive')}`,
    done: html`${to('open', 'Reopen')}${to('archived', 'Archive')}`,
    archived: to('open', 'Reopen'),
  };
  return html`<div class="panel-actions">${byState[p.state]}</div>`;
}

/** A long status is cut to its first few lines; "Read all" opens the rest in place. */
const LEFT_OFF_SHOWN = 280;
function leftOff(text: string): SafeHtml {
  if (text.length <= LEFT_OFF_SHOWN + 40) return html`<p class="leftoff">${text}</p>`;
  const cut = text.slice(0, LEFT_OFF_SHOWN);
  const short = `${cut.slice(0, Math.max(cut.lastIndexOf(' '), LEFT_OFF_SHOWN - 40))}…`;
  return html`<details class="leftoff-more"><summary><span class="leftoff">${short}</span><span class="read-all">Read all</span></summary><p class="leftoff">${text}</p></details>`;
}

/** A status as the owner reads it: a dot (or a dash for not needed) and its words. */
const areaStatus = (s: ShownStatus): SafeHtml =>
  s === 'not_needed' ? html`<span class="adash" aria-hidden="true">–</span>` : html`<span class="pdot a-st-${s}" aria-hidden="true"></span>`;

/**
 * The project's five areas (spec 2026-11-11): each with its status, the developer term, the note and when, the why one tap
 * away, and a small form for the owner; then the handbook topics applied on the project.
 */
function fiveAreas(name: string, d: ProjectDetail, now: Date): SafeHtml {
  if (d.areas === null) return html``;
  // No status is preselected: one Save without choosing must never mark an area done.
  const option = (v: CheckStatus) => html`<option value="${v}">${STATUS_LABELS[v]}</option>`;
  return html`<h3 id="p-areas">Five areas</h3>
  <ul class="areas plain-list">${d.areas.map((a) => html`<li class="area-row">
    <div class="area-head">${areaStatus(a.status)}<b>${CHECK_LABELS[a.area].name}</b><span class="area-term">${CHECK_LABELS[a.area].term}</span><span class="area-st">${STATUS_LABELS[a.status]}${a.snoozedUntil ? html` · not now until ${longDate(new Date(a.snoozedUntil))}` : ''}</span></div>
    ${a.note ? html`<p class="area-note">${a.note}${a.setAt ? html` <span class="quiet">· ${a.setBy === 'owner' ? 'you' : a.setBy}, ${timeAgo(a.setAt, now)}</span>` : ''}</p>` : ''}
    <details class="area-why"><summary>Why<span class="chev"></span></summary><p>${CHECK_LABELS[a.area].why}</p>
      <form method="post" action="${action(name, `areas/${a.area}`)}" class="area-set">
        <label>Status <select name="status" required><option value="" disabled selected>Choose…</option>${CHECK_STATUSES.map((v) => option(v))}</select></label>
        <label>Note <input name="note" maxlength="${MAX_NOTE}" value="${a.source === 'hand' ? a.note ?? '' : ''}" placeholder="What was done, or why it isn't needed"></label>
        <button type="submit" class="sm">Save</button>
      </form>
    </details>
  </li>`)}</ul>
  ${d.handbook.length > 0 ? html`<h3 id="p-handbook">Handbook</h3><ul class="plain-list handbook">${d.handbook.map((t) => html`<li>${t.pageId ? html`<a href="/pages/${t.pageId}">${t.title}</a>` : t.title} <span class="quiet">· ${{ seen: 'seen', helped: 'done with help', alone: 'done alone' }[t.level]}</span></li>`)}</ul>` : ''}`;
}

function panel(d: ProjectDetail, now: Date, error?: string): SafeHtml {
  const p = d.card.project;
  /** The panel's own address, so the facts and pages it links come back here. */
  const self = `/?project=${encodeURIComponent(p.name)}`;
  const state = p.pinnedAt ? 'Pinned' : { idea: 'Idea', open: 'Open', parked: 'Parked', done: 'Done', archived: 'Archived' }[p.state];
  // The jump row: one chip per part that has something; a 0 drops its chip, and nothing at all drops the row.
  const chips: [string, number][] = [['Waiting', d.waiting.length], ['Disagree', d.disagreements.length], ['Pages', d.pages.length], ['Discussions', d.discussionsTotal], ['Facts', d.facts.total]];
  const jump = chips.every(([, n]) => n === 0) ? html`` : html`<nav class="jump" aria-label="In this project">${chips
    .filter(([, n]) => n > 0)
    .map(([word, n]) => html`<a href="#p-${word.toLowerCase()}">${word} ${n}</a>`)}</nav>`;
  // Nothing waiting: the section is left out (an empty state only where the section is the screen's purpose).
  const waiting = d.waiting.length === 0 ? html``
    : html`<h3 id="p-waiting">Waiting on you</h3><ul class="checks">${d.waiting.map((w) => html`<li><form method="post" action="${action(p.name, `waiting/${w.index}/done`)}">
      <input type="hidden" name="text" value="${w.text}">
      <button type="submit" class="check" aria-label="Mark done: ${w.text}"></button></form>
      <span class="check-text">${w.text}</span>${w.due ? dueChip(w.due, day(now)) : ''}</li>`)}</ul>`;
  const doneToday = d.doneToday.length === 0 ? html`` : html`<h3>Done today</h3><ul class="checks done">${d.doneToday.map((x) => html`<li>
      <span class="check is-done" aria-hidden="true"></span><span class="check-text">${x.text}</span>
      <form method="post" action="${action(p.name, `done/${x.index}/undo`)}"><input type="hidden" name="text" value="${x.text}"><button type="submit" class="ghost small" aria-label="Undo done: ${x.text}">Undo</button></form></li>`)}</ul>`;
  const g = d.folder;
  const gitline = g === null ? null : html`<li class="gitline">Folder <code>~/Projects/${g.name}</code> · ${g.git
    ? html`${g.branch ?? 'no branch'} · ${g.uncommitted === null || g.unpushed === null ? 'git state unknown (git did not answer on the Mac)' : html`${g.uncommitted} uncommitted · ${g.unpushed} not pushed`}${g.lastCommit ? html` · last commit ${timeAgo(g.lastCommit, now)}` : ' · no commits yet'}`
    : 'not a git repo'}${g.reportedAt && now.getTime() - Date.parse(g.reportedAt) > DAY_MS ? html` · <strong class="late-text">last report from the Mac ${pastLabel(g.reportedAt, now)}</strong>` : ''}</li>`;
  const lives = [gitline ?? (p.folder ? html`<li>Folder <code>~/Projects/${p.folder}</code></li>` : html``),
    ...p.remotes.map((r) => html`<li>Remote <code>${r}</code></li>`),
    p.url ? html`<li><a href="${p.url}" rel="noreferrer">${p.url}</a></li>` : html``];
  const rowLink = (href: string, text: string) => html`<a class="row nolead" href="${href}"><span class="txt">${text}</span><span class="chev"></span></a>`;
  return html`<section id="panel" class="ppanel" aria-labelledby="panel-title">
  <a class="ppanel-back" href="/">‹ All projects</a>
  <h2 id="panel-title">${p.name}</h2>
  ${errorBlock(error)}
  ${metaLine([p.oneLiner ?? 'No one-liner yet', html`${areaDot(p)} ${areaName(p)}`, state, d.card.notPushed ? html`<span class="chip plain">not pushed</span>` : null], { big: true })}
  ${jump}
  <h3>Where you left off${d.leftOff ? html` <span class="quiet">· ${pastLabel(d.leftOff.updatedAt, now)}</span>` : ''}</h3>
  ${d.leftOff ? leftOff(d.leftOff.content) : d.card.roadmap?.now ? html`<p class="leftoff">${d.card.roadmap.now}</p>` : html`<p class="quiet">No status saved yet.</p>`}
  ${waiting}
  ${disagreeGroup(p.name, d.disagreements, now)}
  ${doneToday}
  ${d.nextSteps.length > 0 ? html`<h3>Then</h3><ol class="then">${d.nextSteps.map((s) => html`<li>${s}</li>`)}</ol>` : ''}
  ${fiveAreas(p.name, d, now)}
  ${d.pages.length > 0 ? html`<h3 id="p-pages">Pages</h3>
  <ul class="ppages plain-list">${d.pages.map((x) => html`<li><a href="${withFrom(`/pages/${x.id}`, self)}">${x.title}</a>${x.mayBeOutOfDate ? html` ${staleChip()}` : ''}</li>`)}</ul>` : ''}
  ${d.discussions.length > 0 ? html`<h3 id="p-discussions">Discussions</h3>
  <ul class="pdiscs plain-list">${d.discussions.map((x) => html`<li${x.needsYou ? html` class="you"` : ''}><a href="/discussions/${x.id}">${x.title}</a><span class="pdisc-label">${x.label}</span></li>`)}</ul>` : ''}
  ${d.facts.total > 0 ? html`<h3 id="p-facts">Facts <span class="n">${d.facts.total}</span></h3>
  <ul class="pfacts plain-list">${d.facts.newest.map((m) => html`<li><a href="${withFrom(`/memories/${m.id}`, self)}">${stripProjectPrefix(m.content, p.name)}${d.facts.replaces[m.id] ? html`<span class="tag-replaces">replaces ${d.facts.replaces[m.id]}</span>` : ''}</a>${metaLine([writer(m.updatedBy), timeAgo(m.updatedAt, now)])}</li>`)}</ul>` : ''}
  ${replacedFold(p.name, d.replaced, now, self)}
  ${d.facts.total > 0 ? rowLink(`/facts?project=${encodeURIComponent(p.name)}`, `All ${d.facts.total} ${p.name} facts`) : ''}
  ${rowLink(`/graph?project=${encodeURIComponent(p.name)}`, `See ${p.name} in the graph`)}
  <details class="fold manage"><summary class="row nolead">Manage<span class="chev"></span></summary>
  ${stateButtons(p)}
  <h3>Where it lives</h3>
  <ul class="lives">${lives}</ul>
  <details class="pinfo"><summary>Edit details<span class="chev"></span></summary>
    <form method="post" action="${action(p.name, 'info')}" class="stack">
      <label>One-liner <input name="oneLiner" maxlength="140" value="${p.oneLiner ?? ''}"></label>
      <label>Area <select name="area"><option value="">Unsorted</option>${AREAS.map((a) => html`<option value="${a}"${p.area === a ? html` selected` : ''}>${AREA_LABELS[a]}</option>`)}</select></label>
      <label>Folder in ~/Projects <input name="folder" maxlength="120" value="${p.folder ?? ''}"></label>
      <label>URL <input name="url" type="url" maxlength="300" value="${p.url ?? ''}"></label>
      <label>Runs on <input name="runsOn" maxlength="120" placeholder="minipc, pi" value="${p.runsOn.join(', ')}"></label>
      <label>Nicknames <input name="nicknames" maxlength="340" placeholder="comma-separated" value="${p.nicknames.join(', ')}"></label>
      <button type="submit">Save</button>
    </form>
  </details>
  ${rowLink(`/pages/new?project=${encodeURIComponent(p.name)}`, 'New page')}
  ${rowLink(`/memories/new?project=${encodeURIComponent(p.name)}`, 'Add a fact')}
  <button type="button" class="continue secondary" data-copy="${d.continueCommand}">Continue in Claude Code<code>${d.continueCommand}</code></button>
  </details>
</section>`;
}

/** Folders on the Mac that no project matched (add one as a project, or ignore it), and the ignored ones with Undo. */
function notInBrain(v: Home['folders'], ignored: { key: string; name: string }[], plain: boolean): SafeHtml {
  if (v.unmatched.length === 0 && ignored.length === 0) return html``;
  // On the plain home the summary also carries, hidden, the 1920 px shelf's peek: three folders and "Ignored N".
  const peek = plain ? html`<span class="nib-peek" hidden>${v.unmatched.slice(0, 3).map((f) => html`<span>${f.name}</span>`)}${ignored.length > 0 ? html`<span class="nib-peek-more">Ignored ${ignored.length}<span class="chev"></span></span>` : ''}</span>` : '';
  return html`<li><details class="fold notinbrain" id="notyet"><summary class="row nolead">Not in the brain yet${v.unmatched.length > 0 ? html`<span class="n">${v.unmatched.length}</span>` : ''}${peek}<span class="chev"></span></summary>
<p class="nib-intro">Folders in ~/Projects that no project matches. Last report from ${v.device ?? 'the Mac'}${v.receivedAt ? html` ${timeAgo(v.receivedAt)}` : ''}.</p>
${v.unmatched.length > 0 ? html`<ul class="rows nib">${v.unmatched.map((f) => html`<li><span class="nib-name">${f.name}</span><span class="quiet">${f.git ? 'git' : 'not a git repo'}</span>
<form method="post" action="/folders/add"><input type="hidden" name="name" value="${f.name}"><button type="submit" class="sm" aria-label="Add as project: ${f.name}">Add as project</button></form>
<form method="post" action="/folders/ignore"><input type="hidden" name="name" value="${f.name}"><button type="submit" class="ghost sm" aria-label="Ignore ${f.name}">Ignore</button></form></li>`)}</ul>` : ''}
${ignored.length > 0 ? html`<h3 class="nib-ignored">Ignored <span class="n">${ignored.length}</span></h3>
<ul class="rows nib">${ignored.map((x) => html`<li><span class="nib-name">${x.name}</span>
<form method="post" action="/folders/unignore"><input type="hidden" name="name" value="${x.key}"><button type="submit" class="ghost sm" aria-label="Undo ignoring ${x.name}">Undo</button></form></li>`)}</ul>` : ''}
</details></li>`;
}

/** The Monday line: last week in one sentence, with Read it and Not now. */
export interface WeekLine { monday: string; dates: string; text: string }

/** What the Projects screen is drawn from. */
export interface HomeViewInput {
  home: Home; selected: ProjectDetail | undefined; approvals: ApprovalSummary; discussionsWaiting?: { id: string; title: string }[]; backupProblem: string | null; now: Date; error?: string;
  weekLine?: WeekLine | null;
  /** Folders the owner ignored, each with an Undo under "Not in the brain yet". */
  ignored?: { key: string; name: string }[];
  /** Every discussion, in the Discussions list's order: the All discussions shelf on a wide screen. */
  discussions?: { id: string; title: string }[];
  /** Whether any assistant has ever been connected; a new brain with none points to that first step. */
  connected?: boolean;
  /** B1: how many pairs of facts disagree, not settled yet. */
  disagreements?: number;
  /** B1: brain health, for its For you row. */
  health?: Health;
}

/**
 * Which list: the plain home ('home', no project open), or the list beside an open project ('list'), which is also the
 * desktop's list pane (GET /?pane=projects). Only 'home' carries the desktop home's hooks (the date, shelves, peeks).
 */
export type ListMode = 'home' | 'list';

export function projectsHomeView(v: HomeViewInput): SafeHtml {
  return html`<div class="phome wide${v.selected ? ' has-panel' : ''}">
${projectList(v, v.selected ? 'list' : 'home')}
${v.selected ? panel(v.selected, v.now, v.error) : ''}
</div>`;
}

/** The Projects list, `<div class="plist">…</div>`: the plain home's main column, or the list beside an open project. */
export function projectList(v: HomeViewInput, mode: ListMode): SafeHtml {
  const { home, now } = v;
  const sel = v.selected?.card.project.name;
  // System problems only, one at most: the backup warning. Approvals and discussions are For-you rows.
  const banner = v.backupProblem ? html`<div class="banner warn"><span class="dot attention" aria-hidden="true"></span><span class="txt">${v.backupProblem}</span><a class="button sm" href="/settings#health">Look</a></div>` : '';
  const forYou = forYouCard(forYouRows({ approvals: v.approvals, disagreements: v.disagreements ?? 0, health: v.health, discussions: v.discussionsWaiting ?? [], weekLine: v.weekLine ?? null, suggestions: home.suggestions }));
  const empty = home.sections.length === 0;
  const plain = mode === 'home';
  return html`<div class="plist">
  <h1>Projects${plain ? html`<span class="phome-date" hidden>${longDate(now)}</span>` : ''}</h1>
  ${errorBlock(v.error)}
  ${banner}
  <form method="post" action="/projects/ideas" class="idea"><label class="visually-hidden" for="idea-text">A new idea</label><input id="idea-text" name="text" maxlength="140" placeholder="An idea…" autocomplete="off"><button type="submit" class="primary">Add idea</button></form>
  ${forYou.value === '' ? '' : html`<h2 class="fy-h" id="foryou" hidden>For you</h2>`}${forYou}
  ${!empty ? '' : v.connected === false
    ? html`<div class="quiet empty"><p>No projects yet. Connect an assistant, and what it saves appears here.</p><p class="first-step"><a class="button" href="/settings#setup">Connect your first assistant</a></p></div>`
    : html`<p class="quiet empty">No projects yet. They appear here as soon as an assistant saves something about one.</p>`}
  ${home.sections.length > 0 ? html`<div class="pareas">${home.sections.map((sec) => areaSection(sec, now, sel, mode))}</div>` : ''}
  <ul class="group pfolds pextra"><li><a class="row nolead map-link" href="/map"><span class="txt"><b>Map</b> · every project against the five areas</span><span class="chev"></span></a></li>${notInBrain(home.folders, v.ignored ?? [], plain)}${allDiscussions(v.discussions ?? [], mode)}</ul>
</div>`;
}
