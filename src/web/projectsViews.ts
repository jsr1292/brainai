import { CHECK_STATUSES, MAX_NOTE, type CheckArea, type CheckStatus, type ShownStatus } from '../learning/types.js';
import { t, tHtml, tKey } from '../i18n/index.js';
import type { Health } from '../health/health.js';
import type { Health as ProjectHealth, HealthReason } from '../projects/health.js';
import type { AreaSection, Home, HomeSuggestion, PanelDiscussion, ProjectCard, ProjectDetail } from '../projects/service.js';
import { localDay, longDate, shortDay } from '../timezone.js';
import { AREAS, type Area, type Project } from '../projects/types.js';
import { withFrom } from './back.js';
import { errorBlock, plural, writer } from './dashboardViews.js';
import { replacedFold } from './factViews.js';
import { html, type SafeHtml } from './html.js';
import { forYouCard, forYouRows, type ApprovalSummary } from './forYou.js';
import { disagreeGroup } from './disagreeViews.js';
import { staleChip } from './freshnessViews.js';
import { metaLine } from './metaLine.js';
import type { MondayCard } from './mondayCard.js';
import { coachingShown } from './sideStatus.js';
import { stripProjectPrefix } from './stripProject.js';
import { calendar, dueChip, pastLabel, timeAgo } from './when.js';

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
  return c.waiting > 0 ? html`<span class="chip you">${t('projects.forCount', { count: c.waiting })}</span>` : html``;
}

/** An area's hollow ring (writers get a filled dot). Unsorted is a grey ring. */
export const areaRing = (area: string | null): SafeHtml => html`<span class="ring a-${area ?? 'unsorted'}" aria-hidden="true"></span>`;
const areaDot = (p: Project): SafeHtml => areaRing(p.area);
export const placeName = (area: Area | null): string => (area ? tKey(`projects.place.${area}`) : t('projects.place.unsorted'));
const areaName = (p: Project): string => placeName(p.area);
/** The five areas' words (name, developer term, why) and the status words, in the owner's language. */
export const checkName = (a: CheckArea): string => tKey(`projects.area.${a}.name`);
export const checkTerm = (a: CheckArea): string => tKey(`projects.area.${a}.term`);
export const checkWhy = (a: CheckArea): string => tKey(`projects.area.${a}.why`);
export const statusWord = (s: ShownStatus): string => tKey(`projects.status.${s}`);

/** The state dot: green while it is being worked on, amber when something waits on the owner, grey when quiet. */
const dotLabel = (dot: ProjectCard['dot']): string => tKey(`projects.dot.${dot}`);
const stateDot = (c: ProjectCard): SafeHtml => html`<span class="pdot d-${c.dot}" role="img" aria-label="${dotLabel(c.dot)}" title="${dotLabel(c.dot)}"></span>`;
/** The one learning mark on the home page: work that exists only on the Mac (spec 2026-11-11). */
const safeMark = (c: ProjectCard): SafeHtml => {
  if (!c.safeWarning || !coachingShown()) return html``;
  const why = c.notPushed ? t('projects.notSafe.notPushed') : t('projects.notSafe.notGit');
  return html`<span class="pwarn" role="img" aria-label="${why}" title="${why}">!</span>`;
};

const HEALTH_CLASS = { needs_you: 'hl-needs', at_risk: 'hl-risk', stuck: 'hl-stuck', on_track: 'hl-ok' } as const;
/** One reason as a plain sentence in the owner's language. */
export function healthReason(r: HealthReason, now: Date): string {
  // A due date is a calendar day with no zone: formatted as one (like dueLabel), never as an instant.
  const date = (due: string): string => calendar(due, Number(day(now).slice(0, 4)));
  switch (r.kind) {
    case 'needs_you': return r.days < 0 ? t('projects.health.r.late', { text: r.text, date: date(r.due) }) : t('projects.health.r.due', { text: r.text, date: date(r.due) });
    case 'at_risk': return r.count > 0 ? t('projects.health.r.unpushed', { count: r.count }) : t('projects.health.r.uncommitted', { count: r.uncommitted });
    case 'stuck': return t('projects.health.r.stuck', { days: r.days, next: r.next });
  }
}
/**
 * The health label: a small chip with its reasons as the tooltip (a screen reader gets them from `healthWhy`, below, or from
 * the lines beside it on the project page). "On track" has no reasons and is drawn quietly (no fill). Nothing for a project
 * that has no health (not open).
 */
