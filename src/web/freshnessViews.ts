import { LINKED_CHANGES, NEWER_DECISIONS, type Flag, type LinkedChange } from '../pages/freshness.js';
import { isKeyDecisions } from '../pages/markdown.js';
import type { StoredSection } from '../pages/store.js';
import type { Page, PageHeader } from '../pages/types.js';
import { localDay, shortDay } from '../timezone.js';
import { html, raw, type SafeHtml } from './html.js';
import { runWithLocale, t, tHtml, tKey } from '../i18n/index.js';
import { metaLine } from './metaLine.js';
import { viewNow } from './when.js';

/** How many reasons the page's line lists before "and N more". */
export const FLAG_SHOWN = 5;

const day = (iso: string) => shortDay(iso, viewNow());
const factsHref = (project: string) => `/facts?project=${encodeURIComponent(project)}&kind=decision`;

/** The linked-fact part of a reason: "a decision it links to was changed", "2 facts it links to were removed". */
function linkedPart(linked: LinkedChange[]): string | null {
  if (linked.length === 0) return null;
  if (linked.length === 1) return tKey(`pages.fresh.link.${linked[0]!.isDecision ? 'decision' : 'fact'}.${linked[0]!.why}`);
  const whys = new Set(linked.map((l) => l.why));
  return tKey(`pages.fresh.link.many.${whys.size === 1 ? [...whys][0]! : 'mixed'}`, { count: linked.length });
}

/** Why a page may be out of date, in parts: "3 newer decisions", "a decision it links to was changed". */
export function reasonParts(f: Flag): string[] {
  return [f.decisions.length > 0 ? t('pages.fresh.newer', { count: f.decisions.length }) : null, linkedPart(f.linked)].filter((x): x is string => x !== null);
}

/** The parts as one sentence: "3 newer decisions, and a decision it links to was changed." */
export function reasonSentence(f: Flag): SafeHtml {
  const parts = reasonParts(f);
  const s = parts.length === 2 ? tHtml('pages.fresh.and', { first: parts[0]!, second: parts[1]! }).value : html`${parts.join(', and ')}`.value;
  return raw(`${s.charAt(0).toUpperCase()}${s.slice(1)}.`);
}

/** The quiet chip where pages are listed. */
export const staleChip = (): SafeHtml => html`<span class="chip soon">${t('pages.fresh.chip')}</span>`;

/** "you checked it: still true, 3 Nov", for the meta line, while the page's last word is the owner's Still true. */
export const checkedMeta = (page: Page): string | null => (page.caughtUp.how === 'still_true' ? t('pages.fresh.checked', { day: day(page.caughtUp.at) }) : null);

/** The line after Still true, on the day it was tapped, with its one Undo. */
export function stillTrueLine(page: Page, today: string): SafeHtml {
  if (page.caughtUp.how !== 'still_true' || localDay(new Date(page.caughtUp.at)) !== today) return html``;
  const linked = LINKED_CHANGES === 1 ? t('pages.fresh.linkedOne') : t('pages.fresh.linkedMany', { count: LINKED_CHANGES });
  return html`<div class="checked-line" role="status"><span>${t('pages.fresh.stillTrue', { count: NEWER_DECISIONS, linked })}</span><form method="post" action="/pages/${page.id}/still-true/undo"><button type="submit" class="ghost">${t('pages.fresh.undo')}</button></form></div>`;
}

type Row = { at: string; kind: string; href: string; text: string };

/** The reasons as rows, newest first. */
function rows(f: Flag): Row[] {
  const decisions = f.decisions.map((d): Row => ({ at: d.at, kind: d.why === 'new' ? t('pages.fresh.kind.new') : t('pages.fresh.kind.changed'), href: `/memories/${d.id}`, text: d.text }));
  const linked = f.linked.map((l): Row => ({
    at: l.at, kind: l.why === 'changed' ? t('pages.fresh.kind.linkedChanged') : l.why === 'replaced' ? t('pages.fresh.kind.replaced') : t('pages.fresh.kind.removed'),
    href: `/memories/${l.why === 'replaced' && l.replacedBy ? l.replacedBy : l.id}`, text: l.text,
  }));
  return [...decisions, ...linked].sort((a, b) => b.at.localeCompare(a.at));
}

