import { GROWTH_AREA_LABELS, type Observation } from '../growth/types.js';
import { shiftWeek } from '../memory/digest.js';
import { tidySentence } from './tidyItems.js';
import type { Flag } from '../memory/digest.js';
import type { Capped, MovedCard, ReviewView, WaitRow } from '../review/present.js';
import { weekRange, weekRangeLong } from '../review/sentence.js';
import type { Chip } from '../review/types.js';
import { dayWithWeekday, localDay, localParts, shortDay, timeOfDay } from '../timezone.js';
import { withFrom } from './back.js';
import { activityRow, errorBlock, flagRow, plural, writerKey, writerName, writersTable, type ActivityItem } from './dashboardViews.js';
import { html, type SafeHtml } from './html.js';
import { metaLine } from './metaLine.js';
import { dueChip } from './when.js';
import { areaRing } from './projectsViews.js';
import { weekNav } from './subnav.js';

export const LATEST_SHOWN = 8;
export const LATEST_MAX = 50;

const DAY_MS = 86_400_000;
const panelHref = (name: string): string => `/?project=${encodeURIComponent(name)}#panel`;
const action = (name: string, what: string): string => `/projects/${encodeURIComponent(name)}/${what}`;
const weekHref = (monday: string): string => `/review/${monday}`;
/** The parts of a calendar day (YYYY-MM-DD), which has no time zone. */
const calendar = (date: string) => {
  const d = new Date(`${date}T00:00:00Z`);
  const f = (o: Intl.DateTimeFormatOptions) => d.toLocaleDateString('en-GB', { timeZone: 'UTC', ...o });
  return { day: d.getUTCDate(), month: f({ month: 'long' }), weekday: f({ weekday: 'long' }) };
};
/** "25 Oct". */
const dayOf = (date: string): string => { const c = calendar(date); return `${c.day} ${c.month.slice(0, 3)}`; };
/** "Sunday 25 Oct". */
const weekdayLongOf = (date: string): string => `${calendar(date).weekday} ${dayOf(date)}`;
/** "Sunday 1 November". */
const longCalendarDay = (date: string): string => { const c = calendar(date); return `${c.weekday} ${c.day} ${c.month}`; };
/** A moment on the owner's calendar, like "Monday 2 November". */
const longDay = (iso: string): string => {
  const p = localParts(iso);
  return `${p.weekday} ${p.day} ${p.month}`;
};
const sundayOf = (monday: string): string => new Date(Date.parse(`${monday}T00:00:00Z`) + 6 * DAY_MS).toISOString().slice(0, 10);
const areaDot = areaRing;
const dot = (by: string): SafeHtml => html`<span class="w w-${writerKey(by)}" aria-hidden="true"></span>`;
const hidden = (name: string, value: string): SafeHtml => html`<input type="hidden" name="${name}" value="${value}">`;
/** The rest of a capped list, folded under one "N more" row (closed). */
const more = <T>(c: Capped<T>, wrap: (rows: T[]) => SafeHtml): SafeHtml =>
  (c.folded.length === 0 ? html`` : html`<details class="fold more"><summary class="row nolead">${c.folded.length} more<span class="chev"></span></summary>${wrap(c.folded)}</details>`);
/** A grouped list of rows whose overflow is its last row, a fold opening in place. */
const grouped = <T>(cls: string, c: Capped<T>, li: (x: T) => SafeHtml): SafeHtml =>
  html`<ul class="group ${cls}">${c.shown.map(li)}${c.folded.length === 0 ? '' : html`<li>${more(c, (xs) => html`<ul class="fold-list">${xs.map(li)}</ul>`)}</li>`}</ul>`;
const withStop = (s: string): string => (/[.!?…]$/.test(s) ? s : `${s}.`);

const CHIP_LABELS: Record<Chip, string> = {
  'new-idea': 'New idea', 'new-project': 'New project', 'marked-done': 'Marked done', parked: 'Parked', archived: 'Archived',
};