export function healthChip(h: ProjectHealth | null, now: Date): SafeHtml {
  if (h === null) return html``;
  const label = tKey(`projects.health.${h.state}`);
  if (h.reasons.length === 0) return html`<span class="hl ${HEALTH_CLASS[h.state]}" data-health="${h.state}">${label}</span>`;
  const why = h.reasons.map((r) => healthReason(r, now));
  return html`<span class="chip hl ${HEALTH_CLASS[h.state]}" data-health="${h.state}" title="${why.join('\n')}">${label}</span>`;
}
/**
 * For a list row or tile (the whole thing is one link): the reasons as a hidden text the link is described by, so the link's
 * own name stays the project's name. `attr` goes on the link, `node` inside it.
 */
function healthWhy(c: ProjectCard, now: Date): { attr: SafeHtml; node: SafeHtml } {
  if (!c.health || c.health.reasons.length === 0) return { attr: html``, node: html`` };
  const id = `hw-${c.project.name}`;
  return { attr: html` aria-describedby="${id}"`, node: html`<span id="${id}" hidden>${c.health.reasons.map((r) => healthReason(r, now)).join(' ')}</span>` };
}
const has = (c: ProjectCard, kind: HealthReason['kind']): boolean => c.health?.reasons.some((r) => r.kind === kind) ?? false;
/** The health chip already says it: a late or soon waiting item (needs you), and work only on the Mac (at risk). */
const waitShown = (c: ProjectCard, now: Date, only = false): SafeHtml => (c.health?.state === 'needs_you' ? html`` : only ? dueOnly(c, now) : waitChip(c, now));
const markShown = (c: ProjectCard): SafeHtml => (c.notPushed && has(c, 'at_risk') ? html`` : safeMark(c));
/** The project page's header: the label and each reason as its own short line. */
const healthLines = (h: ProjectHealth | null, now: Date): SafeHtml => h === null ? html`` : html`<div class="phealth">${healthChip(h, now)}${h.reasons.length > 0 ? html`<ul class="phealth-why plain-list">${h.reasons.map((r) => html`<li>${healthReason(r, now)}</li>`)}</ul>` : ''}</div>`;

