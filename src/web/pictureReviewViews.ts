/**
 * Review › Pictures no current page shows (round 2 section 12). Pictures are never deleted automatically (History and
 * Restore depend on them); here the owner deletes one for good, after a confirmation that says exactly what happens.
 */
import type { StoredImage } from '../images/store.js';
import type { Page } from '../pages/types.js';
import { fmt } from '../i18n/fmt.js';
import { t } from '../i18n/core.js';
import { tHtml } from '../i18n/tHtml.js';
import { html, type SafeHtml } from './html.js';

export interface PictureCard {
  img: StoredImage;
  /** The page it was first added to: live, deleted, or none. */
  page: Page | undefined;
  /** The page's versions that show it, oldest first. */
  versions: number[];
}

const sizeText = (bytes: number) => fmt.size(bytes);
const who = (by: string) => (by === 'owner' ? t('settings.pic.you') : by);

/** "versions 3 to 5", "version 3"; the versions are consecutive or not, so the first and last are named. */
export function versionRange(vs: number[], capital = false): string {
  if (vs.length === 0) return '';
  const first = vs[0]!, last = vs[vs.length - 1]!;
  if (vs.length === 1) return t(capital ? 'settings.pic.versionCap' : 'settings.pic.version', { n: first });
  return t(capital ? 'settings.pic.versionsCap' : 'settings.pic.versions', { from: first, to: last });
}

const thumb = (img: StoredImage) => html`<img class="pr-thumb" src="/images/${img.id}.${img.ext}" alt="" width="${img.width}" height="${img.height}" loading="lazy" decoding="async">`;

function where(c: PictureCard): SafeHtml {
  if (!c.page) return html`${t('settings.pic.noPage')}`;
  if (c.page.deletedAt !== null) return html`${t('settings.pic.deletedPage')}`;
  return html`<a href="/pages/${c.page.id}">${c.page.title}</a>`;
}

export function pictureReviewView(cards: PictureCard[], deleted: boolean): SafeHtml {
  return html`<div class="narrow">
<h1>${t('settings.pic.title')}</h1>
<p class="lede">${t('settings.pic.lede')}</p>
${deleted ? html`<p class="notice" role="status">${t('settings.pic.deleted')}</p>` : ''}
${cards.length === 0 ? html`<p class="quiet">${t('settings.pic.allShown')}</p>` : html`<ul class="group pr-list">${cards.map((c) => {
    const last = c.versions.length > 0 ? c.versions[c.versions.length - 1]! : null;
    return html`<li class="pr-card">${thumb(c.img)}<div class="pr-body">
  <p class="pr-alt">${c.img.alt || t('settings.pic.noDescription')}</p>
  <p class="meta"><span>${tHtml('settings.pic.on', { where: where(c) })}${last !== null && c.page ? html` · ${t('settings.pic.removedIn', { n: last + 1 })}` : ''}${c.versions.length > 0 ? html` · ${tHtml('settings.pic.stillUse', { range: versionRange(c.versions) })}` : ''}</span></p>
  <p class="meta">${t('settings.pic.addedBy', { who: who(c.img.createdBy), size: sizeText(c.img.bytes) })}</p>
  <a class="pr-delete" href="/settings/pictures/${c.img.id}/delete">${t('settings.pic.delete')}</a>
</div></li>`;
  })}</ul>`}
</div>`;
}

export function pictureDeleteView(c: PictureCard, now: Date): SafeHtml {
  const range = versionRange(c.versions, true);
  return html`<div class="narrow">
<h1>${t('settings.pic.deleteTitle')}</h1>
<div class="pr-confirm">${thumb(c.img)}<p class="pr-alt">${c.img.alt || t('settings.pic.noDescription')}</p></div>
<ul class="pr-what">
  <li>${t('settings.pic.what1')}</li>
  ${range ? html`<li>${tHtml('settings.pic.what2', { range, date: fmt.date(now) })}</li>` : ''}
  <li>${t('settings.pic.what3')}</li>
  <li>${t('settings.pic.what4')}</li>
</ul>
<div class="pr-actions"><a class="button secondary" href="/settings/pictures">${t('settings.pic.keep')}</a><form method="post" action="/settings/pictures/${c.img.id}/delete"><button type="submit" class="danger">${t('settings.pic.deleteBtn')}</button></form></div>
</div>`;
}