/**
 * The note form inside the line: the same notes route as the rail's "Ask an AI to update", already set to Key
 * decisions (the whole page when there is none) and filled in by the server.
 */
export type AskForm = (opts: { id: string; label: string; prefill: { section: string; text: string } }) => SafeHtml;

/**
 * The page's one closed line under the meta line (never open, at every width): why it may be out of date, the reasons
 * newest first (at most FLAG_SHOWN), then Still true and a note for the next assistant. With a note already open, it
 * says so and offers no actions.
 */
export function staleLine(v: { page: Page; flag: Flag; project: string | null; noteOpen: boolean; keyAnchor: string | null; sections: StoredSection[]; askForm: AskForm }): SafeHtml {
  const all = rows(v.flag);
  const rest = all.length - FLAG_SHOWN;
  const since = day(v.flag.since);
  const restRow = rest <= 0 ? '' : v.project !== null
    ? html`<li class="rest"><a href="${factsHref(v.project)}">${t('pages.fresh.and.more', { count: rest })}</a></li>`
    : html`<li class="rest">${t('pages.fresh.and.more', { count: rest })}</li>`;
  const list = html`<ul class="stale-list">${all.slice(0, FLAG_SHOWN).map((r) => html`<li><time datetime="${r.at}">${day(r.at)}</time><span><span class="stale-kind">${r.kind}</span> · <a href="${r.href}">${r.text}</a></span></li>`)}${restRow}</ul>`;
  const why = v.noteOpen ? t('pages.fresh.asked') : reasonSentence(v.flag);
  const who = v.project !== null ? t('pages.fresh.seeProject', { project: v.project }) : t('pages.fresh.seePage');
  const foot = v.noteOpen
    ? html`<p class="meta">${tHtml('pages.fresh.sinceNote', { since, link: html`<a href="#ai_notes">${t('pages.fresh.seeNote')}</a>` })}</p>`
    : html`<div class="stale-foot"><p class="meta">${t('pages.fresh.since', { since, who })}</p><form method="post" action="/pages/${v.page.id}/still-true"><button type="submit">${t('pages.fresh.stillTrueButton')}</button></form>
${v.askForm({ id: 'ask_ai_line', label: t('pages.fresh.askLabel'), prefill: { section: v.keyAnchor ?? '', text: noteForAssistant(v.page.caughtUp.at) } })}</div>`;
  return html`<details class="stale"><summary><span class="stale-dot" aria-hidden="true"></span><b>${t('pages.fresh.title')}</b><span class="stale-why">${why}</span><span class="more"><span class="show">${t('pages.fresh.show')}</span><span class="hide">${t('pages.fresh.hide')}</span></span></summary>
<div class="stale-body">${list}${foot}</div></details>`;
}

/** The page's Key decisions anchor, if it has one. */
export const keyAnchorOf = (sections: StoredSection[]): string | null => sections.find((s) => s.anchor !== 'top' && isKeyDecisions(s.heading))?.anchor ?? null;

/** How many decisions saved since follow Key decisions before "and N more". */
export const DECIDED_SHOWN = 5;

const writerName = (by: string) => (by === 'owner' ? t('pages.fresh.youLower') : by);

/** The note's prefilled text is for the next assistant, which reads English: it stays English (and its day too) in every language. */
const noteForAssistant = (caughtUpAt: string): string => runWithLocale('en', () => t('pages.fresh.askText', { day: day(caughtUpAt) }));

/**
 * The decisions saved since the page was last brought up to date, oldest first (at most DECIDED_SHOWN): dashed entries
 * after the timeline, or a small plain list after a Key decisions section that is not one. Drawn from the facts, never
 * written into the page.
 */