/** A live project as a tile: dot and name (and the warning mark), the one-liner, the next step. */
function tile(c: ProjectCard, now: Date, selected: string | undefined): SafeHtml {
  const p = c.project;
  const why = healthWhy(c, now);
  return html`<li><a class="pcard ptile${selected === p.name ? ' is-selected' : ''}" href="${panelHref(p.name)}"${selected === p.name ? html` aria-current="true"` : ''}${why.attr}>
  <span class="ptile-head">${stateDot(c)}<span class="pcard-name">${p.name}</span>${healthChip(c.health, now)}${waitShown(c, now, true)}${markShown(c)}</span>${why.node}
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
  const note = c.newActivity ? html`<span class="row-note">${t('projects.newActivity')}</span>`
    : c.quietDays !== null ? html`<span class="row-note">${c.quietDays < 21 ? t('projects.quietDays', { count: c.quietDays }) : t('projects.quietWeeks', { count: Math.floor(c.quietDays / 7) })}</span>` : html``;
  // The waiting chip and the work-not-safe mark side by side: the mark is the one signal never dropped (unless the health chip already says it).
  const chip = html`${healthChip(c.health, now)}${waitShown(c, now)}${markShown(c)}`;
  const why = healthWhy(c, now);
  return html`<li><a class="row prow${selected === p.name ? ' is-selected' : ''}" href="${panelHref(p.name)}"${selected === p.name ? html` aria-current="true"` : ''}${why.attr}>${why.node}${stateDot(c)}<span class="prow-name">${p.name}</span>${one ? html`<span class="prow-one" hidden>${p.oneLiner ?? ''}</span>` : ''}<span class="prow-next">${c.next ?? p.oneLiner ?? (c.roadmap ? '' : html`<span class="quiet">${t('projects.noRoadmap')}</span>`)}${note}</span><span class="prow-chip">${chip}</span><span class="prow-when">${pastLabel(c.lastTouched, now)}</span></a></li>`;
}

/** A shelf's last line (desktop, 1920 px and up; hidden below): "N more" past the three names it shows, else "Open". */
const shelfMore = (href: string, count: number): SafeHtml =>
  html`<a class="shelf-more" href="${href}" hidden>${count > 3 ? t('projects.shelf.more', { count: count - 3 }) : t('projects.shelf.open')}<span class="chev"></span></a>`;

const AREA_KEY = (area: string | null): string => area ?? 'unsorted';

/**
 * The fold line under an area: "+3 quiet · 1 idea · 2 parked · 1 done" (only what there is), opening in place to their
 * rows; open when it holds the selected project. Personal adds its areas of life as one more line.
 */
function areaFolds(sec: AreaSection, now: Date, selected: string | undefined): SafeHtml {
  const rest = [...sec.quiet, ...sec.ideas, ...sec.parked, ...sec.done];
  const parts = [
    sec.quiet.length > 0 ? t('projects.fold.quiet', { count: sec.quiet.length }) : null,
    sec.ideas.length > 0 ? t('projects.fold.ideas', { count: sec.ideas.length }) : null,
    sec.parked.length > 0 ? t('projects.fold.parked', { count: sec.parked.length }) : null,
    sec.done.length > 0 ? t('projects.fold.done', { count: sec.done.length }) : null,
  ].filter((x): x is string => x !== null);
  const fold = (label: string, cards: ProjectCard[]) => {
    const open = cards.some((c) => c.project.name === selected);
    return html`<li><details class="fold"${open ? html` open` : ''}><summary class="row nolead">${label}<span class="chev"></span></summary><ul class="fold-list">${cards.map((c) => row(c, now, selected))}</ul></details></li>`;
  };
  if (rest.length === 0 && sec.lifeAreas.length === 0) return html``;
  return html`<ul class="group pfolds">${rest.length > 0 ? fold(parts.join(' · '), rest) : ''}${sec.lifeAreas.length > 0 ? fold(t('projects.fold.life', { names: sec.lifeAreas.map((c) => c.project.name).join(', ') }), sec.lifeAreas) : ''}</ul>`;
}

/** One area of the Projects page: its live projects as tiles (compact rows beside an open project), the rest folded. */
function areaSection(sec: AreaSection, now: Date, selected: string | undefined, mode: ListMode): SafeHtml {
  const key = AREA_KEY(sec.area);
  const label = placeName(sec.area);
  const live = sec.live.length === 0 ? html``
    : mode === 'home' ? html`<ul class="pcards ptiles">${sec.live.map((c) => tile(c, now, selected))}</ul>`
    : html`<ul class="group prows">${sec.live.map((c) => row(c, now, selected))}</ul>`;
  return html`<section class="parea" aria-labelledby="pa-${key}"><h2 id="pa-${key}">${areaRing(sec.area)}${label}${sec.live.length > 0 ? html` <span class="n">${sec.live.length}</span>` : ''}</h2>
  ${live}${areaFolds(sec, now, selected)}</section>`;
}

/** The Monday card: "Your week, 26 Oct – 1 Nov", the one-sentence summary, three numbers, and Read it / Not now (both POSTs, nothing is marked by a GET). */
function mondayCard(m: MondayCard): SafeHtml {
  const stat = (n: number, key: 'done' | 'waiting' | 'stuck') => html`<div class="mc-stat"><dt class="mc-l">${tKey(`projects.monday.${key}`, { count: n })}</dt><dd class="mc-n">${n}</dd></div>`;
  return html`<section class="monday-card" aria-labelledby="monday-h"><h2 id="monday-h">${t('projects.monday.title', { dates: m.dates })}</h2>
  <p class="mc-text">${m.text}</p>
  <dl class="mc-stats">${stat(m.done, 'done')}${stat(m.waiting, 'waiting')}${stat(m.stuck, 'stuck')}</dl>
  <div class="mc-actions"><form method="post" action="/review/${m.monday}/open"><button type="submit" class="secondary">${t('projects.monday.read')}</button></form><form method="post" action="/review/${m.monday}/dismiss"><button type="submit" class="ghost">${t('projects.foryou.notNow')}</button></form></div>
</section>`;
}

/**
 * The last row: All discussions. It carries, hidden, its count (shown from 1100 px); on the plain home also, for the
 * 1920 px shelf, the first three titles and "N more" or "Open".
 */
function allDiscussions(items: { id: string; title: string }[], mode: ListMode): SafeHtml {
  const plain = mode === 'home';
  return html`<li><a class="row nolead" href="/discussions"><span class="txt"><b>${t('projects.allDiscussions')}</b>${items.length > 0 ? html`<span class="n" hidden>${items.length}</span>` : ''}</span><span class="chev"></span></a>${plain && items.length > 0 ? html`<ul class="shelf-names" hidden>${items.slice(0, 3).map((d) => html`<li><a href="/discussions/${d.id}">${d.title}</a></li>`)}</ul>` : ''}${plain ? shelfMore('/discussions', items.length) : ''}</li>`;
}

function stateButtons(p: Project): SafeHtml {
  const to = (state: string, label: string) =>
    html`<form method="post" action="${action(p.name, 'state')}"><input type="hidden" name="state" value="${state}"><button type="submit" class="${state === 'archived' ? 'danger' : 'sm'}">${label}</button></form>`;
  const pin = p.state === 'open'
    ? html`<form method="post" action="${action(p.name, p.pinnedAt ? 'unpin' : 'pin')}"><button type="submit" class="sm">${p.pinnedAt ? t('projects.act.unpin') : t('projects.act.pin')}</button></form>`
    : html``;
  const byState: Record<Project['state'], SafeHtml> = {
    idea: html`${to('open', t('projects.act.start'))}${to('archived', t('projects.act.archive'))}`,
    open: html`${pin}${to('parked', t('projects.act.park'))}${to('done', t('projects.act.markDone'))}${to('archived', t('projects.act.archive'))}`,
    parked: html`${to('open', t('projects.act.reopen'))}${to('done', t('projects.act.markDone'))}${to('archived', t('projects.act.archive'))}`,
    done: html`${to('open', t('projects.act.reopen'))}${to('archived', t('projects.act.archive'))}`,
    archived: to('open', t('projects.act.reopen')),
  };
  return html`<div class="panel-actions">${byState[p.state]}</div>`;
}

/** A long status is cut to its first few lines; "Read all" opens the rest in place. */
const LEFT_OFF_SHOWN = 280;
function leftOff(text: string): SafeHtml {
  if (text.length <= LEFT_OFF_SHOWN + 40) return html`<p class="leftoff">${text}</p>`;
  const cut = text.slice(0, LEFT_OFF_SHOWN);
  const short = `${cut.slice(0, Math.max(cut.lastIndexOf(' '), LEFT_OFF_SHOWN - 40))}…`;
  return html`<details class="leftoff-more"><summary><span class="leftoff">${short}</span><span class="read-all">${t('projects.readAll')}</span></summary><p class="leftoff">${text}</p></details>`;
}

/** A status as the owner reads it: a dot (or a dash for not needed) and its words. */
const areaStatus = (s: ShownStatus): SafeHtml =>
  s === 'not_needed' ? html`<span class="adash" aria-hidden="true">–</span>` : html`<span class="pdot a-st-${s}" aria-hidden="true"></span>`;

/** The key to the area marks, drawn with the marks themselves (the panel's and the Five areas page's). */
export const areaKey = (): SafeHtml => html`<p class="key area-key" aria-label="${t('projects.areaKeyLabel')}"><span><span class="pdot a-st-done" aria-hidden="true"></span> ${t('projects.status.done')}</span><span><span class="pdot a-st-look" aria-hidden="true"></span> ${t('projects.status.look')}</span><span><span class="pdot a-st-todo" aria-hidden="true"></span> ${t('projects.status.todo')}</span><span><span class="pdot a-st-unknown" aria-hidden="true"></span> ${t('projects.status.unknown')}</span><span><span class="adash" aria-hidden="true">–</span> ${t('projects.status.not_needed')}</span></p>`;

/** The key to the state dots on the project cards: the words are the ones the dots carry as their labels. */
const dotKey = (): SafeHtml => html`<p class="key dot-key" aria-label="${t('projects.dotKeyLabel')}"><span><span class="pdot d-wait" aria-hidden="true"></span> ${dotLabel('wait')}</span><span><span class="pdot d-on" aria-hidden="true"></span> ${dotLabel('on')}</span><span><span class="pdot d-quiet" aria-hidden="true"></span> ${dotLabel('quiet')}</span></p>`;

/**
 * The project's five areas (spec 2026-11-11): each with its status, the developer term, the note and when, the why one tap
 * away, and a small form for the owner; then the handbook topics applied on the project.
 */
function fiveAreas(name: string, d: ProjectDetail, now: Date): SafeHtml {
  if (d.areas === null || !coachingShown()) return html``;
  // No status is preselected: one Save without choosing must never mark an area done.
  const option = (v: CheckStatus) => html`<option value="${v}">${statusWord(v)}</option>`;
  return html`<h3 id="p-areas">${t('projects.areas.title')}</h3>
  <p class="area-intro">${t('projects.areas.intro')}</p>
  ${areaKey()}
  <ul class="areas plain-list">${d.areas.map((a) => html`<li class="area-row">
    <div class="area-head">${areaStatus(a.status)}<b>${checkName(a.area)}</b><span class="area-term">${checkTerm(a.area)}</span><span class="area-st">${statusWord(a.status)}${a.snoozedUntil ? html` · ${t('projects.areas.notNow', { date: longDate(new Date(a.snoozedUntil)) })}` : ''}</span></div>
    ${a.note ? html`<p class="area-note">${a.note}${a.setAt ? html` <span class="quiet">· ${a.setBy === 'owner' ? t('projects.youLower') : a.setBy}, ${timeAgo(a.setAt, now)}</span>` : ''}</p>` : ''}
    <details class="area-why"><summary>${t('projects.areas.why')}<span class="chev"></span></summary><p>${checkWhy(a.area)}</p>
      <form method="post" action="${action(name, `areas/${a.area}`)}" class="area-set">
        <label>${t('projects.areas.status')} <select name="status" required><option value="" disabled selected>${t('projects.areas.choose')}</option>${CHECK_STATUSES.map((v) => option(v))}</select></label>
        <label>${t('projects.areas.note')} <input name="note" maxlength="${MAX_NOTE}" value="${a.source === 'hand' ? a.note ?? '' : ''}" placeholder="${t('projects.areas.notePlaceholder')}"></label>
        <button type="submit" class="sm">${t('projects.save')}</button>
      </form>
    </details>
  </li>`)}</ul>
  ${d.handbook.length > 0 ? html`<h3 id="p-handbook">${t('projects.learned')}</h3><ul class="plain-list handbook">${d.handbook.map((topic) => html`<li>${topic.pageId ? html`<a href="/pages/${topic.pageId}">${topic.title}</a>` : topic.title} <span class="quiet">· ${tKey(`projects.level.${topic.level}`)}</span></li>`)}</ul>` : ''}`;
}

/** The roadmap's Now line above what waits on the owner: "NOW · step · step 3 of 4", with the week review's small bar. */
function nowLine(r: { now: string | null; progress: { done: number; total: number } | null } | null | undefined): SafeHtml {
  if (!r?.now) return html``;
  const p = r.progress;
  return html`<p class="pnow"><span class="eyebrow">${t('projects.now')}</span> · <span class="pnow-step">${r.now}</span>${p ? html` · <span class="progress"><progress value="${p.done}" max="${p.total}">${t('projects.progress', { done: p.done, total: p.total })}</progress>${t('projects.step', { done: p.done, total: p.total })}</span>` : ''}</p>`;
}

/** A discussion's label in the panel, worded from the service's structured fields (`round`, `waitingFor`, `closedAt`). */
function discLabel(x: PanelDiscussion, now: Date): string {
  if (!x.open) return x.closedAt ? t('projects.disc.decided', { day: shortDay(x.closedAt, now) }) : t('projects.disc.decidedBare');
  return x.waitingFor.length > 0 ? t('projects.disc.waiting', { round: x.round, who: x.waitingFor.join(', ') }) : t('projects.disc.ready', { round: x.round });
}

function panel(d: ProjectDetail, now: Date, error?: string): SafeHtml {
  const p = d.card.project;
  /** The panel's own address, so the facts and pages it links come back here. */
  const self = `/?project=${encodeURIComponent(p.name)}`;
  const state = p.pinnedAt ? t('projects.state.pinned') : tKey(`projects.state.${p.state}`);
  // The jump row: one chip per part that has something; a 0 drops its chip, and nothing at all drops the row.
  const chips: ['waiting' | 'disagree' | 'pages' | 'discussions' | 'facts', number][] = [['waiting', d.waiting.length], ['disagree', d.disagreements.length], ['pages', d.pages.length], ['discussions', d.discussionsTotal], ['facts', d.facts.total]];
  const jump = chips.every(([, n]) => n === 0) ? html`` : html`<nav class="jump" aria-label="${t('projects.jump.label')}">${chips
    .filter(([, n]) => n > 0)
    .map(([id, n]) => html`<a href="#p-${id}">${tKey(`projects.jump.${id}`)} ${n}</a>`)}</nav>`;
  // Nothing waiting: the section is left out (an empty state only where the section is the screen's purpose).
  const waiting = d.waiting.length === 0 ? html``
    : html`<h3 id="p-waiting">${t('projects.waitingOnYou')}</h3><ul class="checks">${d.waiting.map((w) => html`<li><form method="post" action="${action(p.name, `waiting/${w.index}/done`)}">
      <input type="hidden" name="text" value="${w.text}">
      <button type="submit" class="check" aria-label="${t('projects.markDone', { text: w.text })}"></button></form>
      <span class="check-text">${w.text}</span>${w.due ? dueChip(w.due, day(now)) : ''}</li>`)}</ul>`;
  const doneToday = d.doneToday.length === 0 ? html`` : html`<h3>${t('projects.doneToday')}</h3><ul class="checks done">${d.doneToday.map((x) => html`<li>
      <span class="check is-done" aria-hidden="true"></span><span class="check-text">${x.text}</span>
      <form method="post" action="${action(p.name, `done/${x.index}/undo`)}"><input type="hidden" name="text" value="${x.text}"><button type="submit" class="ghost small" aria-label="${t('projects.undoDone', { text: x.text })}">${t('projects.undo')}</button></form></li>`)}</ul>`;
  const g = d.folder;
  const gitline = g === null ? null : html`<li class="gitline">${tHtml('projects.git.folder', { path: html`<code>~/Projects/${g.name}</code>` })} · ${g.git
    ? html`${g.branch ?? t('projects.git.noBranch')} · ${g.uncommitted === null || g.unpushed === null ? t('projects.git.unknown') : t('projects.git.counts', { uncommitted: g.uncommitted, unpushed: g.unpushed })}${g.lastCommit ? html` · ${tHtml('projects.git.lastCommit', { when: timeAgo(g.lastCommit, now) })}` : html` · ${t('projects.git.noCommits')}`}`
    : t('projects.git.notRepo')}${g.reportedAt && now.getTime() - Date.parse(g.reportedAt) > DAY_MS ? html` · <strong class="late-text">${t('projects.git.lateReport', { when: pastLabel(g.reportedAt, now) })}</strong>` : ''}</li>`;
  const lives = [gitline ?? (p.folder ? html`<li>${tHtml('projects.git.folder', { path: html`<code class="path">~/Projects/${p.folder}</code>` })}</li>` : html``),
    ...p.remotes.map((r) => html`<li>${tHtml('projects.remote', { remote: html`<code>${r}</code>` })}</li>`),
    p.url ? html`<li><a href="${p.url}" rel="noreferrer">${p.url}</a></li>` : html``];
  const rowLink = (href: string, text: string) => html`<a class="row nolead" href="${href}"><span class="txt">${text}</span><span class="chev"></span></a>`;
  return html`<section id="panel" class="ppanel" aria-labelledby="panel-title">
  <a class="ppanel-back" href="/">${t('projects.allProjects')}</a>
  <h2 id="panel-title">${p.name}</h2>
  ${errorBlock(error)}
  ${metaLine([p.oneLiner ?? t('projects.noOneLiner'), html`${areaDot(p)} ${areaName(p)}`, state, d.card.notPushed ? html`<span class="chip plain">${t('projects.notPushed')}</span>` : null], { big: true })}
  ${healthLines(d.card.health, now)}
  ${jump}
  <h3>${t('projects.leftOff')}${d.leftOff ? html` <span class="quiet">· ${pastLabel(d.leftOff.updatedAt, now)}</span>` : ''}</h3>
  ${d.leftOff ? leftOff(d.leftOff.content) : d.card.roadmap?.now ? html`<p class="leftoff">${d.card.roadmap.now}</p>` : html`<p class="quiet">${t('projects.noStatus')}</p>`}
  ${d.leftOff ? nowLine(d.card.roadmap) : ''}
  ${waiting}
  ${disagreeGroup(p.name, d.disagreements, now)}
  ${doneToday}
  ${d.nextSteps.length > 0 ? html`<h3>${t('projects.then')}</h3><ol class="then">${d.nextSteps.map((s) => html`<li>${s}</li>`)}</ol>` : ''}
  ${fiveAreas(p.name, d, now)}
  ${d.pages.length > 0 ? html`<h3 id="p-pages">${t('projects.pages')}</h3>
  <ul class="ppages plain-list">${d.pages.map((x) => html`<li><a href="${withFrom(`/pages/${x.id}`, self)}">${x.title}</a>${x.mayBeOutOfDate ? html` ${staleChip()}` : ''}</li>`)}</ul>` : ''}
  ${d.discussions.length > 0 ? html`<h3 id="p-discussions">${t('projects.discussions')}</h3>
  <ul class="pdiscs plain-list">${d.discussions.map((x) => html`<li${x.needsYou ? html` class="you"` : ''}><a href="/discussions/${x.id}">${x.title}</a><span class="pdisc-label">${discLabel(x, now)}</span></li>`)}</ul>` : ''}
  ${d.facts.total > 0 ? html`<h3 id="p-facts">${t('projects.facts')} <span class="n">${d.facts.total}</span></h3>
  <ul class="pfacts plain-list">${d.facts.newest.map((m) => html`<li><a href="${withFrom(`/memories/${m.id}`, self)}">${stripProjectPrefix(m.content, p.name)}${d.facts.replaces[m.id] ? html`<span class="tag-replaces">${t('projects.replacesTag', { count: d.facts.replaces[m.id]! })}</span>` : ''}</a>${metaLine([writer(m.updatedBy), timeAgo(m.updatedAt, now)])}</li>`)}</ul>` : ''}
  ${replacedFold(p.name, d.replaced, now, self)}
  ${d.facts.total > 0 ? rowLink(`/facts?project=${encodeURIComponent(p.name)}`, t('projects.allFacts', { count: d.facts.total, name: p.name })) : ''}
  ${rowLink(`/graph?project=${encodeURIComponent(p.name)}`, t('projects.seeGraph', { name: p.name }))}
  <details class="fold manage"><summary class="row nolead">${t('projects.manage')}<span class="chev"></span></summary>
  ${stateButtons(p)}
  <h3>${t('projects.whereLives')}</h3>
  <ul class="lives">${lives}</ul>
  <details class="pinfo"><summary>${t('projects.editDetails')}<span class="chev"></span></summary>
    <form method="post" action="${action(p.name, 'info')}" class="stack">
      <label>${t('projects.f.oneLiner')} <input name="oneLiner" maxlength="140" value="${p.oneLiner ?? ''}"></label>
      <label>${t('projects.f.area')} <select name="area"><option value="">${t('projects.place.unsorted')}</option>${AREAS.map((a) => html`<option value="${a}"${p.area === a ? html` selected` : ''}>${placeName(a)}</option>`)}</select></label>
      <label>${t('projects.f.folder')} <input name="folder" maxlength="120" value="${p.folder ?? ''}"></label>
      <label>${t('projects.f.url')} <input name="url" type="url" maxlength="300" value="${p.url ?? ''}"></label>
      <label>${t('projects.f.runsOn')} <input name="runsOn" maxlength="120" placeholder="${t('projects.f.runsOnExample')}" value="${p.runsOn.join(', ')}"></label>
      <label>${t('projects.f.nicknames')} <input name="nicknames" maxlength="340" placeholder="${t('projects.f.commaSeparated')}" value="${p.nicknames.join(', ')}"></label>
      <button type="submit">${t('projects.save')}</button>
    </form>
  </details>
  ${rowLink(`/pages/new?project=${encodeURIComponent(p.name)}`, t('projects.newPage'))}
  ${rowLink(`/memories/new?project=${encodeURIComponent(p.name)}`, t('projects.addFact'))}
  <button type="button" class="continue secondary" data-copy="${d.continueCommand}">${t('projects.continue')}<code>${d.continueCommand}</code></button>
  </details>
</section>`;
}

/** Folders on the Mac that no project matched (add one as a project, or ignore it), and the ignored ones with Undo. */
function notInBrain(v: Home['folders'], ignored: { key: string; name: string }[], plain: boolean): SafeHtml {
  if (v.unmatched.length === 0 && ignored.length === 0) return html``;
  // On the plain home the summary also carries, hidden, the 1920 px shelf's peek: three folders and "Ignored N".
  const peek = plain ? html`<span class="nib-peek" hidden>${v.unmatched.slice(0, 3).map((f) => html`<span>${f.name}</span>`)}${ignored.length > 0 ? html`<span class="nib-peek-more">${t('projects.nib.ignoredPeek', { count: ignored.length })}<span class="chev"></span></span>` : ''}</span>` : '';
  return html`<li><details class="fold notinbrain" id="notyet"><summary class="row nolead">${t('projects.nib.title')}${v.unmatched.length > 0 ? html`<span class="n">${v.unmatched.length}</span>` : ''}${peek}<span class="chev"></span></summary>
<p class="nib-intro">${tHtml('projects.nib.intro', { device: v.device ?? t('projects.nib.theMac'), when: v.receivedAt ? html` ${timeAgo(v.receivedAt)}` : '' })}</p>
${v.unmatched.length > 0 ? html`<ul class="rows nib">${v.unmatched.map((f) => html`<li><span class="nib-name">${f.name}</span><span class="quiet">${f.git ? 'git' : t('projects.nib.notGit')}</span>
<form method="post" action="/folders/add"><input type="hidden" name="name" value="${f.name}"><button type="submit" class="sm" aria-label="${t('projects.nib.addLabel', { name: f.name })}">${t('projects.nib.add')}</button></form>
<form method="post" action="/folders/ignore"><input type="hidden" name="name" value="${f.name}"><button type="submit" class="ghost sm" aria-label="${t('projects.nib.ignoreLabel', { name: f.name })}">${t('projects.nib.ignore')}</button></form></li>`)}</ul>` : ''}
${ignored.length > 0 ? html`<h3 class="nib-ignored">${t('projects.nib.ignored')} <span class="n">${ignored.length}</span></h3>
<ul class="rows nib">${ignored.map((x) => html`<li><span class="nib-name">${x.name}</span>
<form method="post" action="/folders/unignore"><input type="hidden" name="name" value="${x.key}"><button type="submit" class="ghost sm" aria-label="${t('projects.nib.undoLabel', { name: x.name })}">${t('projects.undo')}</button></form></li>`)}</ul>` : ''}
</details></li>`;
}


/** What the Projects screen is drawn from. */
export interface HomeViewInput {
  home: Home; selected: ProjectDetail | undefined; approvals: ApprovalSummary; discussionsWaiting?: { id: string; title: string }[]; backupProblem: string | null; now: Date; error?: string;
  /** The Monday card, at the top of the page, while last week's review is unread (src/web/mondayCard.ts). */
  monday?: MondayCard | null;
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
  /** The search models' progress line (the app only), shown while they download or when a download failed. */
  modelsLine?: SafeHtml;
  /** "Next: make this computer reachable for ChatGPT" (the app only), after the updated line. */
  nextStep?: SafeHtml;
  /** The update card (the app only), above the models line. */
  updateCard?: SafeHtml;
  /** "Updated to x · What's new", once, at the first start after an update (the app only). */
  justUpdated?: SafeHtml;
  /** The off-site backup nudge (the app only), under the update card; the first-steps checklist replaces it while it shows. */
  offsiteCard?: SafeHtml;
  /** The first-steps checklist, on the plain home, until every step is done or the owner hides it. */
  firstSteps?: SafeHtml;
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
  const banner = v.backupProblem ? html`<div class="banner warn"><span class="dot attention" aria-hidden="true"></span><span class="txt">${v.backupProblem}</span><a class="button sm" href="/settings#health">${t('projects.look')}</a></div>` : '';
  const forYou = forYouCard(forYouRows({ approvals: v.approvals, disagreements: v.disagreements ?? 0, health: v.health, discussions: v.discussionsWaiting ?? [], suggestions: home.suggestions }));
  const empty = home.sections.length === 0;
  const plain = mode === 'home';
  // The plain home reaches the map and the discussions through its links row: its card of the same two rows would only repeat them.
  // Beside an open project (the list pane) the rows stay: the links row is not drawn there.
  const notIn = notInBrain(home.folders, v.ignored ?? [], plain);
  const pextra = plain
    ? (notIn.value.trim() === '' ? html`` : html`<ul class="group pfolds pextra">${notIn}</ul>`)
    : html`<ul class="group pfolds pextra">${coachingShown() ? html`<li><a class="row nolead map-link" href="/map"><span class="txt">${tHtml('projects.mapRow', { areas: html`<b>${t('projects.areas.title')}</b>` })}</span><span class="chev"></span></a></li>` : ''}${notIn}${allDiscussions(v.discussions ?? [], mode)}</ul>`;
  return html`<div class="plist">
  <h1>${t('projects.title')}${plain ? html`<span class="phome-date" hidden>${longDate(now)}</span>` : ''}</h1>
  ${errorBlock(v.error)}
  ${v.monday ? mondayCard(v.monday) : ''}
  ${banner}${v.justUpdated ?? ''}${v.nextStep ?? ''}${v.updateCard ?? ''}${plain && v.firstSteps ? v.firstSteps : v.offsiteCard ?? ''}${v.modelsLine ?? ''}
  <form method="post" action="/projects/ideas" class="idea"><label class="visually-hidden" for="idea-text">${t('projects.idea.label')}</label><input id="idea-text" name="text" maxlength="140" placeholder="${t('projects.idea.placeholder')}" autocomplete="off"><button type="submit" class="primary">${t('projects.idea.add')}</button></form>
  ${forYou.value === '' ? '' : html`<h2 class="fy-h" id="foryou" hidden>${t('projects.forYou')}</h2>`}${forYou}
  ${!empty ? '' : html`<p class="quiet empty">${t('projects.empty')}</p>`}
  ${home.sections.length > 0 ? html`<div class="pareas">${dotKey()}${home.sections.map((sec) => areaSection(sec, now, sel, mode))}</div>` : ''}
  ${pextra}
  <p class="home-links">${empty || !coachingShown() ? '' : html`<a href="/map">${t('projects.areas.title')}</a>`}<a href="/graph">${t('projects.link.graph')}</a><a href="/discussions">${t('projects.link.discussions')}</a></p>
</div>`;
}