export interface ReviewPageOptions {
  work: boolean;
  error?: string;
  /** The Monday before, when there is a week there. */
  prev: string | null;
  /** The Monday after, on older weeks only. */
  next: string | null;
  /** Where ticks, Park it and Keep open return to; null on older weeks, which have no forms. */
  back: string | null;
  latest?: { activity: ActivityItem[]; notes: Flag[] };
  monday?: { show: boolean };
}

function head(v: ReviewView, o: ReviewPageOptions): SafeHtml {
  const today = localDay(new Date(v.builtAt));
  const title = v.kind === 'last' ? 'Last week' : v.kind === 'now' ? 'This week so far' : `Week of ${weekRange(v.monday)}`;
  const dates = v.kind === 'now' ? weekRangeLong(v.monday, today) : weekRangeLong(v.monday);
  const prev = o.prev ? html`<a class="week-arrow" href="${weekHref(o.prev)}">‹ ${weekRange(o.prev)}</a>` : html``;
  const next = v.kind === 'older' && o.next ? html`<a class="week-arrow" href="${weekHref(o.next)}">${weekRange(o.next)} ›</a>` : html``;
  const extra = html`${prev}<a href="/review/all">All weeks</a>${next}`;
  return html`<div class="rv-head">
  <h1>${title}</h1>
  <p class="meta">${dates}</p>
  ${weekNav(v.kind === 'last' ? 'last' : v.kind === 'now' ? 'now' : null, o.work, extra)}
</div>`;
}

