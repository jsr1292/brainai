import { type GrowthArea, type Observation } from '../growth/types.js';
import { pseudoWrap } from '../i18n/core.js';
import { currentLanguage, t, tKey, tHtml, type PlainKey } from '../i18n/index.js';
import { shiftWeek } from '../memory/digest.js';
import { tidySentence } from './tidyItems.js';
import type { Flag } from '../memory/digest.js';
import type { Capped, MovedCard, ReviewView, WaitRow } from '../review/present.js';
import type { SentenceFacts } from '../review/sentence.js';
import type { Chip } from '../review/types.js';
import { dayWithWeekday, localDay, localParts, shortDay, timeOfDay } from '../timezone.js';
import { withFrom } from './back.js';
import { activityRow, errorBlock, flagRow, writerKey, writerName, writersTable, type ActivityItem } from './dashboardViews.js';
import { html, SafeHtml } from './html.js';
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
/** The parts of a calendar day (YYYY-MM-DD), which has no time zone, in the request's language. */
const calendar = (date: string) => {
  const d = new Date(`${date}T00:00:00Z`);
  const es = currentLanguage() === 'es';
  const f = (o: Intl.DateTimeFormatOptions) => d.toLocaleDateString(es ? 'es-ES' : 'en-GB', { timeZone: 'UTC', ...o });
  const month = f({ month: 'long' });
  // English keeps its three letters ("Sept" in en-GB would change old output); Spanish takes Intl's own short form.
  return { day: d.getUTCDate(), year: d.getUTCFullYear(), month, monthShort: es ? f({ month: 'short' }).replace(/\.$/, '') : month.slice(0, 3), weekday: f({ weekday: 'long' }) };
};
type Cal = ReturnType<typeof calendar>;
/** "25 Oct". */
const dayOf = (date: string): string => { const c = calendar(date); return `${c.day} ${pseudoWrap(c.monthShort)}`; };
/** "Sunday 25 Oct". */
const weekdayLongOf = (date: string): string => `${pseudoWrap(calendar(date).weekday)} ${dayOf(date)}`;
/** "Sunday 1 November". */
const longCalendarDay = (date: string): string => { const c = calendar(date); return t('when.longDate', { weekday: c.weekday, day: c.day, month: c.month }); };
/** A moment on the owner's calendar, like "Monday 2 November". */
const longDay = (iso: string): string => {
  const p = localParts(iso);
  return t('when.longDate', { weekday: p.weekday, day: p.day, month: p.month });
};
const plusDays = (day: string, n: number): string => new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);

/** The week's dates in the owner's language: "26 Oct – 1 Nov", "Monday 26 October – Sunday 1 November 2026". */
function range(from: string, to: string, o: { long: boolean; year: 'needed' | 'always' }): string {
  const a = calendar(from);
  const b = calendar(to);
  const month = (p: Cal) => (o.long ? t('review.range.month', { month: p.month }) : pseudoWrap(p.monthShort));
  const year = (y: number) => (o.long ? t('review.range.year', { year: y }) : String(y));
  const day = (p: Cal) => (o.long ? `${pseudoWrap(p.weekday)} ${p.day}` : `${p.day}`);
  const endYear = o.year === 'always' ? ` ${year(b.year)}` : '';
  if (from === to) return `${day(a)} ${month(a)}${endYear}`;
  if (a.year !== b.year) return `${day(a)} ${month(a)} ${year(a.year)} – ${day(b)} ${month(b)} ${year(b.year)}`;
  if (a.month !== b.month) return `${day(a)} ${month(a)} – ${day(b)} ${month(b)}${endYear}`;
  return `${day(a)} – ${day(b)} ${month(b)}${endYear}`;
}
/** "26 Oct – 1 Nov", "19 – 25 Oct", "29 Dec 2025 – 4 Jan 2026". */
export const weekRange = (monday: string): string => range(monday, plusDays(monday, 6), { long: false, year: 'needed' });
/** "Monday 26 October – Sunday 1 November 2026"; `lastDay` ends it early (this week so far). */
export const weekRangeLong = (monday: string, lastDay?: string): string => range(monday, lastDay ?? plusDays(monday, 6), { long: true, year: 'always' });
const sundayOf = (monday: string): string => plusDays(monday, 6);
const areaDot = areaRing;
const dot = (by: string): SafeHtml => html`<span class="w w-${writerKey(by)}" aria-hidden="true"></span>`;
const hidden = (name: string, value: string): SafeHtml => html`<input type="hidden" name="${name}" value="${value}">`;
/** The rest of a capped list, folded under one "N more" row (closed). */
const more = <T>(c: Capped<T>, wrap: (rows: T[]) => SafeHtml): SafeHtml =>
  (c.folded.length === 0 ? html`` : html`<details class="fold more"><summary class="row nolead">${t('review.more', { count: c.folded.length })}<span class="chev"></span></summary>${wrap(c.folded)}</details>`);
