/**
 * The "For you" card on Projects: one grouped list, in the order approvals, facts that disagree (B1), discussions waiting on you, Last week,
 * suggestions. At most three rows show; the rest fold behind one closed row at the end ("3 suggestions", "2 more"),
 * so suggestions fold first and an approval never hides behind one. Only rows that need the owner carry the orange
 * dot; Last week a grey one; suggestions none. No black button: those are the screen's one loud thing elsewhere —
 * except the approval card, whose Approve is its own one loud thing (it opens in place under the row, a sheet on
 * the phone); two or more waiting become one row to /approvals.
 */
import type { FactMeta, Memory, Suggestion } from '../memory/types.js';
import type { HomeSuggestion } from '../projects/service.js';
import { suggestionCard, suggestionPhrase } from './dashboardViews.js';
import { disagreeRow } from './disagreeViews.js';
import { healthRow } from './healthViews.js';
import type { Health } from '../health/health.js';
import { html, type SafeHtml } from './html.js';
import { t, tHtml, tKey } from '../i18n/index.js';
import type { WeekLine } from './projectsViews.js';

export type ForYouKind = 'approval' | 'disagree' | 'discussion' | 'week' | 'health' | 'suggestion';
export interface ForYouRow { kind: ForYouKind; html: SafeHtml }
export interface ApprovalSummary {
  count: number;
  first: { by: string; kind: string; action: 'create' | 'update' | 'delete' } | null;
  /** The one waiting suggestion as a full card, set only when `count === 1`. */
  single?: { suggestion: Suggestion; current: string | undefined; currentMeta?: Memory; heldOutcome?: FactMeta; replaces: Memory[]; deleted?: Memory };
}

const SHOWN = 3;
const dot = (muted = false): SafeHtml => html`<span class="dot${muted ? ' muted' : ''}" aria-hidden="true"></span>`;
const chev = html`<span class="chev"></span>`;
const action = (name: string, what: string): string => `/projects/${encodeURIComponent(name)}/${what}`;

function approvalRow(a: ApprovalSummary): SafeHtml {
  if (a.count === 1 && a.single) {
    const s = a.single.suggestion;
    return html`<details class="fy-approval"><summary class="row">${dot()}<span class="txt">${tHtml('projects.foryou.suggests', { who: html`<b>${s.suggestedBy === 'owner' ? t('projects.you') : s.suggestedBy}</b>`, phrase: suggestionPhrase(s) })}</span>${chev}</summary>${suggestionCard(s, a.single.current, { back: '/', currentMeta: a.single.currentMeta, heldOutcome: a.single.heldOutcome, replaces: a.single.replaces, deleted: a.single.deleted })}</details>`;
  }
  return html`<a class="row" href="/approvals">${dot()}<span class="txt">${t('projects.foryou.changeWaits', { count: a.count })}</span>${chev}</a>`;
}

/** One discussion waiting on the owner is named and opens itself; two or more are one row to the list. */
const discussionRow = (waiting: { id: string; title: string }[]): SafeHtml => waiting.length === 1
  ? html`<a class="row" href="/discussions/${waiting[0]!.id}">${dot()}<span class="txt">${tHtml('projects.foryou.waitingOnYou', { title: html`<b>${waiting[0]!.title}</b>` })}</span>${chev}</a>`
  : html`<a class="row" href="/discussions">${dot()}<span class="txt">${t('projects.foryou.discussionsWait', { count: waiting.length })}</span>${chev}</a>`;

/** Last week: the row is the Read it form's button (no GET marks anything read), Not now its own small form. */
const weekRow = (w: WeekLine): SafeHtml => html`<div class="fy-week"><form method="post" action="/review/${w.monday}/open" class="fy-read"><button type="submit" class="row">${dot(true)}<span class="txt">${tHtml('projects.foryou.week', { label: html`<b>${t('projects.foryou.lastWeek')}</b>`, dates: w.dates, text: w.text })}</span></button></form><form method="post" action="/review/${w.monday}/dismiss" class="fy-not"><button type="submit" class="ghost sm">${t('projects.foryou.notNow')}</button></form></div>`;

/** A suggestion's sentence, worded here from the service's structured fields (`kind`, `state`, `weeks`); `text` stays the English one. */
function suggestionText(s: HomeSuggestion): SafeHtml {
  const bold = html`<b>${s.project}</b>`;
  if (s.kind === 'reopen-active') return tHtml('projects.foryou.sug.reopen', { name: bold, state: tKey(`projects.stateLower.${s.state}`) });
  if (s.kind === 'pin-late') return tHtml('projects.foryou.sug.pin', { name: bold });
  return tHtml('projects.foryou.sug.park', { name: bold, weeks: s.weeks ?? 0 });
}

function suggestionRow(s: HomeSuggestion): SafeHtml {
  const name = s.project;
  const text = suggestionText(s);
  const doIt = s.kind === 'pin-late' ? html`<form method="post" action="${action(name, 'pin')}"><button type="submit" class="sm">${t('projects.foryou.onTheGo')}</button></form>`
    : s.kind === 'park-quiet' ? html`<form method="post" action="${action(name, 'state')}"><input type="hidden" name="state" value="parked"><button type="submit" class="sm">${t('projects.act.park')}</button></form>`
    : html`<form method="post" action="${action(name, 'state')}"><input type="hidden" name="state" value="open"><button type="submit" class="sm">${t('projects.foryou.backToOpen')}</button></form>`;
  return html`<div class="row nolead fy-sug"><span class="txt">${text}</span><span class="acts">${doIt}<form method="post" action="${action(name, 'snooze')}"><button type="submit" class="ghost sm">${t('projects.foryou.notNow')}</button></form></span></div>`;
}

export function forYouRows(v: { approvals: ApprovalSummary; disagreements?: number; health?: Health; discussions: { id: string; title: string }[]; weekLine: WeekLine | null; suggestions: HomeSuggestion[] }): ForYouRow[] {
  const rows: ForYouRow[] = [];
  if (v.approvals.count > 0) rows.push({ kind: 'approval', html: approvalRow(v.approvals) });
  if ((v.disagreements ?? 0) > 0) rows.push({ kind: 'disagree', html: disagreeRow(v.disagreements!) });
  if (v.discussions.length > 0) rows.push({ kind: 'discussion', html: discussionRow(v.discussions) });
  if (v.weekLine) rows.push({ kind: 'week', html: weekRow(v.weekLine) });
  const health = healthRow(v.health);
  if (health) rows.push({ kind: 'health', html: health });
  for (const s of v.suggestions) rows.push({ kind: 'suggestion', html: suggestionRow(s) });
  return rows;
}

export function forYouCard(rows: ForYouRow[]): SafeHtml {
  if (rows.length === 0) return html``;
  // Suggestions never take a row of their own: they always fold behind one quiet "N suggestions" row (owner, 2026-11-04).
  const needs = rows.filter((r) => r.kind !== 'suggestion');
  const shown = needs.slice(0, SHOWN);
  const rest = [...needs.slice(SHOWN), ...rows.filter((r) => r.kind === 'suggestion')];
  const label = rest.every((r) => r.kind === 'suggestion') ? t('projects.foryou.suggestions', { count: rest.length }) : t('projects.foryou.more', { count: rest.length });
  const li = (r: ForYouRow) => html`<li>${r.html}</li>`;
  return html`<ul class="group foryou" aria-label="${t('projects.forYou')}">${shown.map(li)}${rest.length === 0 ? '' : html`<li><details class="fold fy-more"><summary class="row nolead">${label}${chev}</summary><ul class="fold-list">${rest.map(li)}</ul></details></li>`}</ul>`;
}
