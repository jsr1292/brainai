import { errorBlock } from './dashboardViews.js';
import { html, type SafeHtml } from './html.js';
import { t } from '../i18n/core.js';
import { tHtml } from '../i18n/tHtml.js';
import type { InboxGroup, InboxItem, InboxModel } from './inboxModel.js';

/** The answer when a suggestion no longer waits (answered on another device in the meantime). */
export const alreadyAnswered = (): string => t('inbox.alreadyAnswered');

/** What the Inbox says when nothing waits (also the first line of the empty page). */
export const inboxEmpty = (): string => t('inbox.empty');

const row = (it: InboxItem, selected: boolean): SafeHtml =>
  html`<li><a class="ir${selected ? ' is-selected' : ''}" href="${it.href}"${selected ? html` aria-current="true"` : ''}><span class="ir-dot d-${it.kind}" aria-hidden="true"></span><span class="ir-txt"><span class="ir-t">${it.title}</span><span class="ir-s">${it.sub}</span></span></a></li>`;

const group = (g: InboxGroup, selectedKey: string | null): SafeHtml =>
  html`<section class="ig${g.kind === 'tidy' ? ' ig-quiet' : ''}"><h2 class="ig-h"><a href="${g.href}">${g.kind === 'tidy' ? t('inbox.group.quiet', { title: g.title, count: g.items.length }) : html`${g.title} · ${g.items.length}`}<span class="chev" aria-hidden="true"></span></a></h2><ul class="ig-list">${g.items.map((it) => row(it, it.key === selectedKey))}</ul></section>`;

/** "N things wait for you" under the list's heading. */
const waits = (n: number, tidy: number): string => {
  const needs = n === 0 ? t('inbox.waits.none') : t('inbox.waits', { count: n });
  return tidy === 0 ? needs : t('inbox.waits.tidy', { needs: needs, count: tidy });
};

/**
 * The Inbox: everything that waits for the owner, grouped with counts, in one list; the chosen item (or group) beside it
 * on the desktop. On the phone the list is a page of its own and a row opens the item's page (`explicit` says an item was
 * asked for: the stylesheet shows the pane, not the list, then; without it the list, not the pane).
 */
export function inboxView(v: { model: InboxModel; selectedKey: string | null; explicit: boolean; crumb: string; pos: string | null; pane: SafeHtml; notice?: string; error?: string; status?: SafeHtml | null}): SafeHtml {
  const head = html`${errorBlock(v.error)}${v.status ?? ''}${v.notice ? html`<p class="notice" role="status">${v.notice}</p>` : ''}`;
  if (v.model.items.length === 0) {
    return html`<div class="narrow approvals inbox-empty"><h1>${t('shell.nav.inbox')}</h1>${head}<p class="quiet">${inboxEmpty()} ${t('inbox.emptyAbout')}</p></div>`;
  }
  // The status, notice and error line is the frame's first child, so it shows on the phone too (the pane is hidden there until an item is open).
  return html`<div class="inbox${v.explicit ? ' has-item' : ''}">
${head.value.trim() === '' ? '' : html`<div class="inbox-head">${head}</div>`}
<nav class="inbox-list" aria-label="${t('shell.nav.inbox')}"><h1>${t('shell.nav.inbox')}</h1><p class="il-sub">${waits(v.model.total, v.model.tidyCount)}</p>${v.model.groups.map((g) => group(g, v.selectedKey))}</nav>
<section class="inbox-pane" aria-label="${v.crumb}"><div class="inbox-bar"><a class="inbox-back" href="/approvals">${t('inbox.back')}</a><span class="inbox-crumb">${tHtml('inbox.crumb', { crumb: html`<b>${v.crumb}</b>` })}</span>${v.pos ? html`<span class="inbox-pos">${v.pos}</span>` : ''}</div>
${v.pane}</section>
</div>`;
}
