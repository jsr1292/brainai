/** Review › Pictures no current page shows, and Delete for good (round 2 section 12). Owner only. */
import { Router, type Response } from 'express';
import type { AppDeps } from './app.js';
import { requireOwner } from './authRoutes.js';
import { html, page, type SafeHtml } from './html.js';
import { pictureDeleteView, pictureReviewView, type PictureCard } from './pictureReviewViews.js';
import type { StoredImage } from '../images/store.js';

export function pictureReviewRoutes(d: AppDeps): Router {
  const router = Router();
  const owner = requireOwner(d.sessions);
  const send = (res: Response, status: number, title: string, body: SafeHtml, back: { href: string; label: string }) =>
    res.status(status).type('html').send(page(title, body, { nav: true, tab: null, back }));
  const missing = (res: Response) => res.status(404).type('html').send(page('Not found', html`<h1>Not found</h1><p>No such picture, or it was already deleted for good.</p>`, { tab: null }));
  const card = (img: StoredImage): PictureCard => {
    // The page it was added to, or else the first page whose history shows it (the editor uploads before a save).
    const pageId = img.pageId ?? d.pages.firstPageShowing(img.id);
    const p = pageId ? d.pages.get(pageId) : undefined;
    return { img, page: p, versions: p ? d.pages.versionsShowing(p.id, img.id) : [] };
  };

  router.get('/settings/pictures', owner, (req, res) => {
    send(res, 200, 'Pictures no current page shows', pictureReviewView(d.images.unused().map(card), req.query.deleted === '1'), { href: '/settings#health', label: 'Settings' });
  });

  router.get('/settings/pictures/:id/delete', owner, (req, res) => {
    const img = d.images.get(req.params.id as string);
    if (!img || img.removedAt !== null) return missing(res);
    send(res, 200, 'Delete this picture for good?', pictureDeleteView(card(img), d.now()), { href: '/settings/pictures', label: 'Pictures' });
  });

  router.post('/settings/pictures/:id/delete', owner, (req, res) => {
    const outcome = d.images.deleteForGood(req.params.id as string, 'owner');
    if (outcome === 'gone') return missing(res);
    if (outcome === 'shown') {
      return send(res, 409, 'Still on a page', html`<h1>Still on a page</h1><p>A page shows this picture again, so it was kept. <a href="/settings/pictures">Back to the pictures</a></p>`, { href: '/settings/pictures', label: 'Pictures' });
    }
    res.redirect(303, '/settings/pictures?deleted=1');
  });
  return router;
}