/** A grouped list of rows whose overflow is its last row, a fold opening in place. */
const grouped = <T>(cls: string, c: Capped<T>, li: (x: T) => SafeHtml): SafeHtml =>
  html`<ul class="group ${cls}">${c.shown.map(li)}${c.folded.length === 0 ? '' : html`<li>${more(c, (xs) => html`<ul class="fold-list">${xs.map(li)}</ul>`)}</li>`}</ul>`;
const withStop = (s: string): string => (/[.!?…]$/.test(s) ? s : `${s}.`);

const CHIP_LABELS: Record<Chip, PlainKey> = {
  'new-idea': 'review.chip.newIdea', 'new-project': 'review.chip.newProject', 'marked-done': 'review.chip.markedDone', parked: 'review.chip.parked', archived: 'review.chip.archived',
};

/** The growth areas' names, by code (the English names in src/growth stay for assistants). */
export const AREA_LABELS: Record<GrowthArea, PlainKey> = {
  planning: 'review.area.planning', briefing: 'review.area.briefing', testing: 'review.area.testing', reviewing: 'review.area.reviewing', understanding: 'review.area.understanding',
  finishing: 'review.area.finishing', git: 'review.area.git', security: 'review.area.security', deploying: 'review.area.deploying', product: 'review.area.product',
};
/** What a project's state is called when it left the open list. */
const STATE_LABELS: Record<string, PlainKey> = {
  idea: 'review.state.idea', parked: 'review.state.parked', done: 'review.state.done', archived: 'review.state.archived',
};

/**
 * The week's sentence in the owner's language, from the facts it is made of (the same patterns as `weekSentence` in
 * src/review/sentence.ts, which stays English for assistants).
 */
export function weekSentenceT(f: SentenceFacts, opts: { lead: boolean; soFar: boolean }): string {
  const steps = f.steps.filter((s) => s.n > 0);
  const total = steps.reduce((a, s) => a + s.n, 0);
  if (total === 0 && f.late === 0 && f.quiet.length === 0 && !f.somethingElse) {
    return opts.soFar ? t('review.s.soFarNothing') : t('review.s.quietWeek');
  }
  let lead = '';
  if (opts.lead && !opts.soFar && steps.length >= 2) {
    const named = steps.filter((s) => s.nameable && s.n >= 3).sort((a, b) => b.n - a.n).slice(0, 2).map((s) => s.project);
    if (named.length > 0) lead = t('review.s.lead', { names: named.length === 2 ? t('review.s.pair', { a: named[0]!, b: named[1]! }) : named[0]! });
  }
  let done: string;
  if (total === 0) done = t('review.s.noSteps');
  else if (steps.length > 1) done = t('review.s.across', { total, projects: steps.length });
  else {
    const only = steps[0]!;
    done = only.nameable ? t('review.s.stepsIn', { count: total, project: only.project }) : t('review.s.steps', { count: total });
  }
  const late = f.late > 0 ? t('review.s.late', { count: f.late }) : f.dated > 0 ? t('review.s.nothingLate') : '';
  const quiet = f.quiet.length === 1 ? t('review.s.wentQuiet', { project: f.quiet[0]! })
    : f.quiet.length === 2 ? t('review.s.wentQuiet2', { a: f.quiet[0]!, b: f.quiet[1]! })
    : f.quiet.length > 2 ? t('review.s.wentQuietMany', { count: f.quiet.length }) : '';
  const rest = late && quiet ? t('review.s.lateAndQuiet', { late, quiet }) : late || quiet ? `${late || quiet}.` : '';
  const sentence = [`${lead}${done}`, rest].filter(Boolean).join(' ');
  return opts.soFar ? t('review.s.soFar', { sentence }) : sentence;
}

