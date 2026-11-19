/** Review › Pictures no current page shows, and Delete for good (round 2 section 12). Owner only. */
import { Router, type Response } from 'express';
import type { AppDeps } from './app.js';
import { requireOwner } from './authRoutes.js';
import { t } from '../i18n/core.js';
import { tHtml } from '../i18n/tHtml.js';
import type { Key } from '../i18n/core.js';
import { html, page, type SafeHtml } from './html.js';
import { pictureDeleteView, pictureReviewView, type PictureCard } from './pictureReviewViews.js';
import type { StoredImage } from '../images/store.js';

export function pictureReviewRoutes(d: AppDeps): Router {
  const router = Router();
  const owner = requireOwner(d.sessions);
  const send = (res: Response, status: number, title: string, body: SafeHtml, back: { href: string; labelKey: Key }) =>
    res.status(status).type('html').send(page(title, body, { nav: true, tab: null, back }));
  const missing = (res: Response) => res.status(404).type('html').send(page(t('common.notFound'), html`<h1>${t('common.notFound')}</h1><p>${t('settings.pic.missing')}</p>`, { tab: null }));
  const card = (img: StoredImage): PictureCard => {
    // The page it was added to, or else the first page whose history shows it (the editor uploads before a save).
    const pageId = img.pageId ?? d.pages.firstPageShowing(img.id);
    const p = pageId ? d.pages.get(pageId) : undefined;
    return { img, page: p, versions: p ? d.pages.versionsShowing(p.id, img.id) : [] };
  };

  router.get('/settings/pictures', owner, (req, res) => {
    send(res, 200, t('settings.pic.title'), pictureReviewView(d.images.unused().map(card), req.query.deleted === '1'), { href: '/settings#health', labelKey: 'shell.nav.settings' });
  });

  router.get('/settings/pictures/:id/delete', owner, (req, res) => {
    const img = d.images.get(req.params.id as string);
    if (!img || img.removedAt !== null) return missing(res);
    send(res, 200, t('settings.pic.deleteTitle'), pictureDeleteView(card(img), d.now()), { href: '/settings/pictures', labelKey: 'settings.pic.back' });
  });

  router.post('/settings/pictures/:id/delete', owner, (req, res) => {
    const outcome = d.images.deleteForGood(req.params.id as string, 'owner');
    if (outcome === 'gone') return missing(res);
    if (outcome === 'shown') {
      return send(res, 409, t('settings.pic.stillTitle'), html`<h1>${t('settings.pic.stillTitle')}</h1><p>${tHtml('settings.pic.still', { link: html`<a href="/settings/pictures">${t('settings.pic.backTo')}</a>` })}</p>`, { href: '/settings/pictures', labelKey: 'settings.pic.back' });
    }
    res.redirect(303, '/settings/pictures?deleted=1');
  });
  return router;
}
