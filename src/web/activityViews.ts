import { t, tHtml, tKey, type PlainKey } from '../i18n/index.js';
import { ACTIVITY_PAGE_SIZE, type AssistantActivity } from '../memory/assistantActivity.js';
import { dayWithWeekday, localDay, shortDay, timeOfDay } from '../timezone.js';
import { excerpt, writer, writerKey } from './dashboardViews.js';
import { html, type SafeHtml } from './html.js';
import { metaLine } from './metaLine.js';
import { weekNav } from './subnav.js';
import type { PageEditSummary } from './pageEditSummary.js';

/** What the owner is told after Undo, by the kind of row (catalog keys: read with `tKey` when the page is drawn). */
export const UNDONE_KEYS: Record<string, PlainKey> = {
  saved: 'activity.undone.saved',
  updated: 'activity.undone.updated',
  deleted: 'activity.undone.deleted',
  replaced: 'activity.undone.replaced',
};
export const undoneSaid = (code: string): string | undefined => (Object.hasOwn(UNDONE_KEYS, code) ? tKey(UNDONE_KEYS[code]!) : undefined);

/** Said when the fact changed after the row Undo was pressed on: nothing is touched. */
export const changedSince = (): string => t('activity.changedSince');
export const alreadyBack = (): string => t('activity.alreadyBack');

/** "Today", "Yesterday", or "Thursday 12 Nov", on the owner's calendar. */
export function dayHeading(iso: string, now: Date): string {
  const day = localDay(new Date(iso));
  if (day === localDay(now)) return t('activity.today');
  if (day === localDay(new Date(now.getTime() - 86_400_000))) return t('activity.yesterday');
  return `${dayWithWeekday(iso)}${localDay(new Date(iso)).slice(0, 4) === localDay(now).slice(0, 4) ? '' : ` ${shortDay(iso, now).split(' ').pop()}`}`;
}

/** A feed row with what the route worked out for it: why Undo is not offered, and what a page edit changed. */
export type ActivityRowView = AssistantActivity & { why?: string | null; whyCode?: 'undone' | 'deleted' | 'standsIn' | 'changed' | null; edit?: PageEditSummary | null; renamedFrom?: string | null };

const VERB: Record<AssistantActivity['kind'], PlainKey> = { saved: 'activity.verb.saved', updated: 'activity.verb.updated', deleted: 'activity.verb.deleted', replaced: 'activity.verb.replaced', page: 'activity.verb.page' };
const UNDO_WHAT = (kind: AssistantActivity['kind'], by: string): string => (kind === 'saved' ? t('activity.undoSave', { by }) : kind === 'updated' ? t('activity.undoChange', { by }) : kind === 'deleted' ? t('activity.undoDeletion', { by }) : t('activity.undoReplacement', { by }));

function undoForm(a: AssistantActivity, keep: { by?: string; page: number }): SafeHtml {
  const ref = a.kind === 'saved' ? a.memoryId : a.kind === 'replaced' ? a.supersessionId : a.historyId;
  return html`<form method="post" action="/activity/undo" class="actions act-undo"><input type="hidden" name="kind" value="${a.kind}"><input type="hidden" name="ref" value="${String(ref)}">${keep.by ? html`<input type="hidden" name="by" value="${keep.by}">` : ''}<input type="hidden" name="page" value="${String(keep.page)}"><button type="submit" class="secondary">${t('activity.undo')}<span class="visually-hidden"> ${UNDO_WHAT(a.kind, a.by)}</span></button></form>`;
}

/** A sentence end after a quoted line, unless it already ends in punctuation. */
const stop = (s: string): string => (/[.!?…]$/.test(s) ? s : `${s}.`);

function body(a: ActivityRowView): SafeHtml {
  if (a.kind === 'page') {
    const made = a.pageVersion === 1;
    const e = a.edit;
    const what = made ? t('activity.page.created') : a.renamedFrom ? t('activity.page.renamed', { old: a.renamedFrom })
      : e ? (e.heading ? (e.line ? t('activity.page.editedHeadingLine', { heading: e.heading, line: stop(e.line) }) : t('activity.page.editedHeading', { heading: e.heading })) : e.line ? t('activity.page.editedLine', { line: stop(e.line) }) : t('activity.page.edited'))
      : t('activity.page.saved', { version: a.pageVersion ?? 0 });
    return html`<a class="card-link" href="/pages/${a.pageId!}">${a.pageTitle || t('activity.page.a')}</a>
  <p class="act-note">${what}${made ? '' : html` ${tHtml('activity.page.history', { link: html`<a href="/pages/${a.pageId!}/history">${t('activity.page.historyLink')}</a>` })}`}</p>`;
  }
  const link = (text: string) => html`<a class="card-link" href="/memories/${a.memoryId!}">${excerpt(text)}</a>`;
  if (a.kind === 'updated') {
    return html`<p class="card-link act-change"><span class="meta">${excerpt(a.content)}</span> <span aria-hidden="true">→</span><span class="visually-hidden"> ${t('activity.became')} </span> <a href="/memories/${a.memoryId!}">${excerpt(a.after ?? '')}</a></p>`;
  }
  if (a.kind === 'replaced') return html`${link(a.content)}<p class="act-note">${tHtml('activity.replacedBy', { link: html`<a href="/memories/${a.newId!}">${t('activity.newerFact')}</a>` })}</p>`;
  return link(a.content);
}

