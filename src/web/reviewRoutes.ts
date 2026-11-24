import { Router, type Request, type Response } from 'express';
import { isRemoving } from '../desktop/removing.js';
import { shiftWeek, weekOf, weeklyDigest } from '../memory/digest.js';
import type { StoredReview } from '../review/types.js';
import type { AppDeps } from './app.js';
import { requireOwner } from './authRoutes.js';
import { backError, type BackTarget } from './back.js';
import { t } from '../i18n/index.js';
import { html, page, type Section } from './html.js';
import { LATEST_MAX, allWeeksView, noWeekYetView, reviewView, sentenceOf } from './reviewViews.js';

const MONDAY = /^\d{4}-\d{2}-\d{2}$/;

/** The weekly review pages (spec section 14). Every GET only reads; only the two POSTs mark a week. */
export function reviewRoutes(d: AppDeps): Router {
  const router = Router();
  const owner = requireOwner(d.sessions);
  const send = (res: Response, body: ReturnType<typeof html>, status = 200, back?: BackTarget, section?: Section) => res.status(status).type('html').send(page(t('review.title'), body, { nav: true, tab: 'week', section, back }));
  const notFound = (res: Response) => res.status(404).type('html').send(page(t('common.notFound'), html`<h1>${t('common.notFound')}</h1>`, { nav: true, tab: null }));
  const prevOf = (monday: string): string | null => {
    const earliest = d.reviews.earliestMonday();
    const prev = shiftWeek(monday, -1);
    return earliest !== null && prev >= earliest ? prev : null;
  };
  const showWeek = (req: Request, res: Response, r: StoredReview) => {
    const last = r.monday === d.reviews.lastMonday();
    if (last) r = d.reviews.withTidy(r);
    const view = d.reviews.present(r, last ? 'last' : 'older', { kind: 'owner' });
    // Last week's forms always return to /review, the one address it is kept under offline.
    send(res, reviewView(view, { error: backError(req.query.error), prev: prevOf(r.monday), next: last ? null : shiftWeek(r.monday, 1), back: last ? '/review' : null, monday: { show: last && !view.empty && r.openedAt === null && r.dismissedAt === null } }), 200, last ? undefined : { href: '/review/all', labelKey: 'review.allWeeks' }, last ? 'last' : undefined);
  };

  /** A week is stored only while the app is not being removed (a stored week would be a write after the copy). */
  const ensureWeek = (monday: string) => (isRemoving() ? d.reviews.preview(monday, 'owner') : d.reviews.ensure(monday, 'owner'));

  router.get('/review', owner, (req, res) => {
    const r = ensureWeek(d.reviews.lastMonday());
    if (!r) return send(res, noWeekYetView(), 200, undefined, 'last');
    showWeek(req, res, r);
  });

  router.get('/review/now', owner, (req, res) => {
    const view = d.reviews.present(d.reviews.soFar(), 'now', { kind: 'owner' });
    const week = weekOf(d.now());
    const digest = weeklyDigest(d.store, week, { grants: d.provider.listGrants(), waiting: d.service.pendingSuggestions().length });
    const notes = digest.flags.filter((f) => f.kind === 'no-saves' || f.kind === 'changed-others' || f.kind === 'no-project');
    const activity = d.store.recentActivity(LATEST_MAX).filter((a) => a.at >= week.start.toISOString() && a.at < week.end.toISOString());
    send(res, reviewView(view, { error: backError(req.query.error), prev: null, next: null, back: '/review/now', latest: { activity, notes } }), 200, undefined, 'now');
  });

  // Before /review/:date. Builds at most MAX_BUILDS_PER_LIST missing weeks per visit.
  router.get('/review/all', owner, (_req, res) => {
    const last = d.reviews.lastMonday();
    const rows = d.reviews.all('owner').map(({ monday, review }) => {
      const href = monday === last ? '/review' : `/review/${monday}`;
      if (!review) return { monday, href, sentence: null, quiet: false };
      const view = d.reviews.present(review, monday === last ? 'last' : 'older', { kind: 'owner' });
      return { monday, href, sentence: sentenceOf(view), quiet: view.empty };
    });
    send(res, allWeeksView(rows), 200, { href: '/review', labelKey: 'shell.nav.lastWeek' });
  });

  router.get('/review/:date', owner, (req, res) => {
    const date = req.params.date as string;
    const at = d.reviews.locate(date);
    if (at.to === 'none') return notFound(res);
    if (at.to === 'now') return res.redirect(302, '/review/now');
    if (at.redirect) return res.redirect(302, `/review/${at.monday}`);
    const r = ensureWeek(at.monday);
    if (!r) return notFound(res);
    showWeek(req, res, r);
  });

  router.post('/review/:monday/open', owner, (req, res) => {
    const monday = req.params.monday as string;
    if (!MONDAY.test(monday) || !d.reviews.open(monday)) return notFound(res);
    res.redirect(303, monday === d.reviews.lastMonday() ? '/review' : `/review/${monday}`);
  });

  router.post('/review/:monday/dismiss', owner, (req, res) => {
    const monday = req.params.monday as string;
    if (!MONDAY.test(monday) || !d.reviews.dismiss(monday)) return notFound(res);
    // Back home, where the card was: the page says it is hidden and offers Undo there.
    res.redirect(303, `/?weekHidden=${monday}`);
  });

  // Undo of Not now: the card shows again.
  router.post('/review/:monday/undismiss', owner, (req, res) => {
    const monday = req.params.monday as string;
    if (!MONDAY.test(monday) || monday !== d.reviews.lastMonday() || !d.reviews.undismiss(monday)) return notFound(res);
    res.redirect(303, '/');
  });

  return router;
}