/** The week's sentence for a screen, in the owner's language (`v.sentence` is the English one assistants read). */
export const sentenceOf = (v: ReviewView): string => weekSentenceT(v.sentenceFacts, { lead: true, soFar: v.soFar });
/** The same without its lead, for the Monday line on Projects. */
export const lineSentenceOf = (v: ReviewView): string => weekSentenceT(v.sentenceFacts, { lead: false, soFar: v.soFar });

export interface ReviewPageOptions {
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
  const title = v.kind === 'last' ? t('shell.nav.lastWeek') : v.kind === 'now' ? t('review.thisWeekSoFar') : t('review.weekOf', { range: weekRange(v.monday) });
  const dates = v.kind === 'now' ? weekRangeLong(v.monday, today) : weekRangeLong(v.monday);
  const prev = o.prev ? html`<a class="week-arrow" href="${weekHref(o.prev)}">‹ ${weekRange(o.prev)}</a>` : html``;
  const next = v.kind === 'older' && o.next ? html`<a class="week-arrow" href="${weekHref(o.next)}">${weekRange(o.next)} ›</a>` : html``;
  const extra = html`${prev}<a href="/review/all">${t('review.allWeeks')}</a>${next}`;
  return html`<div class="rv-head">
  <h1>${title}</h1>
  <p class="meta">${dates}</p>
  ${weekNav(v.kind === 'last' ? 'last' : v.kind === 'now' ? 'now' : null, extra)}
</div>`;
}

function card(c: MovedCard): SafeHtml {
  const total = c.done.length + c.moreSteps;
  const progress = c.progress === null ? html`` : html`<span class="progress"><progress value="${c.progress.to}" max="${c.progress.total}">${t('review.progressOf', { to: c.progress.to, total: c.progress.total })}</progress>${c.progress.now}: ${c.progress.from === null || c.progress.from === c.progress.to ? t('review.progressOf', { to: c.progress.to, total: c.progress.total }) : t('review.progressFromTo', { from: c.progress.from, to: c.progress.to, total: c.progress.total })}</span>`;
  const also = [
    c.moreSteps > 0 ? html`${t('review.andMore', { count: c.moreSteps })}` : null,
    c.pagesUpdated > 0 ? html`<a href="${panelHref(c.project)}">${t('review.pagesUpdated', { count: c.pagesUpdated })}</a>` : null,
  ].filter((x): x is SafeHtml => x !== null);
  const np = c.notPushed;
  const mac = (np: NonNullable<MovedCard['notPushed']>): string => {
    const at = { weekday: localParts(np.receivedAt).weekday, time: timeOfDay(np.receivedAt) };
    return np.count > 0 ? t('review.macCommits', { ...at, count: np.count }) : t('review.macFiles', { ...at, count: np.uncommitted ?? 0 });
  };
  return html`<li><div class="mv-top">${areaDot(c.area)}<a class="mv-name" href="${panelHref(c.project)}">${c.project}</a>${total > 0 ? html`<span class="mv-count">${t('review.done', { count: total })}</span>` : ''}${np ? html`<span class="chip plain">${np.count > 0 ? t('review.commitsNotPushed', { count: np.count }) : t('review.filesNotCommitted', { count: np.uncommitted ?? 0 })}</span>` : ''}${progress}</div>
  ${c.done.length > 0 ? html`<ul class="steps">${c.done.map((d) => html`<li>${d.text.replace(/\s*\(by \d{4}-\d{2}-\d{2}\)\s*$/, '')}<span class="d">${dayOf(d.date)}</span></li>`)}</ul>` : ''}
  ${also.length > 0 ? html`<p class="also">${also.map((a, i) => html`${i > 0 ? ' · ' : ''}${a}`)}</p>` : ''}
  ${np ? html`<p class="also">${mac(np)}</p>` : ''}
</li>`;
}