export function decidedSince(f: Flag, project: string | null, timeline: boolean): SafeHtml {
  const all = f.decisions.filter((d) => d.why === 'new').sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
  if (all.length === 0) return html``;
  const head = t('pages.fresh.decidedHead', { day: day(f.caughtUp.at) });
  const rest = all.length - DECIDED_SHOWN;
  const more = rest <= 0 ? '' : project !== null
    ? html`<li class="newer-more"><a href="${factsHref(project)}">${t('pages.fresh.and.more', { count: rest })}</a></li>`
    : html`<li class="newer-more">${t('pages.fresh.and.more', { count: rest })}</li>`;
  const entries = all.slice(0, DECIDED_SHOWN).map((d) => html`<li class="newer"><time datetime="${d.at}">${day(d.at)}</time><div>${d.text}<span class="from"><a href="/memories/${d.id}">${t('pages.fresh.factLink')}</a> · ${t('pages.fresh.savedBy', { who: writerName(d.by) })}</span></div></li>`);
  return timeline
    ? html`<li class="newer-head">${head}</li>${entries}${more}`
    : html`<div class="decided-since"><p class="meta">${head}</p><ul class="newer-list">${entries}${more}</ul></div>`;
}

/** The words for a replaced linked fact: "replaced 2 Nov". On a link with section 16's marker, that marker says this. */
export const replacedLabel = (c: LinkedChange): string => t('pages.fresh.replacedLabel', { day: day(c.at) });

/** The pill on a timeline item whose linked fact changed, was replaced (linking to the fact that holds now) or removed. */
export function factPill(c: LinkedChange): SafeHtml {
  if (c.why === 'replaced') return html` <a class="chip soon" href="/memories/${c.replacedBy ?? c.id}">${replacedLabel(c)}</a>`;
  return html` <span class="chip soon">${c.why === 'changed' ? t('pages.fresh.pillChanged') : t('pages.fresh.pillRemoved')} ${day(c.at)}</span>`;
}

/** Beside a section's heading: how many newer decisions are close to it in meaning, worded as a maybe. */
export const sectionHint = (n: number): SafeHtml => html` <span class="chip soon sec-hint">${t('pages.fresh.mayTouch', { count: n })}</span>`;

/** Beside Key decisions: how many decisions were saved since. */
export const savedSinceHint = (n: number): SafeHtml => html` <span class="chip soon sec-hint">${t('pages.fresh.savedSince', { count: n })}</span>`;

/** What the page view needs per section: hints by anchor, the count saved since, and the linked changes by fact id. */
export function sectionMarks(f: Flag | null): { near: Map<string, number>; savedSince: number; linked: Map<string, LinkedChange> } {
  const near = new Map<string, number>();
  for (const d of f?.decisions ?? []) if (d.nearSection !== null) near.set(d.nearSection, (near.get(d.nearSection) ?? 0) + 1);
  return { near, savedSince: f?.decisions.filter((d) => d.why === 'new').length ?? 0, linked: new Map((f?.linked ?? []).map((l) => [l.id, l])) };
}

/**
 * The Pages tab's fold of pages that may be out of date: the first row of the grouped card that also holds "Projects
 * without a page", closed. Each row: the page, why, since when, and whether an AI was asked. By since, then title.
 * Left out when no page is flagged; no cap, since this is the one place they gather.
 */
export function staleFold(rows: { page: PageHeader; flag: Flag; noteOpen: boolean }[]): SafeHtml {
  if (rows.length === 0) return html``;
  const sorted = [...rows].sort((a, b) => a.flag.since.localeCompare(b.flag.since) || a.page.title.localeCompare(b.page.title));
  return html`<li><details class="fold stale-fold"><summary class="row nolead">${t('pages.fresh.title')}<span class="n">${rows.length}</span><span class="chev"></span></summary>
<ul class="fold-list">${sorted.map((r) => html`<li><a class="row nolead" href="/pages/${r.page.id}"><span class="txt"><b>${r.page.title}</b>${metaLine([...reasonParts(r.flag), t('pages.fresh.sinceMeta', { day: day(r.flag.since) }), r.noteOpen ? t('pages.fresh.youAsked') : null])}</span><span class="chev"></span></a></li>`)}</ul></details></li>`;
}