function card(c: MovedCard): SafeHtml {
  const total = c.done.length + c.moreSteps;
  const progress = c.progress === null ? html`` : html`<span class="progress"><progress value="${c.progress.to}" max="${c.progress.total}">${c.progress.to} of ${c.progress.total}</progress>${c.progress.now}: ${c.progress.from === null || c.progress.from === c.progress.to ? '' : `${c.progress.from} → `}${c.progress.to} of ${c.progress.total}</span>`;
  const also = [
    c.moreSteps > 0 ? html`and ${c.moreSteps} more` : null,
    c.pagesUpdated > 0 ? html`<a href="${panelHref(c.project)}">${plural(c.pagesUpdated, 'page updated', 'pages updated')}</a>` : null,
  ].filter((x): x is SafeHtml => x !== null);
  const np = c.notPushed;
  return html`<li><div class="mv-top">${areaDot(c.area)}<a class="mv-name" href="${panelHref(c.project)}">${c.project}</a>${total > 0 ? html`<span class="mv-count">${total} done</span>` : ''}${np ? html`<span class="chip plain">${plural(np.count, 'commit', 'commits')} not pushed</span>` : ''}${progress}</div>
  ${c.done.length > 0 ? html`<ul class="steps">${c.done.map((d) => html`<li>${d.text.replace(/\s*\(by \d{4}-\d{2}-\d{2}\)\s*$/, '')}<span class="d">${dayOf(d.date)}</span></li>`)}</ul>` : ''}
  ${also.length > 0 ? html`<p class="also">${also.map((a, i) => html`${i > 0 ? ' · ' : ''}${a}`)}</p>` : ''}
  ${np ? html`<p class="also">The Mac's report from ${localParts(np.receivedAt).weekday} ${timeOfDay(np.receivedAt)} shows ${plural(np.count, 'commit', 'commits')} only on the Mac.</p>` : ''}
</li>`;
}

function moved(v: ReviewView): SafeHtml {
  if (v.moved.length === 0 && v.chips.length === 0) return html``;
  return html`<section class="rv-sec">
  <div class="panel-head"><h2>What moved</h2><span class="hint">from the roadmaps' Done lines</span></div>
  ${v.moved.length > 0 ? html`<ul class="group moved">${v.moved.map(card)}</ul>` : ''}
  ${v.movedMore.length > 0 ? html`<p class="also">Also moved: ${v.movedMore.map((p, i) => html`${i > 0 ? ', ' : ''}<a href="${panelHref(p)}">${p}</a>`)}.</p>` : ''}
  ${v.chips.length > 0 ? html`<div class="chips">${v.chips.map((c) => html`<span class="chip">${CHIP_LABELS[c.chip]}: ${c.project}</span>`)}</div>` : ''}
</section>`;
}

/** `today` is the day the week is judged on: today for this week so far, the Monday after for a closed week. */
function waitRow(w: WaitRow, today: string, back: string | null): SafeHtml {
  const pj = html`<span class="pj">${w.project}</span>`;
  if (!w.wait.live) {
    if (w.wait.state === 'done') {
      return html`<li><span class="check is-done" aria-hidden="true"></span><span class="check-text">${pj}<span class="since">${w.text}</span> <span class="small-note">done since</span></span></li>`;
    }
    const note = w.wait.state === 'finished' ? '· the project is finished' : '· no longer on the roadmap';
    return html`<li><span class="check gone" aria-hidden="true"></span><span class="check-text muted-item">${pj}${w.text} <span class="small-note">${note}</span></span></li>`;
  }
  // One date language: the chip goes after the text, in the row's right column, as on Projects.
  const due = dueChip(w.due, today);
  // An older week is read only: no box that looks like the clickable one, just a space and what became of it.
  if (back === null) {
    return html`<li><span class="check-space" aria-hidden="true"></span><span class="check-text">${pj}${w.wait.text} <span class="small-note">still waiting</span></span>${due}</li>`;
  }
  const box = html`<form method="post" action="${action(w.project, `waiting/${w.wait.index}/done`)}">${hidden('text', w.wait.text)}${hidden('back', back)}<button type="submit" class="check" aria-label="Mark done: ${w.wait.text}"></button></form>`;
  return html`<li>${box}<span class="check-text">${pj}${w.wait.text}</span>${due}</li>`;
}

function waiting(v: ReviewView, back: string | null): SafeHtml {
  const { late, after, undated } = v.waiting;
  const dated = late.shown.length + after.shown.length;
  if (dated === 0 && undated === 0) return html``;
  // Late and due are counted from the day the week was judged on, so a chip always agrees with the label above it.
  const today = v.kind === 'now' ? localDay(new Date(v.builtAt)) : shiftWeek(v.monday, 1);
  const list = (c: Capped<WaitRow>) => {
    const rows = (xs: WaitRow[]) => html`<ul class="checks">${xs.map((w) => waitRow(w, today, back))}</ul>`;
    return html`${rows(c.shown)}${more(c, rows)}`;
  };
  const now = v.kind === 'now';
  const afterWeek = `${weekRange(shiftWeek(v.monday, 1))}`;
  const hint = v.kind === 'last' ? 'a tick changes the roadmap now' : now ? 'late now and due in the next 7 days' : `as it was on ${weekdayLongOf(sundayOf(v.monday))}`;
  let first = true;
  const label = (text: string) => { const l = html`<p class="label${first ? ' first' : ''}">${text}</p>`; first = false; return l; };
  return html`<section class="panel">
  <div class="panel-head"><h2>Waiting on you</h2><span class="hint">${hint}</span></div>
  ${late.shown.length > 0 ? html`${label(now ? 'Late' : 'Late at the end of the week')}${list(late)}` : ''}
  ${after.shown.length > 0 ? html`${label(now ? 'Due in the next 7 days' : `Due in the week after (${afterWeek})`)}${list(after)}` : ''}
  ${undated > 0 ? html`<p class="also">${undated} ${dated > 0 ? 'more ' : ''}without a date wait on <a href="/">Projects</a>.</p>` : ''}
  ${v.kind === 'older' ? html`<p class="also">Ticks are only on last week and this week. <a href="/">Projects</a> has what waits now.</p>` : ''}
</section>`;
}

function quiet(v: ReviewView, back: string | null): SafeHtml {
  const q = v.quiet;
  const b = v.back;
  if (q.shown.length === 0 && b.shown.length === 0) return html``;
  const li = (x: ReviewView['quiet']['shown'][number]) => html`<li><div class="row rv-quiet">${areaDot(x.area)}<span class="txt"><span><b>${x.project}</b> <span class="sub">last touched ${shortDay(x.lastTouched, new Date(v.builtAt))}</span></span>${x.next ? html`<span class="sub">Next was: ${withStop(x.next)}</span>` : ''}</span>${
    !x.open ? html`<span class="sub">${x.stateText}</span>`
    : back === null ? html`<span></span>`
    : html`<span class="acts"><form method="post" action="${action(x.project, 'state')}">${hidden('state', 'parked')}${hidden('back', back)}<button type="submit" class="sm">Park it</button></form><form method="post" action="${action(x.project, 'snooze')}">${hidden('back', back)}<button type="submit" class="ghost sm">Keep open</button></form></span>`}</div></li>`;
  const backRows = (xs: ReviewView['back']['shown']) => html`${xs.map((x) => html`<p class="also flat"><b>${x.project}</b> moved again after ${x.quietDays} quiet days.</p>`)}`;
  const backPart = b.shown.length === 0 ? html`` : html`${backRows(b.shown)}${more(b, backRows)}`;
  if (q.shown.length === 0) {
    return html`<section class="rv-sec">
  <div class="panel-head"><h2>Back after a while</h2><span class="hint">moved again after 14 or more quiet days</span></div>
  ${backPart}
</section>`;
  }
  return html`<section class="rv-sec">
  <div class="panel-head"><h2>Went quiet</h2><span class="hint">no change for 14 days, crossed this week</span></div>
  ${grouped('quiet', q, li)}
  ${b.shown.length > 0 ? html`<p class="label">Back after a while</p>${backPart}` : ''}
</section>`;
}

/** Section 16: a decision replaced since stays listed, with a small grey link to the fact that holds now. */
function replacedOn(x: ReviewView['decided']['shown'][number], v: ReviewView, from: string): SafeHtml | string {
  if (!x.replaced) return '';
  const day = shortDay(x.replaced.on, new Date(Math.max(Date.parse(v.builtAt), Date.parse(x.replaced.on))));
  return x.replaced.currentId
    ? html`<a class="replaced-on" href="${withFrom(`/memories/${x.replaced.currentId}`, from)}">replaced on ${day}</a>`
    : html`<span class="replaced-on">replaced on ${day}</span>`;
}

/** The week's own address, so the facts it links come back to it. */
const selfOf = (v: ReviewView): string => (v.kind === 'last' ? '/review' : v.kind === 'now' ? '/review/now' : `/review/${v.monday}`);

function decided(v: ReviewView): SafeHtml {
  const d = v.decided;
  if (d.shown.length === 0) return html``;
  const self = selfOf(v);
  const li = (x: ReviewView['decided']['shown'][number]) => html`<li><div class="row nolead decision"><span class="txt"><span>${x.project ? html`<span class="pj">${x.project}</span>` : ''}<a href="${withFrom(`/memories/${x.id}`, self)}">${x.excerpt}</a>${replacedOn(x, v, self)}</span>${metaLine([html`<time class="day" datetime="${x.date}">${shortDay(x.date, new Date(v.builtAt))}</time>`, html`<span class="by">${dot(x.by)}${x.voices && x.voices.length > 0 ? `from a discussion: ${x.voices.join(', ')}` : writerName(x.by)}</span>`])}</span></div></li>`;
  return html`<section class="rv-sec">
  <div class="panel-head"><h2>Decided</h2></div>
  ${grouped('decisions', d, li)}
</section>`;
}

function observation(o: Observation, back: string | null): SafeHtml {
  const react = (value: 'agree' | 'disagree', label: string, cls: string) => {
    const pressed = o.reaction === value;
    return html`<form method="post" action="/growth/${o.id}/react">${hidden('reaction', pressed ? 'clear' : value)}${hidden('back', back ?? '')}<button type="submit" class="${cls} small" aria-pressed="${String(pressed)}">${label}</button></form>`;
  };
  return html`<div class="obs"><p class="k">${o.kind === 'strength' ? 'Strength' : 'To improve'} · ${GROWTH_AREA_LABELS[o.area]}</p><p>${o.summary}${o.project ? html` <span class="pj">${o.project}</span>` : ''}</p>
  ${o.practise ? html`<p class="pr"><b>Practise</b>${o.practise}</p>` : ''}
  ${back === null ? '' : html`<span class="acts">${react('agree', 'Agree', 'secondary')}${react('disagree', 'Disagree', 'ghost')}</span>`}</div>`;
}

function signals(finished: number, started: number): string {
  const f = finished > 0 ? `finished ${plural(finished, 'project', 'projects')}` : '';
  const s = started > 0 ? `started ${finished > 0 ? started : plural(started, 'project', 'projects')}` : '';
  return f && s ? `You ${f} and ${s}.` : f || s ? `You ${f || s}.` : '';
}

function growth(v: ReviewView, o: ReviewPageOptions): SafeHtml {
  const g = v.growth;
  if (o.work || g === null) return html``;
  const line = signals(g.finished, g.started);
  return html`<section class="panel growth">
  <div class="panel-head"><h2>This week in your growth</h2><a class="hint" href="/growth">All of Growth →</a></div>
  ${g.strength ? observation(g.strength, o.back) : ''}
  ${g.improve ? observation(g.improve, o.back) : ''}
  ${line ? html`<p class="signals">${line}</p>` : ''}
</section>`;
}

function safety(v: ReviewView): SafeHtml {
  const self = selfOf(v);
  // A quoted fact that already ends a sentence takes no second full stop after the closing quote.
  const quote = (id: string, text: string | undefined) => html`“<a href="${withFrom(`/memories/${id}`, self)}">${text ?? ''}</a>”${/[.!?…]$/.test(text ?? '') ? '' : '.'}`;
  const line = (f: ReviewView['safety']['shown'][number]) => (f.kind === 'connected'
    ? html`<p class="flagline">${f.client} connected on ${dayWithWeekday(f.at)}. If that wasn't you, revoke it in <a href="/settings#connections">Settings</a>.</p>`
    : f.kind === 'replaced-others'
      ? html`<p class="flagline">${f.by} replaced a memory ${f.author === 'owner' ? 'you' : f.author} wrote: ${quote(f.memoryId, f.excerpt)} Undo it on its page.</p>`
      : html`<p class="flagline">${f.by} deleted a memory on ${dayWithWeekday(f.at)}: ${quote(f.memoryId, f.excerpt)} Restore it from its history.</p>`);
  if (v.safety.shown.length === 0) return html``;
  return html`${v.safety.shown.map(line)}${more(v.safety, (xs) => html`${xs.map(line)}`)}`;
}