function row(a: ActivityRowView, keep: { by?: string; page: number }): SafeHtml {
  const stale = a.kind !== 'page' && !a.undoable;
  return html`<li class="entry w-${writerKey(a.by)}">
  ${metaLine([html`${writer(a.by)} <span class="verb">${tKey(VERB[a.kind])}</span>`, timeOfDay(a.at)])}
  ${body(a)}
  ${a.kind === 'page' ? '' : a.undoable ? undoForm(a, keep) : stale ? html`<p class="act-note">${t('activity.cantUndo', { why: (a.whyCode ? tKey(`activity.why.${a.whyCode}`) : t('activity.changedSinceShort')).toLowerCase() })}</p>` : ''}
</li>`;
}

/** Activity: what each assistant saved or changed, newest first by day, filterable by assistant, with Undo. */
export function activityView(v: { rows: ActivityRowView[]; more: boolean; assistants: string[]; by?: string; page: number; now: Date; said?: string; error?: string; /** After a refused Undo: the fact it was about, to link to. */ factId?: string }): SafeHtml {
  const query = (by: string | undefined, page: number) => `/activity${by || page > 1 ? `?${[by ? `by=${encodeURIComponent(by)}` : '', page > 1 ? `page=${page}` : ''].filter(Boolean).join('&')}` : ''}`;
  const days: { heading: string; rows: ActivityRowView[] }[] = [];
  for (const r of v.rows) {
    const heading = dayHeading(r.at, v.now);
    const last = days[days.length - 1];
    if (last && last.heading === heading) last.rows.push(r); else days.push({ heading, rows: [r] });
  }
  const keep = { by: v.by, page: v.page };
  const filter = v.assistants.length > 1 || v.by !== undefined
    ? html`<nav class="act-filter" aria-label="${t('activity.assistant')}">${[{ href: '/activity', text: t('activity.all') }, ...v.assistants.map((n) => ({ href: query(n, 1), text: n }))].map((i) => html`<a href="${i.href}"${i.href === (v.by === undefined ? '/activity' : query(v.by, 1)) ? html` aria-current="page"` : ''}>${i.text}</a>`)}</nav>`
    : '';
  const none = v.by !== undefined ? html`<p class="quiet">${v.page > 1 ? t('activity.noneByPage', { by: v.by }) : t('activity.noneBy', { by: v.by })}</p>` : html`<p class="quiet">${t('activity.none')}</p>`;
  return html`<div class="narrow"><div class="rv-head">
  <h1>${t('shell.nav.activity')}</h1>
  <p class="meta">${v.by ? t('activity.metaBy', { by: v.by }) : t('activity.meta')}</p>
  ${weekNav('activity')}
</div>
${v.error ? html`<p class="error" role="alert">${v.error}${v.factId ? html` ${tHtml('activity.openFact', { link: html`<a href="/memories/${v.factId}">${t('activity.openFactLink')}</a>` })}` : ''}</p>` : ''}${v.said ? html`<p class="notice" role="status">${v.said}</p>` : ''}
${filter}
${v.rows.length === 0 ? none : days.map((d) => html`<section class="panel act-day">
  <div class="panel-head"><h2>${d.heading}</h2></div>
  <ul class="rows">${d.rows.map((r) => row(r, keep))}</ul>
</section>`)}
${v.page > 1 || v.more ? html`<p class="act-pages">${v.page > 1 ? html`<a href="${query(v.by, v.page - 1)}">${t('activity.newer')}</a>` : ''}${v.page > 1 && v.more ? ' · ' : ''}${v.more ? html`<a href="${query(v.by, v.page + 1)}">${t('activity.older')}</a>` : ''}</p>` : ''}
</div>`;
}

export { ACTIVITY_PAGE_SIZE };
