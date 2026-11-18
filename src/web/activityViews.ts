import { ACTIVITY_PAGE_SIZE, type AssistantActivity } from '../memory/assistantActivity.js';
import { dayWithWeekday, localDay, shortDay, timeOfDay } from '../timezone.js';
import { excerpt, writer, writerKey } from './dashboardViews.js';
import { html, type SafeHtml } from './html.js';
import { metaLine } from './metaLine.js';
import { weekNav } from './subnav.js';
import type { PageEditSummary } from './pageEditSummary.js';

/** What the owner is told after Undo, by the kind of row. */
export const UNDONE_SAID: Record<string, string> = {
  saved: 'Undone: the fact the assistant saved is deleted. You can restore it from its page.',
  updated: 'Undone: the fact is back to what it said before that change.',
  deleted: 'Undone: the fact is restored.',
  replaced: 'Undone: the older fact is back.',
};

/** Said when the fact changed after the row Undo was pressed on: nothing is touched. */
export const CHANGED_SINCE = 'Not undone: that fact changed after this, so it was left as it is.';
export const ALREADY_BACK = 'Not undone: the older fact was already brought back.';

/** "Today", "Yesterday", or "Thursday 12 Nov", on the owner's calendar. */
export function dayHeading(iso: string, now: Date): string {
  const day = localDay(new Date(iso));
  if (day === localDay(now)) return 'Today';
  if (day === localDay(new Date(now.getTime() - 86_400_000))) return 'Yesterday';
  return `${dayWithWeekday(iso)}${localDay(new Date(iso)).slice(0, 4) === localDay(now).slice(0, 4) ? '' : ` ${shortDay(iso, now).split(' ').pop()}`}`;
}

/** A feed row with what the route worked out for it: why Undo is not offered, and what a page edit changed. */
export type ActivityRowView = AssistantActivity & { why?: string | null; edit?: PageEditSummary | null; renamedFrom?: string | null };

const VERB: Record<AssistantActivity['kind'], string> = { saved: 'saved', updated: 'changed', deleted: 'deleted', replaced: 'replaced', page: 'edited a page' };

function undoForm(a: AssistantActivity, keep: { by?: string; page: number }): SafeHtml {
  const ref = a.kind === 'saved' ? a.memoryId : a.kind === 'replaced' ? a.supersessionId : a.historyId;
  return html`<form method="post" action="/activity/undo" class="actions act-undo"><input type="hidden" name="kind" value="${a.kind}"><input type="hidden" name="ref" value="${String(ref)}">${keep.by ? html`<input type="hidden" name="by" value="${keep.by}">` : ''}<input type="hidden" name="page" value="${String(keep.page)}"><button type="submit" class="secondary">Undo<span class="visually-hidden"> this ${a.kind === 'saved' ? 'save' : a.kind === 'updated' ? 'change' : a.kind === 'deleted' ? 'deletion' : 'replacement'} by ${a.by}</span></button></form>`;
}

/** A sentence end after a quoted line, unless it already ends in punctuation. */
const stop = (t: string): string => (/[.!?…]$/.test(t) ? t : `${t}.`);

function body(a: ActivityRowView): SafeHtml {
  if (a.kind === 'page') {
    const made = a.pageVersion === 1;
    const e = a.edit;
    const what = made ? 'Created the page.' : a.renamedFrom ? html`Renamed it from “${a.renamedFrom}”.`
      : e ? (e.heading ? html`Edited “${e.heading}”${e.line ? html`: ${stop(e.line)}` : '.'}` : e.line ? html`Edited: ${stop(e.line)}` : html`Edited the page.`)
      : html`Saved version ${a.pageVersion}.`;
    return html`<a class="card-link" href="/pages/${a.pageId!}">${a.pageTitle || 'A page'}</a>
  <p class="act-note">${what}${made ? '' : html` <a href="/pages/${a.pageId!}/history">Page history</a> has the earlier versions to restore.`}</p>`;
  }
  const link = (text: string) => html`<a class="card-link" href="/memories/${a.memoryId!}">${excerpt(text)}</a>`;
  if (a.kind === 'updated') {
    return html`<p class="card-link act-change"><span class="meta">${excerpt(a.content)}</span> <span aria-hidden="true">→</span><span class="visually-hidden"> became </span> <a href="/memories/${a.memoryId!}">${excerpt(a.after ?? '')}</a></p>`;
  }
  if (a.kind === 'replaced') return html`${link(a.content)}<p class="act-note">Replaced by <a href="/memories/${a.newId!}">a newer fact</a>. It left search but stays readable.</p>`;
  return link(a.content);
}

function row(a: ActivityRowView, keep: { by?: string; page: number }): SafeHtml {
  const stale = a.kind !== 'page' && !a.undoable;
  return html`<li class="entry w-${writerKey(a.by)}">
  ${metaLine([html`${writer(a.by)} <span class="verb">${VERB[a.kind]}</span>`, timeOfDay(a.at)])}
  ${body(a)}
  ${a.kind === 'page' ? '' : a.undoable ? undoForm(a, keep) : stale ? html`<p class="act-note">Can't be undone here: ${(a.why ?? 'Changed since').toLowerCase()}.</p>` : ''}
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
    ? html`<nav class="act-filter" aria-label="Assistant">${[{ href: '/activity', text: 'All' }, ...v.assistants.map((n) => ({ href: query(n, 1), text: n }))].map((i) => html`<a href="${i.href}"${i.href === (v.by === undefined ? '/activity' : query(v.by, 1)) ? html` aria-current="page"` : ''}>${i.text}</a>`)}</nav>`
    : '';
  const none = v.by !== undefined ? html`<p class="quiet">${v.by} has not saved or changed anything${v.page > 1 ? ' on this page' : ''}.</p>` : html`<p class="quiet">Nothing yet. What your assistants save or change shows up here, newest first.</p>`;
  return html`<div class="narrow"><div class="rv-head">
  <h1>Activity</h1>
  <p class="meta">What your assistants saved or changed${v.by ? html`: ${v.by} only` : ''}. Your own edits are not listed.</p>
  ${weekNav('activity')}
</div>
${v.error ? html`<p class="error" role="alert">${v.error}${v.factId ? html` <a href="/memories/${v.factId}">Open the fact</a> to see what it says now.` : ''}</p>` : ''}${v.said ? html`<p class="notice" role="status">${v.said}</p>` : ''}
${filter}
${v.rows.length === 0 ? none : days.map((d) => html`<section class="panel act-day">
  <div class="panel-head"><h2>${d.heading}</h2></div>
  <ul class="rows">${d.rows.map((r) => row(r, keep))}</ul>
</section>`)}
${v.page > 1 || v.more ? html`<p class="act-pages">${v.page > 1 ? html`<a href="${query(v.by, v.page - 1)}">Newer</a>` : ''}${v.page > 1 && v.more ? ' · ' : ''}${v.more ? html`<a href="${query(v.by, v.page + 1)}">Older</a>` : ''}</p>` : ''}
</div>`;
}

export { ACTIVITY_PAGE_SIZE };