function behind(v: ReviewView): SafeHtml {
  const d = v.digest;
  if (d === null || d.writers.length === 0) return html``;
  const t = d.totals;
  return html`<details class="panel fold">
  <summary>Behind the scenes <span class="hint">${[[t.saved, 'saved'], [t.changed, 'changed'], [t.deleted, 'deleted']].filter(([n]) => Number(n) > 0).map(([n, w]) => `${n} ${w}`).join(' · ')}</span><span class="chev"></span></summary>
  ${writersTable(d.writers, d.lookupsSince, new Date(`${v.monday}T00:00:00Z`).toISOString())}
  <p class="rv-foot tight">This is the old weekly digest, as it stood on Sunday night. Its other notes are in <a href="/review/now#latest">So far › Latest changes</a>.</p>
</details>`;
}

/** The newest changes this week, with older rows folded in place. */
export function latestChanges(v: { activity: ActivityItem[]; notes: Flag[] }): SafeHtml {
  const shown = v.activity.slice(0, LATEST_SHOWN);
  const folded = v.activity.slice(LATEST_SHOWN, LATEST_MAX);
  const row = (a: ActivityItem) => activityRow(a, '/review/now');
  return html`<section id="latest" class="rv-sec latest">
  <div class="panel-head"><h2>Latest changes</h2></div>
  ${v.notes.length ? html`<ul class="rows week">${v.notes.map(flagRow)}</ul>` : ''}
  ${v.activity.length === 0 ? html`<p class="quiet">No changes yet this week.</p>` : html`<ul class="rows">${shown.map(row)}</ul>`}
  ${folded.length ? html`<details class="fold more"><summary class="row nolead">${folded.length} more<span class="chev"></span></summary><ul class="rows">${folded.map(row)}</ul></details>` : ''}
</section>`;
}

