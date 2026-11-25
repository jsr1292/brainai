/** Settings › Save a copy of everything: where it goes (app), the authenticator code (server), and the result. */
import { t } from '../i18n/core.js';
import { tHtml } from '../i18n/tHtml.js';
import { html, type SafeHtml } from './html.js';

/** "3 facts and 1 page" in the request's language, as markup (each part is its own translated run). */
export const factsAndPagesText = (facts: number, pages: number): SafeHtml =>
  tHtml('data.factsAndPages', { facts: t('data.facts', { count: facts }), pages: t('data.pages', { count: pages }) });

/** "Finder" / "Explorer" are the names of the system's file apps: the same in every language. */

/**
 * The Documents-or-home choice. Documents that a cloud service keeps a copy of get a warning and the home folder first;
 * otherwise one button. Each button posts `where` to `action`.
 */
export function whereChoice(v: { documents: string; synced: 'iCloud' | 'OneDrive' | null; home: string; action: string; start?: boolean }): SafeHtml {
  // The Remove page's buttons say what they start, not just where the copy goes.
  const label = (plain: string, removing: string) => (v.start ? removing : plain);
  const startNote = v.start ? html`
<p class="meta">${t('data.where.toolsNext')}</p>` : '';
  if (v.synced === null) {
    return html`<p>${tHtml('data.where.documents', { path: html`<code class="path">${v.documents}</code>` })}</p>
<form method="post" action="${v.action}"><input type="hidden" name="where" value="documents"><button type="submit" class="primary">${label(t('data.where.saveDocs'), t('data.where.saveDocsRemove'))}</button></form>${startNote}`;
  }
  return html`<p class="notice">${t('data.where.synced', { service: v.synced })}</p>
<p>${tHtml('data.where.homeStays', { path: html`<code class="path">${v.home}</code>` })}</p>
<div class="row-actions">
<form method="post" action="${v.action}"><input type="hidden" name="where" value="home"><button type="submit" class="primary">${label(t('data.where.saveHome'), t('data.where.saveHomeRemove'))}</button></form>
<form method="post" action="${v.action}"><input type="hidden" name="where" value="documents"><button type="submit" class="secondary">${label(t('data.where.saveDocsAnyway'), t('data.where.saveDocsAnywayRemove'))}</button></form>
</div>${startNote}`;
}

export function savedPage(v: { documents: string; synced: 'iCloud' | 'OneDrive' | null; home: string; said: string | null }): SafeHtml {
  return html`<div class="narrow">
<h1>${t('data.saved.title')}</h1>
<p class="lede">${t('data.saved.lede')}</p>
${v.said ? html`<p class="notice" role="status">${v.said}</p>` : ''}
${whereChoice({ ...v, action: '/settings/save' })}
</div>`;
}

export function savedDone(v: { folder: string; facts: number; pages: number; revealIn: 'Finder' | 'Explorer' }): SafeHtml {
  return html`<div class="narrow">
<h1>${t('data.done.title')}</h1>
<p><span class="ok">${t('data.done.saved')}</span> ${tHtml('data.done.in', { summary: factsAndPagesText(v.facts, v.pages), folder: html`<code class="path">${v.folder}</code>` })}</p>
<p>${t('data.done.private')}</p>
<div class="row-actions">
<form method="post" action="/settings/save/show"><button type="submit" class="primary">${t('data.show', { app: v.revealIn })}</button></form>
<a class="secondary button" href="/settings">${t('data.backToSettings')}</a>
</div>
</div>`;
}

/** The server: the authenticator code first, as the login asks for it. */
export function savedCodePage(v: { error: string | null }): SafeHtml {
  return html`<div class="narrow">
<h1>${t('data.saved.title')}</h1>
<p class="lede">${t('data.saved.codeLede')}</p>
${v.error ? html`<p class="notice" role="alert">${v.error}</p>` : ''}
<form method="post" action="/settings/save" data-download>
<label>${t('data.saved.code')} <input name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]*" required autofocus></label>
<button type="submit" class="primary">${t('data.saved.download')}</button>
</form>
</div>`;
}