function moved(v: ReviewView): SafeHtml {
  if (v.moved.length === 0 && v.chips.length === 0) return html``;
  return html`<section class="rv-sec">
  <div class="panel-head"><h2>${t('review.moved.title')}</h2><span class="hint">${t('review.moved.hint')}</span></div>
  ${v.moved.length > 0 ? html`<ul class="group moved">${v.moved.map(card)}</ul>` : ''}
  ${v.movedMore.length > 0 ? html`<p class="also">${tHtml('review.moved.also', { projects: html`${v.movedMore.map((p, i) => html`${i > 0 ? ', ' : ''}<a href="${panelHref(p)}">${p}</a>`)}` })}</p>` : ''}
  ${v.chips.length > 0 ? html`<div class="chips">${v.chips.map((c) => html`<span class="chip">${tKey(CHIP_LABELS[c.chip])}: ${c.project}</span>`)}</div>` : ''}
</section>`;
}

/** `today` is the day the week is judged on: today for this week so far, the Monday after for a closed week. */
function waitRow(w: WaitRow, today: string, back: string | null): SafeHtml {
  const pj = html`<span class="pj">${w.project}</span>`;
  if (!w.wait.live) {
    if (w.wait.state === 'done') {
      return html`<li><span class="check is-done" aria-hidden="true"></span><span class="check-text">${pj}<span class="since">${w.text}</span> <span class="small-note">${t('review.wait.doneSince')}</span></span></li>`;
    }
    const note = w.wait.state === 'finished' ? t('review.wait.finished') : t('review.wait.gone');
    return html`<li><span class="check gone" aria-hidden="true"></span><span class="check-text muted-item">${pj}${w.text} <span class="small-note">${note}</span></span></li>`;
  }
  // One date language: the chip goes after the text, in the row's right column, as on Projects.
  const due = dueChip(w.due, today);
  // An older week is read only: no box that looks like the clickable one, just a space and what became of it.
  if (back === null) {
    return html`<li><span class="check-space" aria-hidden="true"></span><span class="check-text">${pj}${w.wait.text} <span class="small-note">${t('review.wait.still')}</span></span>${due}</li>`;
  }
  const box = html`<form method="post" action="${action(w.project, `waiting/${w.wait.index}/done`)}">${hidden('text', w.wait.text)}${hidden('back', back)}<button type="submit" class="check" aria-label="${t('review.wait.markDone', { text: w.wait.text })}"></button></form>`;
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
  const hint = v.kind === 'last' ? t('review.wait.hintLast') : now ? t('review.wait.hintNow') : t('review.wait.hintOlder', { day: weekdayLongOf(sundayOf(v.monday)) });
  let first = true;
  const label = (text: string) => { const l = html`<p class="label${first ? ' first' : ''}">${text}</p>`; first = false; return l; };
  const projects = html`<a href="/">${t('shell.nav.projects')}</a>`;
  return html`<section class="panel">
  <div class="panel-head"><h2>${t('review.wait.title')}</h2><span class="hint">${hint}</span></div>
  ${late.shown.length > 0 ? html`${label(now ? t('review.wait.late') : t('review.wait.lateEnd'))}${list(late)}` : ''}
  ${after.shown.length > 0 ? html`${label(now ? t('review.wait.due7') : t('review.wait.dueAfter', { range: afterWeek }))}${list(after)}` : ''}
  ${undated > 0 ? html`<p class="also">${tHtml(dated > 0 ? 'review.wait.undatedMore' : 'review.wait.undated', { count: undated, link: projects })}</p>` : ''}
  ${v.kind === 'older' ? html`<p class="also">${tHtml('review.wait.olderNote', { link: projects })}</p>` : ''}
</section>`;
}