function tidyLine(v: ReviewView): SafeHtml {
  const sentence = v.tidy ? tidySentence(v.tidy) : null;
  return sentence ? html`<p class="tidy-line">${sentence}. <a href="/facts/tidy">Tidy up</a></p>` : html``;
}

function footer(v: ReviewView): SafeHtml {
  if (v.kind === 'now') return html`<p class="rv-foot">So far: made just now from what is stored. It changes as the week goes on and isn't kept.</p>`;
  return html`<p class="rv-foot">Made on ${longDay(v.builtAt)} at ${timeOfDay(v.builtAt)} from what was stored at the end of ${longCalendarDay(sundayOf(v.monday))}. Nothing here was written by an AI.${v.quietFromFactsOnly ? ' Quiet is worked out from saved facts only.' : ''}</p>`;
}

/** One week's review: the sentence, then each part that has something, then the footer. */
export function reviewView(v: ReviewView, o: ReviewPageOptions): SafeHtml {
  return html`<div class="review">
  ${head(v, o)}
  ${errorBlock(o.error)}
  <p class="lede">${v.sentence}</p>
  ${v.empty ? '' : html`${moved(v)}${waiting(v, o.back)}${quiet(v, o.back)}${decided(v)}${growth(v, o)}${safety(v)}${behind(v)}`}
  ${tidyLine(v)}
  ${v.kind === 'now' && o.latest ? latestChanges(o.latest) : ''}
  ${v.kind === 'last' && o.monday?.show ? html`<form method="post" action="/review/${v.monday}/open"><button type="submit" class="secondary">Done reading</button></form>` : ''}
  ${footer(v)}
</div>`;
}

/** Before the first week has ended. */
export function noWeekYetView(work = false): SafeHtml {
  return html`<div class="review">
  <div class="rv-head"><h1>Last week</h1>${weekNav('last', work)}</div>
  <p class="lede">There is no finished week yet.</p>
  <p class="also"><a href="/review/now">This week so far</a></p>
</div>`;
}

/** All weeks, newest first: one line each, the week's own sentence. No unread marker. */
export function allWeeksView(rows: { monday: string; href: string; sentence: string | null; quiet: boolean }[], work = false): SafeHtml {
  return html`<div class="review">
  <div class="rv-head"><h1>All weeks</h1><p class="meta">One line per week. A week opens as it stood at its end.</p>${weekNav(null, work)}</div>
  ${rows.length === 0 ? html`<p class="quiet">No finished week yet.</p>` : html`<ul class="weeks">${rows.map((r) => html`<li><a class="wk" href="${r.href}">${weekRange(r.monday)}</a>${r.sentence === null
    ? html`<span class="ld q">Made when you open it.</span>`
    : html`<span class="ld${r.quiet ? ' q' : ''}">${r.sentence}</span>`}</li>`)}</ul>`}
</div>`;
}
