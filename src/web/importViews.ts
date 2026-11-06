import type { ImportRow } from '../pages/importLog.js';
import type { Page } from '../pages/types.js';
import { html, type SafeHtml } from './html.js';
import { metaLine } from './metaLine.js';
import { timeAgo } from './when.js';

/** Every moved document, with its page and whether the owner checked it. */
export function importListView(rows: ImportRow[], pages: Map<string, Page>, notMoved: ImportRow[] = []): SafeHtml {
  return html`<div class="narrow">
<h1>Moved from Outline</h1>
<p class="lede">Each Outline document and the page it became. Open Compare to read the original next to the page, then press Looks right.</p>
<ul class="rows moved-list">${rows.map((r) => {
    const p = r.pageId ? pages.get(r.pageId) : undefined;
    return html`<li><span class="quiet">${r.collection}</span>
  ${p && p.deletedAt === null ? html`<a href="/pages/${p.id}">${p.title}</a>` : html`<span>${r.title} <span class="quiet">(page deleted)</span></span>`}
  <span class="${r.checkedAt ? 'ok' : 'quiet'}">${r.checkedAt ? 'checked' : 'not checked yet'}</span>
  <a href="/pages/moved/${encodeURIComponent(r.outlineId)}">Compare</a></li>`;
  })}</ul>
${notMoved.length > 0 ? html`<section class="panel notmoved"><h2>Not moved</h2><p class="meta">These Outline documents are not in the brain yet. Fix the reason, export again and run the import again.</p>
<ul class="rows">${notMoved.map((r) => html`<li><strong>${r.title}</strong> <span class="quiet">${r.collection} · ${r.status}</span><p>${r.reason ?? ''}</p></li>`)}</ul></section>` : ''}</div>`;
}

/** The original Markdown next to the page it became. */
export function importCompareView(r: ImportRow, page: Page | undefined, rendered: SafeHtml): SafeHtml {
  return html`<div class="narrow">
<h1>${r.title}</h1>
${metaLine([r.collection, html`last edited in Outline ${timeAgo(r.outlineUpdatedAt)}`, r.checkedAt ? 'checked' : null])}
<div class="compare">
  <section class="panel"><h2>In Outline</h2><pre class="original">${r.original}</pre></section>
  <section class="panel"><h2>In the brain${page ? html` · <a href="/pages/${page.id}">open the page</a> · <a href="/pages/${page.id}/edit">edit</a>` : ''}</h2>
    ${page ? html`<div class="art moved">${rendered}</div>` : html`<p class="quiet">The page was deleted.</p>`}</section>
</div>
<div class="actions"><form method="post" action="/pages/moved/${encodeURIComponent(r.outlineId)}/check"><button type="submit">Looks right</button></form></div></div>`;
}