function quiet(v: ReviewView, back: string | null): SafeHtml {
  const q = v.quiet;
  const b = v.back;
  if (q.shown.length === 0 && b.shown.length === 0) return html``;
  const left = (x: ReviewView['quiet']['shown'][number]): string => {
    const key = x.state === null ? undefined : STATE_LABELS[x.state];
    return key !== undefined && x.stateAt !== null ? t('review.stateSince', { state: tKey(key), day: shortDay(x.stateAt, new Date(v.builtAt)) }) : x.stateText ?? '';
  };
  const li = (x: ReviewView['quiet']['shown'][number]) => html`<li><div class="row rv-quiet">${areaDot(x.area)}<span class="txt"><span><b>${x.project}</b> <span class="sub">${t('review.quiet.lastTouched', { day: shortDay(x.lastTouched, new Date(v.builtAt)) })}</span></span>${x.next ? html`<span class="sub">${t('review.quiet.next', { text: withStop(x.next) })}</span>` : ''}</span>${
    !x.open ? html`<span class="sub">${left(x)}</span>`
    : back === null ? html`<span></span>`
    : html`<span class="acts"><form method="post" action="${action(x.project, 'state')}">${hidden('state', 'parked')}${hidden('back', back)}<button type="submit" class="sm">${t('review.quiet.park')}</button></form><form method="post" action="${action(x.project, 'snooze')}">${hidden('back', back)}<button type="submit" class="ghost sm">${t('review.quiet.keepOpen')}</button></form></span>`}</div></li>`;
  const backRows = (xs: ReviewView['back']['shown']) => html`${xs.map((x) => html`<p class="also flat">${tHtml('review.quiet.movedAgain', { project: html`<b>${x.project}</b>`, days: x.quietDays })}</p>`)}`;
  const backPart = b.shown.length === 0 ? html`` : html`${backRows(b.shown)}${more(b, backRows)}`;
  if (q.shown.length === 0) {
    return html`<section class="rv-sec">
  <div class="panel-head"><h2>${t('review.quiet.backTitle')}</h2><span class="hint">${t('review.quiet.backHint')}</span></div>
  ${backPart}
</section>`;
  }
  return html`<section class="rv-sec">
  <div class="panel-head"><h2>${t('review.quiet.title')}</h2><span class="hint">${t('review.quiet.hint')}</span></div>
  ${grouped('quiet', q, li)}
  ${b.shown.length > 0 ? html`<p class="label">${t('review.quiet.backTitle')}</p>${backPart}` : ''}
</section>`;
}

/** Section 16: a decision replaced since stays listed, with a small grey link to the fact that holds now. */
function replacedOn(x: ReviewView['decided']['shown'][number], v: ReviewView, from: string): SafeHtml | string {
  if (!x.replaced) return '';
  const day = shortDay(x.replaced.on, new Date(Math.max(Date.parse(v.builtAt), Date.parse(x.replaced.on))));
  return x.replaced.currentId
    ? html`<a class="replaced-on" href="${withFrom(`/memories/${x.replaced.currentId}`, from)}">${t('review.decided.replacedOn', { day })}</a>`
    : html`<span class="replaced-on">${t('review.decided.replacedOn', { day })}</span>`;
}

/** The week's own address, so the facts it links come back to it. */
const selfOf = (v: ReviewView): string => (v.kind === 'last' ? '/review' : v.kind === 'now' ? '/review/now' : `/review/${v.monday}`);

function decided(v: ReviewView): SafeHtml {
  const d = v.decided;
  if (d.shown.length === 0) return html``;
  const self = selfOf(v);
  const li = (x: ReviewView['decided']['shown'][number]) => html`<li><div class="row nolead decision"><span class="txt"><span>${x.project ? html`<span class="pj">${x.project}</span>` : ''}<a href="${withFrom(`/memories/${x.id}`, self)}">${x.excerpt}</a>${replacedOn(x, v, self)}</span>${metaLine([html`<time class="day" datetime="${x.date}">${shortDay(x.date, new Date(v.builtAt))}</time>`, html`<span class="by">${dot(x.by)}${x.voices && x.voices.length > 0 ? t('review.decided.fromDiscussion', { voices: x.voices.join(', ') }) : writerName(x.by)}</span>`])}</span></div></li>`;
  return html`<section class="rv-sec">
  <div class="panel-head"><h2>${t('review.decided.title')}</h2></div>
  ${grouped('decisions', d, li)}
</section>`;
}

