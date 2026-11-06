/**
 * Review › Pictures no current page shows (round 2 section 12). Pictures are never deleted automatically (History and
 * Restore depend on them); here the owner deletes one for good, after a confirmation that says exactly what happens.
 */
import type { StoredImage } from '../images/store.js';
import type { Page } from '../pages/types.js';
import { html, type SafeHtml } from './html.js';

export interface PictureCard {
  img: StoredImage;
  /** The page it was first added to: live, deleted, or none. */
  page: Page | undefined;
  /** The page's versions that show it, oldest first. */
  versions: number[];
}

const sizeText = (bytes: number) => (bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / 1048576).toFixed(1)} MB`);
const who = (by: string) => (by === 'owner' ? 'you' : by);
const DAY = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });

/** "versions 3 to 5", "version 3"; the versions are consecutive or not, so the first and last are named. */
export function versionRange(vs: number[]): string {
  if (vs.length === 0) return '';
  return vs.length === 1 ? `version ${vs[0]}` : `versions ${vs[0]} to ${vs[vs.length - 1]}`;
}

const thumb = (img: StoredImage) => html`<img class="pr-thumb" src="/images/${img.id}.${img.ext}" alt="" width="${img.width}" height="${img.height}" loading="lazy" decoding="async">`;

function where(c: PictureCard): SafeHtml {
  if (!c.page) return html`no page`;
  if (c.page.deletedAt !== null) return html`a deleted page`;
  return html`<a href="/pages/${c.page.id}">${c.page.title}</a>`;
}

export function pictureReviewView(cards: PictureCard[], deleted: boolean): SafeHtml {
  return html`<div class="narrow">
<h1>Pictures no current page shows</h1>
<p class="lede">Pictures stay until you delete them for good: History and Restore can bring an old version back with its pictures.</p>
${deleted ? html`<p class="notice" role="status">Deleted for good.</p>` : ''}
${cards.length === 0 ? html`<p class="quiet">Every picture is on a current page.</p>` : html`<ul class="group pr-list">${cards.map((c) => {
    const last = c.versions.length > 0 ? c.versions[c.versions.length - 1]! : null;
    return html`<li class="pr-card">${thumb(c.img)}<div class="pr-body">
  <p class="pr-alt">${c.img.alt || 'No description'}</p>
  <p class="meta"><span>On ${where(c)}${last !== null && c.page ? html` · removed in version ${last + 1}` : ''}${c.versions.length > 0 ? html` · ${versionRange(c.versions)} still use it` : ''}</span></p>
  <p class="meta">Added by ${who(c.img.createdBy)} · ${sizeText(c.img.bytes)}</p>
  <a class="pr-delete" href="/settings/pictures/${c.img.id}/delete">Delete for good…</a>
</div></li>`;
  })}</ul>`}
</div>`;
}

export function pictureDeleteView(c: PictureCard, now: Date): SafeHtml {
  const range = versionRange(c.versions);
  return html`<div class="narrow">
<h1>Delete this picture for good?</h1>
<div class="pr-confirm">${thumb(c.img)}<p class="pr-alt">${c.img.alt || 'No description'}</p></div>
<ul class="pr-what">
  <li>It disappears from the brain now, and from any phone's offline copy at its next update.</li>
  ${range ? html`<li>${range.charAt(0).toUpperCase()}${range.slice(1)} of the page show "This picture was deleted on ${DAY.format(now)}" in its place, and their text stays.</li>` : ''}
  <li>The nightly backup copies drop it within 30 days and the off-site copy within 90 days.</li>
  <li>The git export never had it.</li>
</ul>
<div class="pr-actions"><a class="button secondary" href="/settings/pictures">Keep it</a><form method="post" action="/settings/pictures/${c.img.id}/delete"><button type="submit" class="danger">Delete for good</button></form></div>
</div>`;
}
