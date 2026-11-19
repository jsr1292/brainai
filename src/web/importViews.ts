import type { ImportRow } from '../pages/importLog.js';
import type { Page } from '../pages/types.js';
import { t } from '../i18n/core.js';
import { tHtml } from '../i18n/tHtml.js';
import { html, type SafeHtml } from './html.js';
import { metaLine } from './metaLine.js';
import { timeAgo } from './when.js';

/** Every moved document, with its page and whether the owner checked it. */
export function importListView(rows: ImportRow[], pages: Map<string, Page>, notMoved: ImportRow[] = []): SafeHtml {
  return html`<div class="narrow">
<h1>${t('data.moved.title')}</h1>
<p class="lede">${t('data.moved.lede')}</p>
<ul class="rows moved-list">${rows.map((r) => {
    const p = r.pageId ? pages.get(r.pageId) : undefined;
    return html`<li><span class="quiet">${r.collection}</span>
  ${p && p.deletedAt === null ? html`<a href="/pages/${p.id}">${p.title}</a>` : html`<span>${r.title} <span class="quiet">${t('data.moved.pageDeleted')}</span></span>`}
  <span class="${r.checkedAt ? 'ok' : 'quiet'}">${r.checkedAt ? t('data.moved.checked') : t('data.moved.notChecked')}</span>
  <a href="/pages/moved/${encodeURIComponent(r.outlineId)}">${t('data.moved.compare')}</a></li>`;
  })}</ul>
${notMoved.length > 0 ? html`<section class="panel notmoved"><h2>${t('data.moved.notMoved')}</h2><p class="meta">${t('data.moved.notMovedNote')}</p>
<ul class="rows">${notMoved.map((r) => html`<li><strong>${r.title}</strong> <span class="quiet">${r.collection} · ${r.status === 'refused' ? t('data.moved.refused') : r.status === 'conflict' ? t('data.moved.conflict') : r.status}</span><p>${r.reason ?? ''}</p></li>`)}</ul></section>` : ''}</div>`;
}

/** The original Markdown next to the page it became. */
export function importCompareView(r: ImportRow, page: Page | undefined, rendered: SafeHtml): SafeHtml {
  return html`<div class="narrow">
<h1>${r.title}</h1>
${metaLine([r.collection, tHtml('data.moved.edited', { when: timeAgo(r.outlineUpdatedAt) }), r.checkedAt ? t('data.moved.checked') : null])}
<div class="compare">
  <section class="panel"><h2>${t('data.moved.inOutline')}</h2><pre class="original">${r.original}</pre></section>
  <section class="panel"><h2>${t('data.moved.inBrain')}${page ? html` · <a href="/pages/${page.id}">${t('data.moved.openPage')}</a> · <a href="/pages/${page.id}/edit">${t('data.moved.edit')}</a>` : ''}</h2>
    ${page ? html`<div class="art moved">${rendered}</div>` : html`<p class="quiet">${t('data.moved.wasDeleted')}</p>`}</section>
</div>
<div class="actions"><form method="post" action="/pages/moved/${encodeURIComponent(r.outlineId)}/check"><button type="submit">${t('data.moved.looksRight')}</button></form></div></div>`;
}