function observation(o: Observation, back: string | null): SafeHtml {
  const react = (value: 'agree' | 'disagree', label: string, cls: string) => {
    const pressed = o.reaction === value;
    return html`<form method="post" action="/growth/${o.id}/react">${hidden('reaction', pressed ? 'clear' : value)}${hidden('back', back ?? '')}<button type="submit" class="${cls} small" aria-pressed="${String(pressed)}">${label}</button></form>`;
  };
  return html`<div class="obs"><p class="k">${o.kind === 'strength' ? t('review.obs.strength') : t('review.obs.improve')} · ${tKey(AREA_LABELS[o.area])}</p><p>${o.summary}${o.project ? html` <span class="pj">${o.project}</span>` : ''}</p>
  ${o.practise ? html`<p class="pr"><b>${t('review.obs.practise')}</b>${o.practise}</p>` : ''}
  ${back === null ? '' : html`<span class="acts">${react('agree', t('review.obs.agree'), 'secondary')}${react('disagree', t('review.obs.disagree'), 'ghost')}</span>`}</div>`;
}

function signals(finished: number, started: number): string {
  if (finished > 0 && started > 0) return t('review.signal.both', { finished: t('review.signal.projects', { count: finished }), started });
  if (finished > 0) return t('review.signal.finished', { projects: t('review.signal.projects', { count: finished }) });
  if (started > 0) return t('review.signal.started', { projects: t('review.signal.projects', { count: started }) });
  return '';
}

function growth(v: ReviewView, o: ReviewPageOptions): SafeHtml {
  const g = v.growth;
  if (g === null) return html``;
  const line = signals(g.finished, g.started);
  return html`<section class="panel growth">
  <div class="panel-head"><h2>${t('review.growth.title')}</h2><a class="hint" href="/growth">${t('review.growth.all')}</a></div>
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
    ? html`<p class="flagline">${tHtml('review.safety.connected', { client: f.client, day: dayWithWeekday(f.at), link: html`<a href="/settings#connections">${t('shell.nav.settings')}</a>` })}</p>`
    : f.kind === 'replaced-others'
      ? html`<p class="flagline">${f.author === 'owner' ? tHtml('review.safety.replacedYours', { by: f.by, quote: quote(f.memoryId, f.excerpt) }) : tHtml('review.safety.replacedOther', { by: f.by, author: f.author, quote: quote(f.memoryId, f.excerpt) })}</p>`
      : html`<p class="flagline">${tHtml('review.safety.deleted', { by: f.by, day: dayWithWeekday(f.at), quote: quote(f.memoryId, f.excerpt) })}</p>`);
  if (v.safety.shown.length === 0) return html``;
  return html`${v.safety.shown.map(line)}${more(v.safety, (xs) => html`${xs.map(line)}`)}`;
}

function behind(v: ReviewView): SafeHtml {
  const d = v.digest;
  if (d === null || d.writers.length === 0) return html``;
  const tot = d.totals;
  const totals = [tot.saved > 0 ? t('review.behind.saved', { count: tot.saved }) : '', tot.changed > 0 ? t('review.behind.changed', { count: tot.changed }) : '', tot.deleted > 0 ? t('review.behind.deleted', { count: tot.deleted }) : ''].filter(Boolean).join(' · ');
  return html`<details class="panel fold">
  <summary>${t('review.behind.title')} <span class="hint">${totals}</span><span class="chev"></span></summary>
  ${writersTable(d.writers, d.lookupsSince, new Date(`${v.monday}T00:00:00Z`).toISOString())}
  <p class="rv-foot tight">${tHtml('review.behind.foot', { link: html`<a href="/review/now#latest">${t('review.behind.footLink')}</a>` })}</p>
</details>`;
}

/** The newest changes this week, with older rows folded in place. */
export function latestChanges(v: { activity: ActivityItem[]; notes: Flag[] }): SafeHtml {
  const shown = v.activity.slice(0, LATEST_SHOWN);
  const folded = v.activity.slice(LATEST_SHOWN, LATEST_MAX);
  const row = (a: ActivityItem) => activityRow(a, '/review/now');
  return html`<section id="latest" class="rv-sec latest">
  <div class="panel-head"><h2>${t('review.latest.title')}</h2></div>
  ${v.notes.length ? html`<ul class="rows week">${v.notes.map(flagRow)}</ul>` : ''}
  ${v.activity.length === 0 ? html`<p class="quiet">${t('review.latest.none')}</p>` : html`<ul class="rows">${shown.map(row)}</ul>`}
  ${folded.length ? html`<details class="fold more"><summary class="row nolead">${t('review.more', { count: folded.length })}<span class="chev"></span></summary><ul class="rows">${folded.map(row)}</ul></details>` : ''}
</section>`;
}

function tidyLine(v: ReviewView): SafeHtml {
  const sentence = v.tidy ? tidySentence(v.tidy) : null;
  return sentence ? html`<p class="tidy-line">${tHtml('review.tidyLine', { sentence, link: html`<a href="/facts/tidy">${t('review.tidyLink')}</a>` })}</p>` : html``;
}

function footer(v: ReviewView): SafeHtml {
  if (v.kind === 'now') return html`<p class="rv-foot">${t('review.foot.now')}</p>`;
  return html`<p class="rv-foot">${t('review.foot.made', { day: longDay(v.builtAt), time: timeOfDay(v.builtAt), end: longCalendarDay(sundayOf(v.monday)) })}${v.quietFromFactsOnly ? ` ${t('review.foot.quietFromFacts')}` : ''}</p>`;
}

/** One week's review: the sentence, then each part that has something, then the footer. */
export function reviewView(v: ReviewView, o: ReviewPageOptions): SafeHtml {
  return html`<div class="review">
  ${head(v, o)}
  ${errorBlock(o.error)}
  <p class="lede">${sentenceOf(v)}</p>
  ${v.empty ? '' : html`${moved(v)}${waiting(v, o.back)}${quiet(v, o.back)}${decided(v)}${growth(v, o)}${safety(v)}${behind(v)}`}
  ${tidyLine(v)}
  ${v.kind === 'now' && o.latest ? latestChanges(o.latest) : ''}
  ${v.kind === 'last' && o.monday?.show ? html`<form method="post" action="/review/${v.monday}/open"><button type="submit" class="secondary">${t('review.doneReading')}</button></form>` : ''}
  ${footer(v)}
</div>`;
}

/** Before the first week has ended. */
export function noWeekYetView(): SafeHtml {
  return html`<div class="review">
  <div class="rv-head"><h1>${t('shell.nav.lastWeek')}</h1>${weekNav('last')}</div>
  <p class="lede">${t('review.noWeekYet')}</p>
  <p class="also"><a href="/review/now">${t('review.thisWeekSoFar')}</a></p>
</div>`;
}

/** All weeks, newest first: one line each, the week's own sentence. No unread marker. */
export function allWeeksView(rows: { monday: string; href: string; sentence: string | null; quiet: boolean }[]): SafeHtml {
  return html`<div class="review">
  <div class="rv-head"><h1>${t('review.allWeeks')}</h1><p class="meta">${t('review.all.meta')}</p>${weekNav(null)}</div>
  ${rows.length === 0 ? html`<p class="quiet">${t('review.all.none')}</p>` : html`<ul class="weeks">${rows.map((r) => html`<li><a class="wk" href="${r.href}">${weekRange(r.monday)}</a>${r.sentence === null
    ? html`<span class="ld q">${t('review.all.madeWhenOpened')}</span>`
    : html`<span class="ld${r.quiet ? ' q' : ''}">${r.sentence}</span>`}</li>`)}</ul>`}
</div>`;
}
